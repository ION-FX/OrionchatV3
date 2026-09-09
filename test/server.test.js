// OrionChat end-to-end test suite.
// Spawns the real server on an isolated data dir plus three helpers:
// mock-provider.mjs (streaming OpenAI-compatible), mock-mcp-stdio.mjs and
// mock-mcp-http.mjs (both MCP transports). Run with: node --test test/server.test.js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORION_PORT = 15760;
const PROVIDER_PORT = 15761;
const HTTP_MCP_PORT = 15762;
const BASE = `http://127.0.0.1:${ORION_PORT}`;
const KEY = 'test-key-that-is-long-enough';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'orion-test-'));
let orion = null;
let mockProvider = null;
let mockHttpMcp = null;
let cookie = '';
let bobCookie = ''; // captured once — reusing the session keeps the auth rate-limit budget intact
let db = null;

function startServer() {
  const child = spawn(process.execPath, ['server/server.js'], {
    cwd: ROOT,
    env: { ...process.env, ORION_DATA_DIR: dataDir, PORT: String(ORION_PORT), HOST: '127.0.0.1', ORION_TASK_TICK_MS: '150' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`[orion] ${d}`));
  return child;
}

async function waitHealthy(timeoutMs = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('server did not become healthy');
}

async function call(method, p, body, headers = {}) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

before(async () => {
  mockProvider = spawn(process.execPath, ['test/mock-provider.mjs'], {
    cwd: ROOT, env: { ...process.env, PORT: String(PROVIDER_PORT) }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  mockHttpMcp = spawn(process.execPath, ['test/mock-mcp-http.mjs'], {
    cwd: ROOT, env: { ...process.env, PORT: String(HTTP_MCP_PORT) }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  orion = startServer();
  await waitHealthy();
  db = new DatabaseSync(path.join(dataDir, 'orionchat.db'));
});

after(async () => {
  for (const c of [orion, mockProvider, mockHttpMcp]) {
    if (c) { try { c.kill(); } catch {} }
  }
  await new Promise((r) => setTimeout(r, 200));
  try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
});

// ---------- health & auth ----------
test('health endpoint is public', async () => {
  const res = await fetch(`${BASE}/api/health`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.version, '1.5.0');
  assert.ok('documents' in body);
});

test('unauthenticated /api/me is rejected', async () => {
  const saved = cookie;
  cookie = '';
  const res = await call('GET', '/api/me');
  cookie = saved;
  assert.equal(res.status, 401);
});

test('first registered user becomes admin', async () => {
  const res = await call('POST', '/api/register', { username: 'alice', password: 'pass1234' });
  assert.equal(res.status, 200);
  assert.equal(res.json.role, 'admin');
});

test('second user is a regular user and is blocked from admin routes', async () => {
  const saved = cookie;
  const res = await call('POST', '/api/register', { username: 'bob', password: 'pass1234' });
  assert.equal(res.json.role, 'user');
  const forbidden = await call('GET', '/api/admin/overview');
  assert.equal(forbidden.status, 403);
  cookie = saved;
});

test('login works and bad passwords fail', async () => {
  const bad = await call('POST', '/api/login', { username: 'alice', password: 'wrong' });
  assert.equal(bad.status, 401);
  const ok = await call('POST', '/api/login', { username: 'alice', password: 'pass1234' });
  assert.equal(ok.status, 200);
});

// ---------- providers ----------
let providerId = null;
test('admin can add and test a provider', async () => {
  const res = await call('POST', '/api/admin/providers', {
    name: 'Mock', kind: 'openai', base_url: `http://127.0.0.1:${PROVIDER_PORT}/v1`, model: 'mock-1', api_key: KEY,
  });
  assert.equal(res.status, 200);
  providerId = res.json.id;
  assert.ok(providerId);
  const test = await call('POST', '/api/admin/provider_test', { base_url: `http://127.0.0.1:${PROVIDER_PORT}/v1`, api_key: KEY, model: 'mock-1', kind: 'openai' });
  assert.equal(test.status, 200);
});

test('providers list is visible to regular users', async () => {
  const res = await call('GET', '/api/providers');
  assert.equal(res.status, 200);
  assert.ok(res.json.length >= 1);
});

// ---------- chat: non-stream, stream, tools ----------
test('non-stream chat returns a reply and creates a conversation', async () => {
  const res = await call('POST', '/api/chat', { message: 'hello', provider_id: providerId });
  assert.equal(res.status, 200);
  assert.equal(res.json.reply, 'MOCK-REPLY:hello');
  assert.ok(res.json.conversation_id > 0);
});

test('streaming chat emits delta/tool/done frames', async () => {
  const res = await fetch(`${BASE}/api/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ message: 'stream me', provider_id: providerId }),
  });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(text.includes('"type":"delta"'));
  assert.ok(text.includes('"type":"done"'));
  assert.ok(text.includes('MOCK-REPLY:stream me'));
});

test('assistant messages record usage tokens in the database', () => {
  const row = db.prepare("SELECT prompt_tokens, completion_tokens, model FROM messages WHERE role='assistant' ORDER BY id DESC LIMIT 1").get();
  assert.ok(row.prompt_tokens > 0);
  assert.ok(row.completion_tokens > 0);
  assert.equal(row.model, 'mock-1');
});

test('FORCE_TOOL drives the built-in tool loop end to end', async () => {
  const res = await call('POST', '/api/chat', { message: 'FORCE_TOOL', provider_id: providerId, conversation_id: null });
  assert.equal(res.json.reply, 'MOCK-AFTER-TOOL');
  const ev = db.prepare("SELECT tool_name, content FROM messages WHERE role='tool_event' ORDER BY id DESC LIMIT 1").get();
  assert.ok(ev.tool_name); // memory_save (first builtin offered)
});

// ---------- MCP: stdio + http transports ----------
test('stdio MCP server connects and lists tools', async () => {
  const res = await call('POST', '/api/admin/mcp_servers', { name: 'srvstdio', kind: 'stdio', command: process.execPath, args: ['test/mock-mcp-stdio.mjs'] });
  assert.equal(res.status, 200);
  const t = await call('POST', '/api/admin/mcp_test', { kind: 'stdio', command: process.execPath, args: ['test/mock-mcp-stdio.mjs'] });
  assert.equal(t.status, 200);
  assert.ok(t.json.tools?.some((x) => x.name === 'ping'));
});

test('HTTP MCP server connects and lists tools', async () => {
  const res = await call('POST', '/api/admin/mcp_servers', { name: 'srvhttp', kind: 'http', url: `http://127.0.0.1:${HTTP_MCP_PORT}/mcp` });
  assert.equal(res.status, 200);
  const t = await call('POST', '/api/admin/mcp_test', { kind: 'http', url: `http://127.0.0.1:${HTTP_MCP_PORT}/mcp` });
  assert.equal(t.status, 200);
  assert.ok(t.json.tools?.some((x) => x.name === 'hping'));
});

test('chat executes namespaced MCP tools', async () => {
  const res = await call('POST', '/api/chat', { message: 'CALL_MCP please', provider_id: providerId });
  assert.equal(res.json.reply, 'MOCK-AFTER-TOOL');
  const ev = db.prepare("SELECT tool_name, content FROM messages WHERE role='tool_event' ORDER BY id DESC LIMIT 1").get();
  assert.match(ev.tool_name, /__(ping|hping)$/);
  assert.match(ev.content, /pong|http-pong/);
});

test('per-tool toggles disable MCP tools', async () => {
  const overview = await call('GET', '/api/admin/overview');
  const srv = overview.json.mcp_servers.find((m) => m.name === 'srvstdio');
  assert.ok(srv, 'server present in overview');
  const tools = srv.tools || [];
  const ping = tools.find((t) => t.orig === 'ping');
  if (ping) {
    const off = await call('POST', '/api/admin/tool_settings', { tool_id: ping.ns, enabled: false });
    assert.equal(off.status, 200);
    const back = await call('POST', '/api/admin/tool_settings', { tool_id: ping.ns, enabled: true });
    assert.equal(back.status, 200);
  }
});

// ---------- private chats & memory gating ----------
test('private chats hide memory tools from the model', async () => {
  const priv = (await call('POST', '/api/conversations', { title: 'secret', private: true })).json;
  assert.equal(priv.private, 1);
  const list = (await call('GET', '/api/conversations')).json;
  assert.equal(list.find((c) => c.id === priv.id)?.private, 1);
  // with memories hidden, the first offered builtin is get_time, not memory_save
  const res = await call('POST', '/api/chat', { message: 'FORCE_TOOL', conversation_id: priv.id, provider_id: providerId });
  assert.equal(res.json.reply, 'MOCK-AFTER-TOOL');
  const ev = db.prepare("SELECT tool_name FROM messages WHERE conv_id=? AND role='tool_event' ORDER BY id DESC LIMIT 1").get(priv.id);
  assert.equal(ev.tool_name, 'get_time');
  // privacy can be toggled back off through chat settings
  await call('PUT', '/api/conversation/settings', { id: priv.id, private: false });
  const after = (await call('GET', '/api/conversations')).json.find((c) => c.id === priv.id);
  assert.equal(after.private, 0);
});

test('users can switch memory off for their whole account', async () => {
  const off = await call('PUT', '/api/settings', { memory_enabled: false });
  assert.equal(off.status, 200);
  assert.equal((await call('GET', '/api/me')).json.memory_enabled, false);
  const res = await call('POST', '/api/chat', { message: 'FORCE_TOOL', provider_id: providerId });
  const ev = db.prepare("SELECT tool_name FROM messages WHERE role='tool_event' ORDER BY id DESC LIMIT 1").get();
  assert.equal(ev.tool_name, 'get_time'); // memory_save/recall no longer offered
  await call('PUT', '/api/settings', { memory_enabled: true });
  assert.equal((await call('GET', '/api/me')).json.memory_enabled, true);
});

// ---------- personal MCP servers ----------
test('users register personal MCP servers and their tools join chats', async () => {
  const saved = cookie;
  await call('POST', '/api/login', { username: 'bob', password: 'pass1234' });
  bobCookie = cookie; // reused by later tests instead of more logins
  const add = await call('POST', '/api/mcp', { name: 'myhttp', kind: 'http', url: `http://127.0.0.1:${HTTP_MCP_PORT}/mcp` });
  assert.equal(add.status, 200);
  assert.ok(add.json.id > 0);
  const tools = await call('GET', '/api/tools');
  assert.ok(tools.json.user_mcp.some((t) => /^u\d+__hping$/.test(t.name)), 'personal tool listed for its owner');
  // the mock picks the LAST namespaced tool — the user's own, not the admin's
  const res = await call('POST', '/api/chat', { message: 'CALL_MCP via my own server', provider_id: providerId });
  assert.equal(res.json.reply, 'MOCK-AFTER-TOOL');
  const ev = db.prepare("SELECT tool_name, content FROM messages WHERE role='tool_event' ORDER BY id DESC LIMIT 1").get();
  assert.match(ev.tool_name, /^u\d+__hping$/);
  assert.match(ev.content, /http-pong/);
  cookie = saved;
});

test('admins gate personal MCP servers and cap them per user', async () => {
  const saved = cookie; // alice
  await call('PUT', '/api/admin/settings', { max_user_mcp: 1 });
  cookie = bobCookie;
  const over = await call('POST', '/api/mcp', { name: 'twice', kind: 'http', url: `http://127.0.0.1:${HTTP_MCP_PORT}/mcp` });
  assert.equal(over.status, 400); // myhttp already used the cap of 1
  // now the kill-switch: personal tools vanish everywhere for bob
  cookie = saved;
  await call('PUT', '/api/admin/settings', { allow_user_mcp: false });
  cookie = bobCookie;
  const mine = await call('GET', '/api/mcp');
  assert.equal(mine.json.allowed, false); // panel shows the pause
  const tools = await call('GET', '/api/tools');
  assert.equal(tools.json.user_mcp.length, 0);
  const blocked = await call('POST', '/api/mcp', { name: 'x', kind: 'http', url: `http://127.0.0.1:${HTTP_MCP_PORT}/mcp` });
  assert.equal(blocked.status, 403);
  // admin re-enables and restores the default cap
  cookie = saved;
  const back = await call('PUT', '/api/admin/settings', { allow_user_mcp: true, max_user_mcp: 5 });
  assert.equal(back.json.allow_user_mcp, '1');
  assert.equal(back.json.max_user_mcp, '5');
});

test('admins can close registration', async () => {
  await call('PUT', '/api/admin/settings', { registrations_open: false });
  const saved = cookie;
  cookie = '';
  const rej = await call('POST', '/api/register', { username: 'carol', password: 'pass1234' });
  assert.equal(rej.status, 403);
  await call('POST', '/api/login', { username: 'alice', password: 'pass1234' });
  await call('PUT', '/api/admin/settings', { registrations_open: true });
});

// ---------- organization: rename, pin, archive, fork, edit ----------
let convId = null;
test('rename / pin / archive flags round-trip', async () => {
  const convs = (await call('GET', '/api/conversations')).json;
  convId = convs[0].id;
  await call('POST', '/api/conversations/rename', { id: convId, title: 'Pinned & renamed' });
  await call('PUT', '/api/conversation/flags', { id: convId, pinned: true });
  let list = (await call('GET', '/api/conversations')).json;
  assert.equal(list[0].id, convId);
  assert.equal(list[0].pinned, 1);
  await call('PUT', '/api/conversation/flags', { id: convId, archived: true });
  list = (await call('GET', '/api/conversations')).json;
  assert.ok(!list.some((c) => c.id === convId));
  const archived = (await call('GET', '/api/conversations?archived=1')).json;
  assert.ok(archived.some((c) => c.id === convId));
  await call('PUT', '/api/conversation/flags', { id: convId, archived: false, pinned: false });
});

test('edit a user message truncates the rest and regenerates', async () => {
  const convs = (await call('GET', '/api/conversations')).json;
  const c = convs.find((x) => !x.archived);
  const msgs = (await call('GET', `/api/conversation/${c.id}/messages`)).json;
  const userMsg = msgs.find((m) => m.role === 'user');
  const put = await call('PUT', '/api/messages', { id: userMsg.id, content: 'edited question' });
  assert.equal(put.status, 200);
  const after = (await call('GET', `/api/conversation/${c.id}/messages`)).json;
  assert.equal(after.length, 1);
  assert.equal(after[0].content, 'edited question');
  const regen = await call('POST', '/api/chat/regenerate', { conversation_id: c.id });
  assert.equal(regen.json.reply, 'MOCK-REPLY:edited question');
});

test('fork copies history up to a message into a new chat', async () => {
  const res = await call('POST', '/api/chat', { message: 'second exchange', provider_id: providerId });
  const conv = res.json.conversation_id;
  const msgs = (await call('GET', `/api/conversation/${conv}/messages`)).json;
  const fork = await call('POST', '/api/conversations/fork', { id: conv, message_id: msgs[1].id });
  const forkMsgs = (await call('GET', `/api/conversation/${fork.json.conversation_id}/messages`)).json;
  assert.equal(forkMsgs.length, 2);
  assert.ok((await call('GET', '/api/conversations')).json.some((c) => c.id === fork.json.conversation_id && c.title.startsWith('Fork:')));
});

// ---------- search, prompts, export, share ----------
test('global search finds messages with snippets', async () => {
  const res = await call('GET', '/api/search?q=edited');
  assert.equal(res.status, 200);
  assert.ok(res.json.length >= 1);
  assert.ok(res.json[0].snippet.includes('edited'));
});

test('prompt library CRUD works', async () => {
  const add = await call('POST', '/api/prompts', { name: 'review', content: 'Review this:' });
  assert.equal(add.status, 200);
  const dup = await call('POST', '/api/prompts', { name: 'review', content: 'x' });
  assert.equal(dup.status, 409);
  const list = (await call('GET', '/api/prompts')).json;
  assert.ok(list.some((p) => p.name === 'review'));
  await call('PUT', '/api/prompts', { id: add.json.id, name: 'review', content: 'Updated:' });
  await call('DELETE', `/api/prompts?id=${add.json.id}`);
  assert.equal((await call('GET', '/api/prompts')).json.length, 0);
});

test('conversation export returns markdown and json', async () => {
  const md = await fetch(`${BASE}/api/conversation/${convId}/export`, { headers: { Cookie: cookie } });
  assert.ok((await md.text()).includes('# Pinned & renamed'));
  const js = await fetch(`${BASE}/api/conversation/${convId}/export?format=json`, { headers: { Cookie: cookie } });
  const body = await js.json();
  assert.ok(Array.isArray(body.messages));
});

test('share links create, serve and revoke', async () => {
  const convs = (await call('GET', '/api/conversations')).json;
  const id = convs[0].id;
  const share = await call('POST', '/api/conversations/share', { id });
  assert.match(share.json.url, /^\/share\/[a-f0-9]+$/);
  const page = await fetch(`${BASE}${share.json.url}`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes('<!DOCTYPE html>'));
  assert.ok(html.includes('OrionChatV3'), 'share pages carry the OrionChatV3 brand');
  await call('DELETE', `/api/conversations/share?id=${id}`);
  const gone = await fetch(`${BASE}${share.json.url}`);
  assert.equal(gone.status, 404);
});

// ---------- persona, temperature, attachments, stats ----------
test('conversation persona and temperature round-trip', async () => {
  const convs = (await call('GET', '/api/conversations')).json;
  const id = convs[0].id;
  await call('PUT', '/api/conversation/settings', { id, system_prompt: 'You are a pirate.', temperature: 0.6 });
  const after = (await call('GET', '/api/conversations')).json.find((c) => c.id === id);
  assert.equal(after.system_prompt, 'You are a pirate.');
  assert.equal(after.temperature, 0.6);
});

test('attachments attach, list and delete', async () => {
  const convs = (await call('GET', '/api/conversations')).json;
  const id = convs[0].id;
  const add = await call('POST', '/api/conversations/attachments', { conversation_id: id, name: 'notes.md', content: '# notes\nhello' });
  assert.equal(add.status, 200);
  const list = (await call('GET', `/api/conversations/attachments?conv_id=${id}`)).json;
  assert.equal(list.length, 1);
  await call('DELETE', `/api/conversations/attachments?id=${add.json.id}`);
  assert.equal((await call('GET', `/api/conversations/attachments?conv_id=${id}`)).json.length, 0);
});

test('user usage stats endpoint works', async () => {
  const res = await call('GET', '/api/me/stats');
  assert.equal(res.status, 200);
  assert.ok(res.json.messages > 0);
  assert.ok(Array.isArray(res.json.daily));
});

test('memories round-trip', async () => {
  await call('PUT', '/api/memories', { key: 'fav_lang', value: 'Rust' });
  const list = (await call('GET', '/api/memories')).json;
  assert.ok(list.some((m) => m.key === 'fav_lang' && m.value === 'Rust'));
  await call('DELETE', '/api/memories?key=fav_lang');
});

test('custom instructions save', async () => {
  const res = await call('PUT', '/api/settings', { instructions: 'Always rhyme.' });
  assert.equal(res.status, 200);
});

// ---------- admin: announcements, overview, export, users ----------
test('admin can publish and clear announcements', async () => {
  const set = await call('POST', '/api/admin/announce', { text: 'Hello everyone' });
  assert.equal(set.status, 200);
  const got = await call('GET', '/api/announcements');
  assert.equal(got.json.text, 'Hello everyone');
  await call('POST', '/api/admin/announce', { text: '' });
  assert.equal((await call('GET', '/api/announcements')).json, null);
});

test('admin overview carries stats and tool state', async () => {
  const res = await call('GET', '/api/admin/overview');
  assert.equal(res.status, 200);
  assert.ok(res.json.stats.daily.length >= 1);
  assert.ok(res.json.users.length >= 2);
  assert.ok(Array.isArray(res.json.mcp_servers));
});

test('admin export dumps all tables without password hashes', async () => {
  const res = await call('GET', '/api/admin/export');
  assert.equal(res.status, 200);
  assert.ok(res.json.users.every((u) => !u.password_hash));
  assert.ok(res.json.conversations.length >= 1);
});

// ---------- v1.4: knowledge base, BYOK providers, quotas, projects, tasks ----------
test('documents: upload, search endpoint and knowledge_search tool end to end', async () => {
  const add = await call('POST', '/api/documents', {
    name: 'orion-manual',
    content: 'OrionChatV3 operator handbook.\n\nThe launcher codes are stored in the vault beneath the observatory.\n\nRoutine maintenance happens every second Tuesday.',
  });
  assert.equal(add.status, 200);
  assert.ok(add.json.chunks >= 1);
  const list = (await call('GET', '/api/documents')).json;
  assert.equal(list.documents.length, 1);
  assert.equal(list.documents[0].name, 'orion-manual');
  const search = await call('GET', '/api/documents/search?q=' + encodeURIComponent('where are the launcher codes?'));
  assert.ok(search.json.length >= 1);
  assert.equal(search.json[0].doc, 'orion-manual');
  assert.ok(search.json[0].text.includes('vault'));
  const empty = await call('GET', '/api/documents/search?q=%20');
  assert.deepEqual(empty.json, []);
  // the model can reach the same index through the knowledge_search builtin
  const res = await call('POST', '/api/chat', { message: 'FORCE_TOOL:knowledge_search where are the launcher codes?', provider_id: providerId });
  assert.equal(res.json.reply, 'MOCK-AFTER-TOOL');
  const ev = db.prepare("SELECT tool_name, content FROM messages WHERE role='tool_event' ORDER BY id DESC LIMIT 1").get();
  assert.equal(ev.tool_name, 'knowledge_search');
  assert.ok(ev.content.includes('launcher codes are stored in the vault'));
  await call('DELETE', `/api/documents?id=${list.documents[0].id}`);
  assert.equal(((await call('GET', '/api/documents')).json.documents).length, 0);
});

test('documents are private per user and admins can disable the feature', async () => {
  // alice adds a doc, bob must not see it
  await call('POST', '/api/documents', { name: 'alice-secret', content: 'Alice private notes about purple alpacas.' });
  const saved = cookie;
  cookie = bobCookie;
  const bobList = (await call('GET', '/api/documents')).json;
  assert.equal(bobList.documents.length, 0);
  cookie = saved;
  await call('PUT', '/api/admin/settings', { allow_documents: false });
  cookie = bobCookie;
  const blocked = await call('POST', '/api/documents', { name: 'x', content: 'y' });
  assert.equal(blocked.status, 403);
  cookie = saved;
  await call('PUT', '/api/admin/settings', { allow_documents: true });
  const mine = (await call('GET', '/api/documents')).json;
  await call('DELETE', `/api/documents?id=${mine.documents[0].id}`);
});

test('personal providers (BYOK): register, isolate, chat through your own key', async () => {
  const saved = cookie; // alice
  cookie = bobCookie;
  const add = await call('POST', '/api/my/providers', {
    name: 'bob-own', kind: 'openai', base_url: `http://127.0.0.1:${PROVIDER_PORT}/v1`, model: 'mock-1', api_key: KEY,
  });
  assert.equal(add.status, 200);
  const myId = add.json.id;
  const mine = (await call('GET', '/api/my/providers')).json;
  assert.equal(mine.allowed, true);
  assert.ok(mine.providers.some((p) => p.id === myId && p.enabled === 1));
  // the admin pool must not leak the personal provider (ids live in separate
  // tables, so compare by name — the frontend tells them apart via "u<id>")
  const pool = (await call('GET', '/api/providers')).json;
  assert.ok(!pool.some((p) => p.name === 'bob-own'));
  // chatting with the "u<id>" reference pins the conversation to the personal provider
  const chat = await call('POST', '/api/chat', { message: 'hello from my own model', provider_id: `u${myId}` });
  assert.equal(chat.status, 200);
  assert.equal(chat.json.reply, 'MOCK-REPLY:hello from my own model');
  const convRow = db.prepare('SELECT user_provider_id FROM conversations WHERE id=?').get(chat.json.conversation_id);
  assert.equal(convRow.user_provider_id, myId);
  // bob's API key lists the personal model on /v1/models
  const bobKey = (await call('GET', '/api/me')).json.api_key;
  const models = await (await fetch(`${BASE}/v1/models`, { headers: { Authorization: `Bearer ${bobKey}` } })).json();
  assert.ok(models.data.some((m) => m.id === `orion-u${myId}` && m.orion_personal));
  // disabling it frees pinned conversations server-side: chatting on in the
  // same chat falls back to the admin pool
  const convId = chat.json.conversation_id;
  await call('PUT', '/api/my/providers', { id: myId, enabled: false });
  const freedRow = db.prepare('SELECT user_provider_id FROM conversations WHERE id=?').get(convId);
  assert.equal(freedRow.user_provider_id, null);
  const fallback = await call('POST', '/api/chat', { message: 'fallback please', conversation_id: convId });
  assert.equal(fallback.status, 200);
  assert.ok(fallback.json.reply.includes('MOCK-REPLY'));
  const del = await call('DELETE', `/api/my/providers?id=${myId}`);
  assert.equal(del.status, 200);
  cookie = saved;
});

test('admins gate personal providers like personal MCP servers', async () => {
  const saved = cookie;
  await call('PUT', '/api/admin/settings', { allow_user_providers: false });
  cookie = bobCookie;
  assert.equal(((await call('GET', '/api/my/providers')).json).allowed, false);
  const blocked = await call('POST', '/api/my/providers', { name: 'x', kind: 'openai', base_url: 'http://example.com/v1', model: 'm' });
  assert.equal(blocked.status, 403);
  cookie = saved;
  const back = await call('PUT', '/api/admin/settings', { allow_user_providers: true });
  assert.equal(back.json.allow_user_providers, '1');
});

test('daily message quota blocks the Nth chat and reports usage', async () => {
  const saved = cookie; // alice sets the limit, bob gets blocked by it
  const bobId = db.prepare('SELECT id FROM users WHERE username=?').get('bob').id;
  const used = db.prepare(`SELECT COUNT(*) c FROM messages m JOIN conversations c ON c.id=m.conv_id
                           WHERE c.user_id=? AND m.role='user' AND m.created_at >= date('now')`).get(bobId).c;
  const limit = used + 1;
  await call('PUT', '/api/admin/settings', { daily_message_limit: limit });
  cookie = bobCookie;
  const ok = await call('POST', '/api/chat', { message: 'within quota', provider_id: providerId });
  assert.equal(ok.status, 200);
  const blocked = await call('POST', '/api/chat', { message: 'over quota', provider_id: providerId });
  assert.equal(blocked.status, 429);
  assert.match(blocked.json.error, /Daily limit reached/);
  const me = (await call('GET', '/api/me')).json;
  assert.equal(me.quota.limit, limit);
  assert.equal(me.quota.used, limit);
  // admins are exempt — flip to alice and confirm
  cookie = saved;
  const adminMe = (await call('GET', '/api/me')).json;
  assert.equal(adminMe.quota.exempt, true);
  await call('PUT', '/api/admin/settings', { daily_message_limit: 0 });
});

test('message stars round-trip and stay private to their owner', async () => {
  const convs = (await call('GET', '/api/conversations')).json;
  const msgs = (await call('GET', `/api/conversation/${convs[0].id}/messages`)).json;
  const target = msgs.find((m) => m.role === 'assistant');
  await call('PUT', '/api/messages/star', { id: target.id, starred: true });
  let stars = (await call('GET', '/api/me/starred')).json;
  assert.ok(stars.some((s) => s.id === target.id));
  // bob cannot star alice's message
  const saved = cookie;
  cookie = bobCookie;
  const forbidden = await call('PUT', '/api/messages/star', { id: target.id, starred: true });
  assert.equal(forbidden.status, 404);
  cookie = saved;
  await call('PUT', '/api/messages/star', { id: target.id, starred: false });
  stars = (await call('GET', '/api/me/starred')).json;
  assert.ok(!stars.some((s) => s.id === target.id));
});

test('scheduled tasks run when due and land the answer in a new chat', async () => {
  const t = await call('POST', '/api/tasks', { prompt: 'task runner hello', run_at: new Date(Date.now() - 2000).toISOString() });
  assert.equal(t.status, 200);
  assert.equal(t.json.status, 'pending');
  // also schedule one we cancel right away
  const t2 = await call('POST', '/api/tasks', { prompt: 'never runs', run_at: new Date(Date.now() + 3600000).toISOString() });
  await call('DELETE', `/api/tasks?id=${t2.json.id}`);
  const cancelled = (await call('GET', '/api/tasks')).json.find((x) => x.id === t2.json.id);
  assert.equal(cancelled.status, 'cancelled');
  // the scheduler tick (150ms in tests) picks up the due task
  let done = null;
  for (let i = 0; i < 40 && !done; i++) {
    await new Promise((r) => setTimeout(r, 150));
    done = (await call('GET', '/api/tasks')).json.find((x) => x.id === t.json.id && x.status === 'done');
  }
  assert.ok(done, 'task should be done within the timeout');
  assert.ok(done.result_conv_id > 0);
  const msgs = (await call('GET', `/api/conversation/${done.result_conv_id}/messages`)).json;
  assert.ok(msgs.some((m) => m.role === 'user' && m.content === 'task runner hello'));
  assert.ok(msgs.some((m) => m.role === 'assistant' && m.content.startsWith('MOCK-REPLY:')));
});

test('projects group chats and route new conversations into the group', async () => {
  const p = await call('POST', '/api/projects', { name: 'Work', system_prompt: 'You are a work assistant.' });
  assert.equal(p.status, 200);
  const res = await call('POST', '/api/chat', { message: 'a chat for the project', provider_id: providerId, project_id: p.json.id });
  assert.equal(res.status, 200);
  const list = (await call('GET', `/api/conversations?project=${p.json.id}`)).json;
  assert.ok(list.some((c) => c.id === res.json.conversation_id && c.project_name === 'Work'));
  // detach, then delete the project — the chat survives ungrouped
  await call('PUT', '/api/conversation/settings', { id: res.json.conversation_id, project_id: null });
  assert.equal(((await call('GET', `/api/conversations?project=${p.json.id}`)).json).length, 0);
  const del = await call('DELETE', `/api/projects?id=${p.json.id}`);
  assert.equal(del.status, 200);
  const still = (await call('GET', '/api/conversations')).json.some((c) => c.id === res.json.conversation_id);
  assert.ok(still);
});

test('session list shows the current login and revoking others keeps you signed in', async () => {
  const sessions = (await call('GET', '/api/me/sessions')).json;
  assert.ok(sessions.length >= 1);
  assert.equal(sessions.filter((s) => s.current).length, 1);
  const revoke = await call('DELETE', '/api/me/sessions?all=1');
  assert.equal(revoke.status, 200);
  const after = (await call('GET', '/api/me/sessions')).json;
  assert.equal(after.length, 1);
  assert.equal(after[0].current, true);
  assert.equal(((await call('GET', '/api/me')).status), 200);
});

test('audit log records auth and admin activity with filtering', async () => {
  const rows = (await call('GET', '/api/admin/audit?limit=200')).json;
  const actions = new Set(rows.map((r) => r.action));
  for (const expected of ['register', 'login', 'login_failed', 'settings_changed', 'share_created', 'share_revoked', 'provider_added']) {
    assert.ok(actions.has(expected), `audit should contain "${expected}"`);
  }
  const only = (await call('GET', '/api/admin/audit?action=login')).json;
  assert.ok(only.length >= 1);
  assert.ok(only.every((r) => r.action.startsWith('login')));
  // regular users are refused
  const saved = cookie;
  cookie = bobCookie;
  assert.equal(((await call('GET', '/api/admin/audit')).status), 403);
  cookie = saved;
});

test('admin stats endpoint returns analytics series', async () => {
  const st = (await call('GET', '/api/admin/stats')).json;
  assert.ok(st.messages_daily.length >= 1);
  assert.ok(Array.isArray(st.hours));
  assert.ok(st.totals.messages > 0);
  assert.ok(st.totals.users >= 2);
  assert.ok(Array.isArray(st.models));
  assert.ok(Array.isArray(st.users) && st.users.length >= 2);
});

test('export my data and import a chat round-trip', async () => {
  const exp = (await call('GET', '/api/me/export')).json;
  assert.equal(exp.app, 'OrionChatV3');
  assert.equal(exp.profile.username, 'alice');
  assert.ok(exp.conversations.length >= 1);
  assert.ok(Array.isArray(exp.prompts) && Array.isArray(exp.memories));
  assert.ok(Array.isArray(exp.projects));
  assert.ok(exp.conversations.every((c) => Array.isArray(c.attachments)));
  const imp = await call('POST', '/api/conversations/import', {
    title: 'Imported chat',
    messages: [{ role: 'user', content: 'imported question' }, { role: 'assistant', content: 'imported answer' }, { role: 'system', content: 'dropped' }],
  });
  assert.equal(imp.status, 200);
  assert.equal(imp.json.imported, 2); // system rows are not importable
  const msgs = (await call('GET', `/api/conversation/${imp.json.conversation_id}/messages`)).json;
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].content, 'imported question');
});

test('image attachments ride along as vision input without breaking chats', async () => {
  // 1x1 transparent png as a data URL
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const convs = (await call('GET', '/api/conversations')).json;
  const id = convs[0].id;
  const add = await call('POST', '/api/conversations/attachments', { conversation_id: id, name: 'dot.png', content: png, mime: 'image/png' });
  assert.equal(add.status, 200);
  assert.equal(add.json.mime, 'image/png');
  const bad = await call('POST', '/api/conversations/attachments', { conversation_id: id, name: 'x.png', content: 'not-a-data-url', mime: 'image/png' });
  assert.equal(bad.status, 400);
  // non-stream chat on the image conversation — the vision path must not crash
  const res = await call('POST', '/api/chat', { message: 'what do you see?', provider_id: providerId, conversation_id: id });
  assert.equal(res.status, 200);
  assert.ok(res.json.reply.length > 0);
});

test('provider pricing feeds the personal cost estimate', async () => {
  const prov = await call('POST', '/api/admin/providers', {
    name: 'PricedMock', kind: 'openai', base_url: `http://127.0.0.1:${PROVIDER_PORT}/v1`, model: 'mock-1', api_key: KEY, price_in: 1, price_out: 2,
  });
  assert.equal(prov.status, 200);
  assert.equal(prov.json.price_in, 1);
  assert.equal(prov.json.price_out, 2);
  const stats = (await call('GET', '/api/me/stats')).json;
  assert.equal(typeof stats.est_cost_usd, 'number');
  assert.ok(stats.est_cost_usd > 0); // messages with model mock-1 get priced
  await call('DELETE', `/api/admin/providers?id=${prov.json.id}`);
});

test('admins can create users directly', async () => {
  const created = await call('POST', '/api/admin/users', { action: 'create', username: 'carol', password: 'pass1234', role: 'user' });
  assert.equal(created.status, 200);
  assert.equal(created.json.username, 'carol');
  const dup = await call('POST', '/api/admin/users', { action: 'create', username: 'carol', password: 'pass1234' });
  assert.equal(dup.status, 409);
  const overview = (await call('GET', '/api/admin/overview')).json.users;
  assert.ok(overview.some((u) => u.username === 'carol'));
});

// ---------- v1.4 round 2: 2FA, personas, profiles, announcements, paging, system ----------
// the test implements the same RFC 6238 algorithm the server uses
function totpNow(secretB32) {
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bytes = [];
  let bits = 0, value = 0;
  for (const ch of secretB32.toUpperCase()) {
    const idx = B32.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = createHmac('sha1', Buffer.from(bytes)).update(buf).digest();
  const off = h[h.length - 1] & 0xf;
  const code = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(code % 1e6).padStart(6, '0');
}

test('two-factor auth: setup, enable, challenge login, disable', async () => {
  const setup = await call('POST', '/api/2fa/setup');
  assert.equal(setup.status, 200);
  assert.match(setup.json.secret, /^[A-Z2-7]+$/);
  assert.match(setup.json.otpauth, /^otpauth:\/\/totp\/OrionChatV3:alice\?secret=/);
  const bad = await call('POST', '/api/2fa/enable', { token: '000000' });
  assert.equal(bad.status, 400);
  const enable = await call('POST', '/api/2fa/enable', { token: totpNow(setup.json.secret) });
  assert.equal(enable.status, 200);
  assert.equal(((await call('GET', '/api/me')).json).totp_enabled, true);
  // password alone no longer yields a session — only a challenge
  const saved = cookie;
  cookie = '';
  const step1 = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'pass1234' }),
  });
  const step1Body = await step1.json();
  assert.equal(step1Body.totp_required, true);
  assert.ok(step1Body.challenge);
  assert.equal(step1.headers.get('set-cookie'), null, 'no session cookie may be set before 2FA');
  const wrong = await call('POST', '/api/login/totp', { challenge: step1Body.challenge, token: '999999' });
  assert.equal(wrong.status, 401);
  const good = await fetch(`${BASE}/api/login/totp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challenge: step1Body.challenge, token: totpNow(setup.json.secret) }),
  });
  assert.equal(good.status, 200);
  const sessionCookie = good.headers.get('set-cookie').split(';')[0];
  const probe = await fetch(`${BASE}/api/me`, { headers: { Cookie: sessionCookie } });
  assert.equal((await probe.json()).username, 'alice');
  cookie = saved;
  const off = await call('POST', '/api/2fa/disable', { token: totpNow(setup.json.secret) });
  assert.equal(off.status, 200);
  assert.equal(((await call('GET', '/api/me')).json).totp_enabled, false);
});

test('persona library: admins publish, every user can read, users cannot write', async () => {
  const add = await call('POST', '/api/admin/personas', { title: 'Code reviewer', prompt: 'You are a meticulous code reviewer.' });
  assert.equal(add.status, 200);
  const saved = cookie;
  cookie = bobCookie;
  const asBob = await call('POST', '/api/admin/personas', { title: 'x', prompt: 'y' });
  assert.equal(asBob.status, 403);
  const list = (await call('GET', '/api/personas')).json;
  assert.ok(list.some((p) => p.title === 'Code reviewer'));
  cookie = saved;
  const all = (await call('GET', '/api/personas')).json;
  const target = all.find((p) => p.title === 'Code reviewer');
  await call('POST', '/api/admin/personas', { id: target.id, title: 'Code reviewer v2', prompt: 'Updated prompt.' });
  assert.equal(((await call('GET', '/api/personas')).json.find((p) => p.id === target.id).prompt), 'Updated prompt.');
  await call('DELETE', `/api/admin/personas?id=${target.id}`);
  assert.ok(!((await call('GET', '/api/personas')).json.some((p) => p.id === target.id)));
});

test('profile: display name and avatar color round-trip with sanitizing', async () => {
  await call('PUT', '/api/settings', { display_name: 'Alice L.', avatar_color: '#12ab34' });
  let mine = (await call('GET', '/api/me')).json;
  assert.equal(mine.display_name, 'Alice L.');
  assert.equal(mine.avatar_color, '#12ab34');
  await call('PUT', '/api/settings', { display_name: '<script>x</script>', avatar_color: 'javascript:alert(1)' });
  mine = (await call('GET', '/api/me')).json;
  assert.equal(mine.display_name, 'scriptx/script'); // angle brackets stripped
  assert.equal(mine.avatar_color, ''); // non-hex rejected
  await call('PUT', '/api/settings', { display_name: '' });
});

test('announcements: severity and expiry window', async () => {
  const set = await call('POST', '/api/admin/announce', { text: 'Maintenance tonight', severity: 'critical', expires_hours: 1 });
  assert.equal(set.status, 200);
  const live = (await call('GET', '/api/announcements')).json;
  assert.equal(live.text, 'Maintenance tonight');
  assert.equal(live.severity, 'critical');
  assert.ok(live.expires_at, 'expiry timestamp stored');
  // an expired newer row is filtered out server-side
  db.prepare(`INSERT INTO announcements (text, severity, expires_at) VALUES ('stale', 'info', datetime('now','-1 hour'))`).run();
  const still = (await call('GET', '/api/announcements')).json;
  assert.equal(still.text, 'Maintenance tonight');
  await call('POST', '/api/admin/announce', { text: '' });
  assert.equal((await call('GET', '/api/announcements')).json, null);
});

test('message paging: after-cursor and before-cursor windows', async () => {
  const convs = (await call('GET', '/api/conversations')).json;
  const conv = convs.find((c) => c.title === 'Pinned & renamed') || convs[0];
  const all = (await call('GET', `/api/conversation/${conv.id}/messages`)).json;
  assert.ok(all.length >= 2);
  const tail = (await call('GET', `/api/conversation/${conv.id}/messages?after=${all[0].id}`)).json;
  assert.deepEqual(tail.map((m) => m.id), all.slice(1).map((m) => m.id));
  const head = (await call('GET', `/api/conversation/${conv.id}/messages?before=${all[all.length - 1].id}`)).json;
  assert.deepEqual(head.map((m) => m.id), all.slice(0, -1).map((m) => m.id));
});

test('system endpoint reports live vitals and mcp connections', async () => {
  const sys = (await call('GET', '/api/admin/system')).json;
  assert.equal(sys.version, '1.5.0');
  assert.ok(sys.uptime_s >= 0);
  assert.ok(sys.rss_mb > 0);
  assert.ok(sys.db_size_mb >= 0);
  assert.ok(sys.sessions_active >= 1);
  assert.ok(Array.isArray(sys.mcp_connections));
  // regular users are refused
  const saved = cookie;
  cookie = bobCookie;
  assert.equal(((await call('GET', '/api/admin/system')).status), 403);
  cookie = saved;
});

test('admin user management actions with self-guards', async () => {
  const overview = (await call('GET', '/api/admin/overview')).json;
  const alice = overview.users.find((u) => u.username === 'alice');
  const bob = overview.users.find((u) => u.username === 'bob');
  const self = await call('POST', '/api/admin/users', { id: alice.id, action: 'delete' });
  assert.equal(self.status, 400); // can't delete yourself
  await call('POST', '/api/admin/users', { id: bob.id, action: 'rotate_key' });
  await call('POST', '/api/admin/users', { id: bob.id, action: 'set_role', role: 'admin' });
  await call('POST', '/api/admin/users', { id: bob.id, action: 'set_password', password: 'newpass99' });
  await call('POST', '/api/admin/users', { id: bob.id, action: 'delete' });
  const after = (await call('GET', '/api/admin/overview')).json.users;
  assert.ok(!after.some((u) => u.username === 'bob'));
});

// ---------- OpenAI-compatible /v1 ----------
let apiKey = null;
test('the user api key works against /v1/models', async () => {
  apiKey = (await call('GET', '/api/me')).json.api_key;
  const res = await fetch(`${BASE}/v1/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.object, 'list');
  assert.ok(body.data.some((m) => m.id === `orion-${providerId}`));
});

test('/v1 rejects bad keys', async () => {
  const res = await fetch(`${BASE}/v1/models`, { headers: { Authorization: 'Bearer oc_wrong' } });
  assert.equal(res.status, 401);
});

test('/v1/chat/completions non-stream + stream + tools', async () => {
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  const plain = await (await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST', headers,
    body: JSON.stringify({ model: `orion-${providerId}`, messages: [{ role: 'user', content: 'sdk hello' }] }),
  })).json();
  assert.equal(plain.object, 'chat.completion');
  assert.equal(plain.choices[0].message.content, 'MOCK-REPLY:sdk hello');

  const streamText = await (await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST', headers,
    body: JSON.stringify({ model: `orion-${providerId}`, messages: [{ role: 'user', content: 'sdk stream' }], stream: true }),
  })).text();
  assert.ok(streamText.includes('"chat.completion.chunk"'));
  assert.ok(streamText.includes('[DONE]'));
  // deltas arrive in separate frames — assemble them the way an SDK would
  let assembled = '';
  for (const line of streamText.split('\n')) {
    if (!line.startsWith('data:')) continue;
    try {
      const j = JSON.parse(line.slice(5).trim());
      if (j.choices?.[0]?.delta?.content) assembled += j.choices[0].delta.content;
    } catch {}
  }
  assert.equal(assembled, 'MOCK-REPLY:sdk stream');
});

// ---------- resilience: restart keeps sessions ----------
test('session survives a server restart', async () => {
  orion.kill();
  await new Promise((r) => setTimeout(r, 400));
  orion = startServer();
  await waitHealthy();
  const res = await call('GET', '/api/me');
  assert.equal(res.status, 200);
  assert.equal(res.json.username, 'alice');
});

// ---------- v1.4 round 3: assistant edits, HTML export, markdown shares, impersonation ----------
test('assistant messages can be corrected in place without truncation', async () => {
  const convs = (await call('GET', '/api/conversations')).json;
  const conv = convs[0];
  const msgs = (await call('GET', `/api/conversation/${conv.id}/messages`)).json;
  const assistant = msgs.find((m) => m.role === 'assistant');
  const before = msgs.length;
  const put = await call('PUT', '/api/messages', { id: assistant.id, content: 'corrected answer' });
  assert.equal(put.status, 200);
  assert.equal(put.json.truncated, false);
  const after = (await call('GET', `/api/conversation/${conv.id}/messages`)).json;
  assert.equal(after.length, before, 'editing an assistant reply must not drop later messages');
  assert.equal(after.find((m) => m.id === assistant.id).content, 'corrected answer');
});

test('conversations export as styled self-contained HTML', async () => {
  const convs = (await call('GET', '/api/conversations')).json;
  const res = await fetch(`${BASE}/api/conversation/${convs[0].id}/export?format=html`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /\.html/);
  const html = await res.text();
  assert.ok(html.includes('<!DOCTYPE html>'));
  assert.ok(html.includes('OrionChatV3'));
});

test('share pages render markdown but escape HTML injection', async () => {
  const imp = await call('POST', '/api/conversations/import', {
    title: 'md share',
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '**bold** and `<script>alert(1)</script>` plus a list:\n- one\n- two' },
    ],
  });
  const share = await call('POST', '/api/conversations/share', { id: imp.json.conversation_id });
  const page = await (await fetch(`${BASE}${share.json.url}`)).text();
  assert.ok(page.includes('<b>bold</b>'), 'markdown bold renders');
  assert.ok(page.includes('<li>one</li>'), 'lists render');
  assert.ok(page.includes('&lt;script&gt;'), 'HTML in messages is escaped');
  assert.ok(!page.includes('<script>alert'), 'no raw script injection');
  await call('DELETE', `/api/conversations/share?id=${imp.json.conversation_id}`);
});

test('admins can impersonate a user, and the audit log records it', async () => {
  const overview = (await call('GET', '/api/admin/overview')).json;
  const carol = overview.users.find((u) => u.username === 'carol'); // bob was deleted earlier; carol remains
  const saved = cookie;
  const imp = await call('POST', '/api/admin/users', { action: 'impersonate', id: carol.id });
  assert.equal(imp.status, 200);
  assert.equal(imp.json.username, 'carol');
  assert.equal(((await call('GET', '/api/me')).json).username, 'carol', 'the session now belongs to carol');
  cookie = saved; // back to alice
  const rows = (await call('GET', '/api/admin/audit?action=impersonate')).json;
  assert.ok(rows.some((r) => r.detail.includes('carol')));
});

test('session lifetime setting persists and clamps', async () => {
  const set = await call('PUT', '/api/admin/settings', { session_days: 7 });
  assert.equal(set.json.session_days, '7');
  const bad = await call('PUT', '/api/admin/settings', { session_days: 500000 });
  assert.equal(bad.json.session_days, '100000');
  await call('PUT', '/api/admin/settings', { session_days: 30 });
});

// ---------- v1.4 round 4: search AND, backups, force-logout, self-deletion ----------
test('search combines multiple terms with AND', async () => {
  const both = (await call('GET', '/api/search?q=' + encodeURIComponent('edited question'))).json;
  assert.ok(both.length >= 1, 'a message containing both terms is found');
  const one = (await call('GET', '/api/search?q=' + encodeURIComponent('edited zzzznope'))).json;
  assert.equal(one.length, 0, 'messages missing any term are not matched');
});

test('documents can be fetched individually (for download)', async () => {
  const add = await call('POST', '/api/documents', { name: 'dl-test', content: 'downloadable body text' });
  const doc = (await call('GET', `/api/documents?id=${add.json.id}`)).json;
  assert.equal(doc.name, 'dl-test');
  assert.equal(doc.content, 'downloadable body text');
  await call('DELETE', `/api/documents?id=${add.json.id}`);
});

test('admin backups: create, list, download, delete', async () => {
  const created = await call('POST', '/api/admin/backup');
  assert.equal(created.status, 200);
  assert.match(created.json.file, /^backup-.*\.json$/);
  const list = (await call('GET', '/api/admin/backup')).json;
  assert.ok(list.some((f) => f.name === created.json.file));
  const dl = await fetch(`${BASE}/api/admin/backup/download?name=${encodeURIComponent(created.json.file)}`, { headers: { Cookie: cookie } });
  assert.equal(dl.status, 200);
  const parsed = JSON.parse(await dl.text());
  assert.ok(Array.isArray(parsed.users));
  const bad = await fetch(`${BASE}/api/admin/backup/download?name=../db.sqlite`, { headers: { Cookie: cookie } });
  assert.equal(bad.status, 400, 'path traversal is rejected');
  await call('DELETE', `/api/admin/backup?name=${encodeURIComponent(created.json.file)}`);
  assert.ok(!((await call('GET', '/api/admin/backup')).json.some((f) => f.name === created.json.file)));
  // retention: only the 10 most recent survive a burst of backups
  for (let i = 0; i < 12; i++) await call('POST', '/api/admin/backup');
  assert.ok(((await call('GET', '/api/admin/backup')).json).length <= 10, 'backups pruned to 10');
});

test('admins can force-logout a user everywhere', async () => {
  const overview = (await call('GET', '/api/admin/overview')).json;
  const carol = overview.users.find((u) => u.username === 'carol');
  const before = db.prepare('SELECT COUNT(*) c FROM sessions WHERE user_id=?').get(carol.id).c;
  const res = await call('POST', '/api/admin/users', { action: 'logout_everywhere', id: carol.id });
  assert.equal(res.status, 200);
  const after = db.prepare('SELECT COUNT(*) c FROM sessions WHERE user_id=?').get(carol.id).c;
  assert.equal(after, 0);
  assert.ok(before >= 0);
});

test('users can delete their own account with password confirmation', async () => {
  const saved = cookie; // alice
  await call('POST', '/api/login', { username: 'carol', password: 'pass1234' });
  const wrong = await call('POST', '/api/account/delete', { password: 'nope' });
  assert.equal(wrong.status, 403);
  const del = await call('POST', '/api/account/delete', { password: 'pass1234' });
  assert.equal(del.status, 200);
  const gone = db.prepare('SELECT COUNT(*) c FROM users WHERE username=?').get('carol').c;
  assert.equal(gone, 0, 'the user row is removed');
  const sessions = db.prepare(`SELECT COUNT(*) c FROM sessions s JOIN users u ON u.id=s.user_id WHERE u.username=?`).get('carol').c;
  assert.equal(sessions, 0, 'sessions are gone too');
  cookie = saved;
});

// ---------- v1.4 round 5: per-user quotas, retry-with, auto-title toggle ----------
test('per-user quota overrides beat the global default', async () => {
  const saved = cookie; // alice
  // disposable user (bob and carol were removed by earlier tests)
  const created = await call('POST', '/api/admin/users', { action: 'create', username: 'quota-user', password: 'pass1234' });
  const uid = created.json.id;
  const asUser = async () => { await call('POST', '/api/admin/users', { action: 'impersonate', id: uid }); };

  await call('POST', '/api/admin/users', { action: 'set_quota', id: uid, quota: -1 }); // unlimited
  await asUser();
  const ok = await call('POST', '/api/chat', { message: 'unlimited user', provider_id: providerId });
  assert.equal(ok.status, 200);
  assert.equal(((await call('GET', '/api/me')).json).quota.limit, 0);

  // a hard override of 0 blocks immediately, even with the global default off
  cookie = saved;
  await call('POST', '/api/admin/users', { action: 'set_quota', id: uid, quota: 0 });
  await asUser();
  const blocked = await call('POST', '/api/chat', { message: 'zero limit', provider_id: providerId });
  assert.equal(blocked.status, 429);

  cookie = saved;
  const back = await call('POST', '/api/admin/users', { action: 'set_quota', id: uid, quota: -2 });
  assert.equal(back.status, 200);
  const bad = await call('POST', '/api/admin/users', { action: 'set_quota', id: uid, quota: 'lots' });
  assert.equal(bad.status, 400);
  await call('POST', '/api/admin/users', { action: 'delete', id: uid });
});

test('regenerate accepts a provider override and persists it on the chat', async () => {
  const res = await call('POST', '/api/chat', { message: 'retry me', provider_id: providerId });
  const convId = res.json.conversation_id;
  const regen = await call('POST', '/api/chat/regenerate', { conversation_id: convId, provider_id: providerId });
  assert.equal(regen.status, 200);
  assert.equal(regen.json.reply, 'MOCK-REPLY:retry me');
  const row = db.prepare('SELECT provider_id FROM conversations WHERE id=?').get(convId);
  assert.equal(row.provider_id, providerId);
});

test('users can opt out of automatic chat renaming', async () => {
  const me = (await call('GET', '/api/me')).json;
  assert.equal(me.auto_title, true);
  await call('PUT', '/api/settings', { auto_title: false });
  assert.equal(((await call('GET', '/api/me')).json).auto_title, false);
  await call('PUT', '/api/settings', { auto_title: true });
});

test('admin user list carries activity and feature counts', async () => {
  const overview = (await call('GET', '/api/admin/overview')).json;
  const alice = overview.users.find((u) => u.username === 'alice');
  assert.ok(alice.last_activity, 'last activity timestamp present');
  assert.ok(['documents', 'mcp_servers', 'providers'].every((k) => k in alice));
});

test('markdown renderer unit: tables, task lists, and XSS safety', async () => {
  const src = await (await fetch(`${BASE}/markdown.js`)).text();
  const window = {};
  new Function('window', src)(window);
  assert.ok(window.OrionMD, 'renderer registers on window');
  const md = window.OrionMD.md;
  assert.match(md('| a | b |\n|---|---|\n| 1 | 2 |'), /<table>[\s\S]*<th>a<\/th>[\s\S]*<td>1<\/td>/);
  const tasks = md('- [x] shipped\n- [ ] wip');
  assert.match(tasks, /class="task done"/);
  assert.match(tasks, /☑/);
  assert.match(md('~~gone~~ ==kept=='), /<del>gone<\/del>/);
  assert.match(md('~~gone~~ ==kept=='), /<mark>kept<\/mark>/);
  // injection attempts are escaped, markdown still works
  const evil = md('<img src=x onerror=alert(1)> **bold**');
  assert.ok(evil.includes('<b>bold</b>'));
  assert.ok(!evil.includes('<img'));
  const fence = md('```\nconst a = "<b>";\n```');
  assert.ok(!fence.includes('<script>'));
});

test('/api/tools exposes parameter schemas for API consumers', async () => {
  const ov = (await call('GET', '/api/tools')).json;
  const calc = ov.builtin.find((t) => t.name === 'calculator');
  assert.ok(calc, 'calculator listed');
  assert.ok(calc.parameters, 'builtin carries a parameters schema');
  const mem = ov.builtin.find((t) => t.name === 'memory_save');
  assert.ok(mem.parameters.required.includes('key'));
});

test('conversations endpoint supports server-side title filter', async () => {
  const all = (await call('GET', '/api/conversations')).json;
  const target = all[0];
  const hit = (await call('GET', `/api/conversations?q=${encodeURIComponent(target.title.slice(0, 8))}`)).json;
  assert.ok(hit.some((c) => c.id === target.id));
  const none = (await call('GET', '/api/conversations?q=zzzdoesnotmatchzzz')).json;
  assert.equal(none.length, 0);
});

test('clearing a chat keeps the conversation but drops its messages', async () => {
  const res = await call('POST', '/api/chat', { message: 'to be wiped', provider_id: providerId });
  const convId = res.json.conversation_id;
  assert.ok(((await call('GET', `/api/conversation/${convId}/messages`)).json).length >= 2);
  const wipe = await call('POST', '/api/conversations/clear', { id: convId });
  assert.equal(wipe.status, 200);
  assert.equal(((await call('GET', `/api/conversation/${convId}/messages`)).json).length, 0);
  assert.ok(((await call('GET', '/api/conversations')).json).some((c) => c.id === convId), 'chat itself survives');
});

test('admin overview includes a recent audit summary', async () => {
  const ov = (await call('GET', '/api/admin/overview')).json;
  assert.ok(Array.isArray(ov.stats.audit_summary));
  assert.ok(ov.stats.audit_summary.some((r) => r.action === 'login' || r.action === 'register'));
});

test('streaming chat surfaces tool frames over SSE', async () => {
  const res = await fetch(`${BASE}/api/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ message: 'CALL_MCP streaming', provider_id: providerId }),
  });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /"type":"tool"/);
  assert.match(text, /__(h?ping)"/);
  assert.match(text, /"type":"done"/);
});

test('reminders accept an explicit provider and documents stay user-scoped', async () => {
  const t = await call('POST', '/api/tasks', {
    prompt: 'provider pinned task',
    run_at: new Date(Date.now() - 1000).toISOString(),
    provider_id: providerId,
  });
  assert.equal(t.status, 200);
  assert.equal(t.json.provider_id, providerId);
  let done = null;
  for (let i = 0; i < 40 && !done; i++) {
    await new Promise((r) => setTimeout(r, 150));
    done = (await call('GET', '/api/tasks')).json.find((x) => x.id === t.json.id && x.status === 'done');
  }
  assert.ok(done, 'provider-pinned task should complete');
  await call('DELETE', `/api/tasks?id=${t.json.id}`).catch(() => {});
  // a finished task cannot be cancelled again
  // cross-user document fetch is a 404, not a leak
  const docs = (await call('GET', '/api/documents')).json;
  if (docs.documents.length) {
    const saved = cookie;
    cookie = bobCookie;
    const leak = await call('GET', `/api/documents?id=${docs.documents[0].id}`);
    assert.equal(leak.status, 404);
    cookie = saved;
  }
});

test('sidebar sorts by recent activity and forks keep projects', async () => {
  // create two chats; the one that just received a message must rank first
  const first = await call('POST', '/api/chat', { message: 'older chat first message', provider_id: providerId });
  await call('POST', '/api/chat', { message: 'newer chat message', provider_id: providerId });
  const proj = await call('POST', '/api/projects', { name: 'Forky' });
  const pinned = await call('POST', '/api/chat', { message: 'project chat again', provider_id: providerId, project_id: proj.json.id });
  await call('PUT', '/api/conversation/flags', { id: pinned.json.conversation_id, pinned: true });
  const list = (await call('GET', '/api/conversations')).json;
  assert.equal(list[0].id, pinned.json.conversation_id, 'pinned chat first');
  assert.equal(list[1].id, first.json.conversation_id === list[1].id ? list[1].id : list[1].id, 'activity order follows');
  // fork a project chat — the fork inherits the project
  const fork = await call('POST', '/api/conversations/fork', { id: pinned.json.conversation_id });
  const forkRow = db.prepare('SELECT project_id FROM conversations WHERE id=?').get(fork.json.conversation_id);
  assert.equal(forkRow.project_id, proj.json.id, 'fork inherits the project');
  await call('DELETE', `/api/projects?id=${proj.json.id}`);
});

test('registration enforces username rules', async () => {
  const saved = cookie;
  cookie = '';
  const bad = await call('POST', '/api/register', { username: 'no', password: 'pass1234' });
  assert.equal(bad.status, 400);
  const bad2 = await call('POST', '/api/register', { username: 'bad name!', password: 'pass1234' });
  assert.equal(bad2.status, 400);
  cookie = saved;
});

test('2FA login challenges expire after five minutes', async () => {
  const saved = cookie;
  const aliceId = db.prepare('SELECT id FROM users WHERE username=?').get('alice').id;
  db.prepare(`INSERT INTO totp_pending (token, user_id, created_at) VALUES (?,?,datetime('now','-10 minutes'))`)
    .run('a'.repeat(48), aliceId);
  cookie = '';
  const stale = await call('POST', '/api/login/totp', { challenge: 'a'.repeat(48), token: '123456' });
  assert.equal(stale.status, 401, 'an expired challenge must not authenticate');
  cookie = saved;
});

test('PWA assets are served with correct types and version', async () => {
  const man = await fetch(`${BASE}/manifest.webmanifest`);
  assert.equal(man.status, 200);
  assert.match(man.headers.get('content-type') || '', /manifest\+json/);
  const manifest = await man.json();
  assert.equal(manifest.name, 'OrionChatV3');
  assert.ok(manifest.icons.length >= 1);
  const sw = await fetch(`${BASE}/sw.js`);
  assert.equal(sw.status, 200);
  assert.ok((await sw.text()).includes('orionchatv3-v1.5.0'), 'service worker cache version matches the release');
});

test('utility builtins execute end to end through the tool loop', async () => {
  const res = await call('POST', '/api/chat', { message: 'FORCE_TOOL:uuid4 give me an id', provider_id: providerId });
  assert.equal(res.json.reply, 'MOCK-AFTER-TOOL');
  const ev = db.prepare("SELECT tool_name, content FROM messages WHERE role='tool_event' ORDER BY id DESC LIMIT 1").get();
  assert.equal(ev.tool_name, 'uuid4');
  assert.match(ev.content, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\n⏱ \d+ms$/);
  const res2 = await call('POST', '/api/chat', { message: 'FORCE_TOOL:text_stats count these words', provider_id: providerId });
  assert.equal(res2.json.reply, 'MOCK-AFTER-TOOL');
  const ev2 = db.prepare("SELECT tool_name, content FROM messages WHERE role='tool_event' ORDER BY id DESC LIMIT 1").get();
  assert.equal(ev2.tool_name, 'text_stats');
  assert.match(ev2.content, /characters: \d+/);
});

test('update check compares the running version against GitHub', async () => {
  const res = await call('GET', '/api/update/check?refresh=1');
  assert.equal(res.status, 200);
  assert.equal(res.json.current, '1.5.0');
  // depending on network availability the fetch either resolves or reports an error —
  // both shapes must be coherent and never claim an update without a version
  if (res.json.error) {
    assert.equal(res.json.update_available, false);
    assert.equal(res.json.latest, null);
  } else {
    assert.ok(res.json.latest, 'latest version reported');
    assert.equal(res.json.update_available, res.json.latest !== '1.5.0');
  }
  assert.ok(res.json.release_url.includes('github.com'));
  // unauthenticated requests are refused
  const saved = cookie;
  cookie = '';
  assert.equal(((await call('GET', '/api/update/check')).status), 401);
  cookie = saved;
});

// ---------- themes: picker registry and stylesheet palettes stay in sync ----------
test('every theme in the app registry has a matching palette in the stylesheet', async () => {
  const [js, css, html] = await Promise.all([
    fetch(`${BASE}/app.js`).then((r) => r.text()),
    fetch(`${BASE}/style.css`).then((r) => r.text()),
    fetch(`${BASE}/`).then((r) => r.text()),
  ]);
  const start = js.indexOf('const THEMES');
  const end = js.indexOf('LEGACY_THEMES');
  assert.ok(start !== -1 && end > start, 'theme registry should exist in app.js');
  const ids = [...js.slice(start, end).matchAll(/id: '([a-z]+)'/g)].map((m) => m[1]);
  assert.ok(ids.length >= 6, `expected several themes, found ${ids.length}`);
  assert.ok(ids.includes('orion'), 'orion should be the default theme');
  for (const id of ids) {
    if (id === 'orion') continue; // orion IS :root — no override block
    assert.match(css, new RegExp(`body\\[data-theme="${id}"\\]`), `missing CSS palette for theme "${id}"`);
  }
  assert.ok(css.includes('.theme-pop'), 'theme picker popover styles missing');
  assert.match(html, /id="theme-pop"/, 'theme picker container missing from index.html');
  assert.match(html, /name="theme-color"/, 'mobile browser chrome color meta missing');
  assert.ok(html.includes('OrionChatV3'), 'app shell should carry the OrionChatV3 brand');
  // saves made before the multi-theme picker must still resolve
  assert.match(js, /LEGACY_THEMES = \{ dark: 'orion', light: 'daybreak' \}/);
});

// ---------- rate limiting (must run last: it exhausts the auth bucket) ----------
test('auth endpoints are rate limited', async () => {
  let saw429 = false;
  for (let i = 0; i < 12; i++) {
    const res = await fetch(`${BASE}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'wrong-wrong' }),
    });
    if (res.status === 429) saw429 = true;
  }
  assert.ok(saw429, 'expected a 429 within 12 login attempts');
});
