// Minimal MCP stdio client: JSON-RPC 2.0 over child process stdin/stdout.
import { spawn } from 'node:child_process';

export class McpServer {
  constructor(cfg) {
    this.cfg = cfg;            // { id, name, command, args, env }
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();  // id -> {resolve, reject, timer}
    this.tools = [];
    this.buffer = '';
    this.dead = false;
  }

  async start() {
    if (this.proc && !this.dead) return this.tools;
    this.dead = false;
    const env = { ...process.env, ...parseEnv(this.cfg.env) };
    delete env.NODE_CHANNEL_FD; // avoid treating the child as a fork when we were spawned with IPC
    this.proc = spawn(this.cfg.command, this.cfg.args || [], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout.on('data', (d) => this._onData(d));
    this.proc.stderr.on('data', (d) => process.stderr.write(`[mcp:${this.cfg.name}] ${d}`));
    this.proc.on('exit', () => {
      this.dead = true;
      for (const p of this.pending.values()) p.reject(new Error('MCP server exited'));
      this.pending.clear();
    });
    const init = await this._rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'orionchatv3', version: '1.3.0' },
    }, 15000);
    this._notify('notifications/initialized', {});
    const res = await this._rpc('tools/list', {}, 15000);
    this.tools = (res.tools || []).map((t) => ({
      ...t,
      _mcp: this.cfg.id,
      _mcpName: this.cfg.name,
    }));
    return this.tools;
  }

  async callTool(name, args) {
    const res = await this._rpc('tools/call', { name, arguments: args }, 120000);
    if (res.isError) throw new Error('MCP tool error');
    return mcpResultToText(res);
  }

  // best-effort discovery of resources and prompts (both optional in MCP);
  // anything unsupported just comes back empty
  async extras() {
    const out = { resources: [], prompts: [] };
    try { out.resources = (await this._rpc('resources/list', {}, 10000)).resources || []; } catch {}
    try { out.prompts = (await this._rpc('prompts/list', {}, 10000)).prompts || []; } catch {}
    return out;
  }

  stop() {
    this.dead = true;
    if (this.proc) { try { this.proc.kill(); } catch {} }
  }

  _onData(chunk) {
    this.buffer += chunk.toString();
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message || 'MCP error'));
        else p.resolve(msg.result);
      }
    }
  }

  _rpc(method, params, timeoutMs) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  _notify(method, params) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }
}

function parseEnv(env) {
  const out = {};
  if (!env) return out;
  if (typeof env === 'object') return env;
  for (const line of String(env).split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

function mcpResultToText(res) {
  const parts = [];
  for (const c of res.content || []) {
    if (c.type === 'text') parts.push(c.text);
    else if (c.type === 'resource') parts.push(`[resource] ${c.resource?.text || c.resource?.uri || ''}`);
    else parts.push(JSON.stringify(c));
  }
  return parts.join('\n') || '(empty result)';
}

// Streamable HTTP transport: JSON-RPC 2.0 over HTTP POST (MCP "Streamable HTTP").
// Responses may come back as JSON or as an SSE stream; both are handled.
export class HttpMcp {
  constructor(cfg) {
    this.cfg = cfg; // { url, headers }
    this.session = null;
    this.tools = [];
    this.dead = false;
    this.nextId = 1;
  }

  async start() {
    this.dead = false;
    this.session = null;
    await this._rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'orionchatv3', version: '1.3.0' },
    });
    await this._notify('notifications/initialized', {});
    const res = await this._rpc('tools/list', {});
    this.tools = res.tools || [];
    return this.tools;
  }

  async callTool(name, args) {
    const res = await this._rpc('tools/call', { name, arguments: args });
    if (res.isError) throw new Error('MCP tool error');
    return mcpResultToText(res);
  }

  async extras() {
    const out = { resources: [], prompts: [] };
    try { out.resources = (await this._rpc('resources/list', {})).resources || []; } catch {}
    try { out.prompts = (await this._rpc('prompts/list', {})).prompts || []; } catch {}
    return out;
  }

  stop() { this.dead = true; }

  _headers() {
    return {
      ...parseHeaderLines(this.cfg.headers),
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(this.session ? { 'Mcp-Session-Id': this.session } : {}),
    };
  }

  async _post(message) {
    const res = await fetch(this.cfg.url, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(130000),
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.session = sid;
    if (res.status === 202) return null;
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('text/event-stream')) {
      const text = await res.text();
      for (const line of text.split('\n')) {
        if (!line.startsWith('data:')) continue;
        let msg;
        try { msg = JSON.parse(line.slice(5).trim()); } catch { continue; }
        if (message.id !== undefined && msg.id === message.id) {
          if (msg.error) throw new Error(msg.error.message || 'MCP error');
          return msg.result;
        }
      }
      return null; // notification-only stream
    }
    if (ct.includes('application/json')) {
      const msg = await res.json();
      if (msg.error) throw new Error(msg.error.message || 'MCP error');
      return msg.result;
    }
    return null;
  }

  async _rpc(method, params) {
    const result = await this._post({ jsonrpc: '2.0', id: this.nextId++, method, params });
    if (result === null || result === undefined) throw new Error(`MCP ${method}: empty response`);
    return result;
  }

  async _notify(method, params) {
    try { await this._post({ jsonrpc: '2.0', method, params }); } catch {}
  }
}

function parseHeaderLines(headers) {
  const out = {};
  if (!headers) return out;
  for (const line of String(headers).split('\n')) {
    const m = line.match(/^\s*([A-Za-z0-9_-]+)\s*[:=]\s*(.+)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
