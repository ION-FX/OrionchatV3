import http from 'node:http';
import os from 'node:os';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { createHash, createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { McpServer, HttpMcp } from './mcp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.ORION_DATA_DIR || path.join(ROOT, 'data');
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

// running version — keep in sync with the VERSION file in the repo root;
// the update checker compares this against GitHub
const APP_VERSION = '1.5.0';
const GITHUB_REPO = 'ION-FX/OrionchatV3';

const db = new DatabaseSync(path.join(DATA_DIR, 'orionchat.db'));
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  api_key TEXT UNIQUE,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'openai',
  base_url TEXT NOT NULL,
  api_key TEXT DEFAULT '',
  model TEXT NOT NULL,
  enabled INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS mcp_servers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  command TEXT NOT NULL,
  args TEXT DEFAULT '[]',
  env TEXT DEFAULT '',
  enabled INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS tool_settings (
  tool_id TEXT PRIMARY KEY,
  enabled INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT DEFAULT 'New chat',
  provider_id INTEGER,
  pinned INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  system_prompt TEXT NOT NULL DEFAULT '',
  temperature REAL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tool_name TEXT,
  model TEXT NOT NULL DEFAULT '',
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, key)
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS shares (
  token TEXT PRIMARY KEY,
  conv_id INTEGER NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);

// migrations: user custom instructions
{
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!cols.includes('instructions')) db.exec("ALTER TABLE users ADD COLUMN instructions TEXT NOT NULL DEFAULT ''");
}

// migrations: MCP http transport
{
  const cols = db.prepare('PRAGMA table_info(mcp_servers)').all().map((c) => c.name);
  if (!cols.includes('kind')) db.exec("ALTER TABLE mcp_servers ADD COLUMN kind TEXT NOT NULL DEFAULT 'stdio'");
  if (!cols.includes('url')) db.exec("ALTER TABLE mcp_servers ADD COLUMN url TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('headers')) db.exec("ALTER TABLE mcp_servers ADD COLUMN headers TEXT NOT NULL DEFAULT ''");
}

// migrations: conversation pin/archive + per-message usage tracking
{
  const cols = db.prepare('PRAGMA table_info(conversations)').all().map((c) => c.name);
  if (!cols.includes('pinned')) db.exec('ALTER TABLE conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('archived')) db.exec('ALTER TABLE conversations ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('system_prompt')) db.exec("ALTER TABLE conversations ADD COLUMN system_prompt TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('temperature')) db.exec('ALTER TABLE conversations ADD COLUMN temperature REAL');
}
{
  const cols = db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
  if (!cols.includes('model')) db.exec("ALTER TABLE messages ADD COLUMN model TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('prompt_tokens')) db.exec('ALTER TABLE messages ADD COLUMN prompt_tokens INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('completion_tokens')) db.exec('ALTER TABLE messages ADD COLUMN completion_tokens INTEGER NOT NULL DEFAULT 0');
}

// migrations: memory controls + private chats
{
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!cols.includes('memory_enabled')) db.exec('ALTER TABLE users ADD COLUMN memory_enabled INTEGER NOT NULL DEFAULT 1');
  if (!cols.includes('memory_allowed')) db.exec('ALTER TABLE users ADD COLUMN memory_allowed INTEGER NOT NULL DEFAULT 1');
  const ccols = db.prepare('PRAGMA table_info(conversations)').all().map((c) => c.name);
  if (!ccols.includes('private')) db.exec('ALTER TABLE conversations ADD COLUMN private INTEGER NOT NULL DEFAULT 0');
}

// user-registered MCP servers + admin platform settings
db.exec(`
CREATE TABLE IF NOT EXISTS user_mcp (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'stdio',
  command TEXT DEFAULT '',
  args TEXT DEFAULT '[]',
  env TEXT DEFAULT '',
  url TEXT DEFAULT '',
  headers TEXT DEFAULT '',
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS document_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  content TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS user_providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'openai',
  base_url TEXT NOT NULL,
  api_key TEXT DEFAULT '',
  model TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  username TEXT,
  action TEXT NOT NULL,
  detail TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  system_prompt TEXT NOT NULL DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  provider_id INTEGER,
  run_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | done | failed | cancelled
  result_note TEXT DEFAULT '',
  result_conv_id INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS personas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS totp_pending (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);

// migrations: profiles, 2FA, announcement expiry
{
  const ucols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!ucols.includes('display_name')) db.exec("ALTER TABLE users ADD COLUMN display_name TEXT NOT NULL DEFAULT ''");
  if (!ucols.includes('avatar_color')) db.exec("ALTER TABLE users ADD COLUMN avatar_color TEXT NOT NULL DEFAULT ''");
  if (!ucols.includes('totp_secret')) db.exec("ALTER TABLE users ADD COLUMN totp_secret TEXT");
  if (!ucols.includes('totp_enabled')) db.exec('ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0');
  if (!ucols.includes('quota_override')) db.exec('ALTER TABLE users ADD COLUMN quota_override INTEGER NOT NULL DEFAULT -2'); // -2 = global, -1 = unlimited, n = custom
  if (!ucols.includes('auto_title')) db.exec('ALTER TABLE users ADD COLUMN auto_title INTEGER NOT NULL DEFAULT 1');
  const acols = db.prepare('PRAGMA table_info(announcements)').all().map((c) => c.name);
  if (!acols.includes('severity')) db.exec("ALTER TABLE announcements ADD COLUMN severity TEXT NOT NULL DEFAULT 'info'");
  if (!acols.includes('expires_at')) db.exec('ALTER TABLE announcements ADD COLUMN expires_at TEXT');
}

// migrations: projects, personal providers, pricing, stars, image attachments
{
  const ccols = db.prepare('PRAGMA table_info(conversations)').all().map((c) => c.name);
  if (!ccols.includes('project_id')) db.exec('ALTER TABLE conversations ADD COLUMN project_id INTEGER');
  if (!ccols.includes('user_provider_id')) db.exec('ALTER TABLE conversations ADD COLUMN user_provider_id INTEGER');
  const acols = db.prepare('PRAGMA table_info(attachments)').all().map((c) => c.name);
  if (!acols.includes('mime')) db.exec("ALTER TABLE attachments ADD COLUMN mime TEXT NOT NULL DEFAULT 'text/plain'");
  const mcols = db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
  if (!mcols.includes('starred')) db.exec('ALTER TABLE messages ADD COLUMN starred INTEGER NOT NULL DEFAULT 0');
  const pcols = db.prepare('PRAGMA table_info(providers)').all().map((c) => c.name);
  if (!pcols.includes('price_in')) db.exec('ALTER TABLE providers ADD COLUMN price_in REAL');
  if (!pcols.includes('price_out')) db.exec('ALTER TABLE providers ADD COLUMN price_out REAL');
}

// ---------- platform settings (admin-controlled; fall back to defaults) ----------
const SETTING_DEFAULTS = {
  registrations_open: '1', // admins can close sign-ups
  allow_memory: '1',       // master switch for the whole memory feature
  allow_user_mcp: '1',     // users may register their own MCP servers
  max_user_mcp: '5',       // per-user cap on self-registered MCP servers
  daily_message_limit: '0',// per-user chat messages per UTC day; 0 = unlimited
  allow_user_providers: '1', // users may register their own API providers (BYOK)
  max_user_providers: '5', // per-user cap on personal providers
  allow_documents: '1',    // per-user knowledge base (documents + knowledge_search)
  max_documents: '20',     // per-user cap on stored documents
  session_days: '30',      // login lifetime; sessions older than this are dropped
};
function getSetting(key) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key=?').get(key);
  return row ? row.value : SETTING_DEFAULTS[key];
}
function setSetting(key, value) {
  db.prepare(`INSERT INTO app_settings (key, value) VALUES (?,?)
              ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, String(value));
}
function allSettings() {
  return Object.fromEntries(Object.keys(SETTING_DEFAULTS).map((k) => [k, getSetting(k)]));
}
function settingOn(key) { return getSetting(key) === '1'; }

// drop expired sessions on boot (lifetime configurable via the session_days setting)
db.exec(`DELETE FROM sessions WHERE created_at < datetime('now','-${Math.min(365, Math.max(1, Number(getSetting('session_days')) || 30))} days')`);

// performance: hot lookup paths (chat history, per-user lists, session checks)
db.exec(`
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conv_id);
CREATE INDEX IF NOT EXISTS idx_messages_tool ON messages(role, tool_name);
CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id, archived);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_chunks_user ON document_chunks(user_id);
CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
`);

// seed the shared persona library on fresh installs
if (!db.prepare('SELECT COUNT(*) c FROM personas').get().c) {
  const seedPersona = db.prepare('INSERT INTO personas (title, prompt) VALUES (?,?)');
  seedPersona.run('Code reviewer', 'You are a meticulous senior engineer reviewing code. Point out bugs, edge cases, security issues and style problems. Show concrete diffs for suggested changes.');
  seedPersona.run('Terse assistant', 'Answer in as few words as possible. No pleasantries, no restating the question. Bullets over prose.');
  seedPersona.run('Patient teacher', 'Explain things step by step for someone new to the topic. Use everyday analogies, define jargon the first time it appears, and check understanding with a short question at the end.');
  seedPersona.run('Socratic partner', "Don't give direct answers. Respond with questions that guide the user to their own conclusion, offering hints when they stall.");
  seedPersona.run('Translator', 'Translate any input between English and the language it was written in. Preserve tone, formatting and idioms. Output only the translation.');
  seedPersona.run('Brainstormer', 'Generate many diverse ideas without judging them. Group them by theme, mark the three boldest with 🔥, and end with one unconventional wildcard.');
}

// Memory features need all three gates open: admin global switch, admin hasn't
// blocked this user, user hasn't turned memory off — and the chat isn't private.
function memoryAllowed(user, conv) {
  if (conv?.private) return false;
  if (!settingOn('allow_memory')) return false;
  if (!Number(user.memory_allowed)) return false;
  return !!Number(user.memory_enabled);
}

// ---------- audit trail ----------
// One row per security-relevant action (logins, admin changes, shares…).
function audit(userId, username, action, detail = '') {
  try {
    db.prepare('INSERT INTO audit_log (user_id, username, action, detail) VALUES (?,?,?,?)')
      .run(userId ?? null, username ?? null, action, String(detail).slice(0, 500));
  } catch {} // audit must never break the request it observes
}

// ---------- daily message quota ----------
// Resolution: admin-set per-user override wins (-2 = follow global, -1 =
// unlimited, 0 = blocked, n = n messages/day); otherwise the global default.
// Admins are always exempt. Throws the routable 429 that chat routes surface.
function resolveQuota(u) {
  if (u.role === 'admin') return { limit: 0, unlimited: true };
  const override = Math.trunc(Number(u.quota_override ?? -2));
  if (override === -1) return { limit: 0, unlimited: true };
  if (Number.isNaN(override) || override === -2) {
    const global = Number(getSetting('daily_message_limit')) || 0;
    return { limit: global, unlimited: global === 0 };
  }
  return { limit: override, unlimited: false }; // 0 = blocked, n = n per day
}
function quotaUsed(userId) {
  return db.prepare(`SELECT COUNT(*) c FROM messages m JOIN conversations c ON c.id=m.conv_id
                     WHERE c.user_id=? AND m.role='user' AND m.created_at >= date('now')`).get(userId).c;
}
function checkQuota(u) {
  const q = resolveQuota(u);
  if (q.unlimited) return { used: 0, limit: 0 };
  const used = quotaUsed(u.id);
  if (used >= q.limit) {
    throw { status: 429, error: `Daily limit reached (${q.limit} messages per day). Resets at midnight UTC.`, retryAfterMs: Math.max(0, 86400000 - (Date.now() % 86400000)) };
  }
  return { used, limit: q.limit };
}
function quotaInfo(u) {
  const q = resolveQuota(u);
  return { used: quotaUsed(u.id), limit: q.limit, exempt: u.role === 'admin' };
}

// ---------- account deletion (admin actions + self-service) ----------
function deleteUserData(userId) {
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);
  for (const c of db.prepare('SELECT id FROM conversations WHERE user_id=?').all(userId)) {
    db.prepare('DELETE FROM messages WHERE conv_id=?').run(c.id);
    db.prepare('DELETE FROM attachments WHERE conv_id=?').run(c.id);
  }
  db.prepare('DELETE FROM conversations WHERE user_id=?').run(userId);
  db.prepare('DELETE FROM memories WHERE user_id=?').run(userId);
  for (const s of db.prepare('SELECT id FROM user_mcp WHERE user_id=?').all(userId)) evictMcp(`u${s.id}`);
  db.prepare('DELETE FROM user_mcp WHERE user_id=?').run(userId);
  for (const d of db.prepare('SELECT id FROM documents WHERE user_id=?').all(userId)) {
    db.prepare('DELETE FROM document_chunks WHERE doc_id=?').run(d.id);
  }
  db.prepare('DELETE FROM documents WHERE user_id=?').run(userId);
  db.prepare('UPDATE conversations SET project_id=NULL WHERE project_id IN (SELECT id FROM projects WHERE user_id=?)').run(userId);
  db.prepare('DELETE FROM projects WHERE user_id=?').run(userId);
  db.prepare('DELETE FROM scheduled_tasks WHERE user_id=?').run(userId);
  db.prepare('DELETE FROM prompts WHERE user_id=?').run(userId);
  db.prepare('DELETE FROM user_providers WHERE user_id=?').run(userId);
  db.prepare('DELETE FROM shares WHERE conv_id NOT IN (SELECT id FROM conversations)').run();
  db.prepare('DELETE FROM users WHERE id=?').run(userId);
}

// ---------- auth helpers ----------
function hashPassword(pw, salt) {
  return scryptSync(pw, salt, 32).toString('hex');
}
function newUser(username, pw) {
  const salt = randomBytes(16).toString('hex');
  const isAdmin = db.prepare('SELECT COUNT(*) c FROM users').get().c === 0;
  const r = db.prepare(
    'INSERT INTO users (username, password_hash, role, api_key) VALUES (?,?,?,?)'
  ).run(username, `${salt}:${hashPassword(pw, salt)}`, isAdmin ? 'admin' : 'user', 'oc_' + randomBytes(24).toString('hex'));
  return db.prepare('SELECT * FROM users WHERE id=?').get(r.lastInsertRowid);
}
function setPassword(userId, pw) {
  const salt = randomBytes(16).toString('hex');
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(`${salt}:${hashPassword(pw, salt)}`, userId);
}
function checkPassword(user, pw) {
  try {
    const [salt, hash] = user.password_hash.split(':');
    return timingSafeEqual(Buffer.from(hash), Buffer.from(hashPassword(pw, salt)));
  } catch { return false; }
}
function startSession(userId) {
  const token = randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?,?)').run(token, userId);
  return token;
}

// ---------- TOTP two-factor auth (RFC 6238, zero dependencies) ----------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  const out = [];
  let bits = 0, value = 0;
  for (const ch of String(str).toUpperCase().replace(/=+$/, '')) {
    const idx = B32.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function totpCode(secretBuf, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', secretBuf).update(buf).digest();
  const off = h[h.length - 1] & 0xf;
  const code = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(code % 1_000_000).padStart(6, '0');
}
// ±1 time-step tolerance (30s steps) absorbs small clock drift
function verifyTotp(secretB32, token) {
  const secret = base32Decode(secretB32);
  if (!secret.length || !/^\d{6}$/.test(String(token || '').trim())) return false;
  const counter = Math.floor(Date.now() / 30000);
  const want = String(token).trim();
  for (let i = -1; i <= 1; i++) {
    if (totpCode(secret, counter + i) === want) return true;
  }
  return false;
}
const COOKIE = (token) => `session=${token}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax`;
function currentUser(req) {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/session=([a-f0-9]+)/);
  if (m) {
    const row = db.prepare('SELECT user_id FROM sessions WHERE token=?').get(m[1]);
    if (row) return db.prepare('SELECT * FROM users WHERE id=?').get(row.user_id);
  }
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) {
    return db.prepare('SELECT * FROM users WHERE api_key=?').get(auth.slice(7));
  }
  return null;
}
function requireAuth(req) {
  const u = currentUser(req);
  if (!u) throw { status: 401, error: 'Not authenticated' };
  return u;
}
function requireAdmin(req) {
  const u = requireAuth(req);
  if (u.role !== 'admin') throw { status: 403, error: 'Admin required' };
  return u;
}

// ---------- rate limiting ----------
// simple sliding-window limiter, enough to blunt brute-force and runaway loops
const rateBuckets = new Map(); // key -> array of hit timestamps
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const hits = (rateBuckets.get(key) || []).filter((t) => now - t < windowMs);
  if (hits.length >= max) throw { status: 429, error: 'Too many requests — slow down a little.' };
  hits.push(now);
  rateBuckets.set(key, hits);
  if (rateBuckets.size > 500) { // drop buckets that have fully expired
    for (const [k, v] of rateBuckets) if (!v.some((t) => now - t < windowMs)) rateBuckets.delete(k);
  }
}
function clientIp(req) {
  return req.socket?.remoteAddress || 'unknown';
}

// ---------- built-in tools ----------
const BUILTIN_TOOLS = {
  memory_save: {
    description: 'Save a fact about the current user so you can remember it in future conversations.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Short topic key, e.g. "favorite_language"' },
        value: { type: 'string', description: 'The fact to remember' },
      },
      required: ['key', 'value'],
    },
    run: (args, user) => {
      db.prepare(
        `INSERT INTO memories (user_id, key, value, updated_at) VALUES (?,?,?,datetime('now'))
         ON CONFLICT(user_id, key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')`
      ).run(user.id, args.key, String(args.value));
      return `Remembered: ${args.key} = ${args.value}`;
    },
  },
  memory_recall: {
    description: 'Search remembered facts about the current user. Returns all memories if no query given.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Optional keyword to filter memories' } },
    },
    run: (args, user) => {
      const rows = db.prepare('SELECT key, value, updated_at FROM memories WHERE user_id=?').all(user.id);
      const q = (args.query || '').toLowerCase();
      const hits = rows.filter((r) => !q || r.key.toLowerCase().includes(q) || r.value.toLowerCase().includes(q));
      return hits.length ? hits.map((r) => `${r.key}: ${r.value}`).join('\n') : 'No matching memories yet.';
    },
  },
  get_time: {
    description: 'Get the current date and time.',
    inputSchema: { type: 'object', properties: {} },
    run: () => new Date().toString() + ' (UTC' + (new Date().getTimezoneOffset() <= 0 ? '+' : '-') + Math.abs(new Date().getTimezoneOffset() / 60) + ')',
  },
  calculator: {
    description: 'Evaluate a math expression, e.g. "2+2*10" or "sqrt(144)".',
    inputSchema: {
      type: 'object',
      properties: { expression: { type: 'string' } },
      required: ['expression'],
    },
    run: (args) => {
      const expr = String(args.expression);
      if (!/^[0-9+\-*/().,%\s a-z_]+$/i.test(expr)) throw new Error('Invalid characters in expression');
      const val = Function(`"use strict";const {sqrt,pow,abs,sin,cos,tan,log,round,floor,ceil,min,max,PI,E}=Math;return (${expr})`)();
      return String(val);
    },
  },
  web_search: {
    description: 'Search the public web and return the top results (title, URL, snippet).',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'The search query' } },
      required: ['query'],
    },
    run: async (args) => {
      const q = encodeURIComponent(String(args.query).slice(0, 400));
      const res = await fetch(`https://html.duckduckgo.com/html/?q=${q}`, {
        redirect: 'follow', signal: AbortSignal.timeout(20000),
        headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) OrionChatV3/1.4' },
      });
      if (!res.ok) throw new Error(`Search failed: HTTP ${res.status}`);
      const html = await res.text();
      const results = [];
      const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
      let m;
      while ((m = re.exec(html)) && results.length < 8) {
        const url = decodeURIComponent((m[1].match(/uddg=([^&]+)/) || [])[1] || m[1]);
        results.push(`${results.length + 1}. ${stripTags(m[2])}\n   ${url}\n   ${stripTags(m[3] || '')}`);
      }
      return results.length
        ? `Web results for "${args.query}":\n\n${results.join('\n\n')}`
        : `No results found for "${args.query}".`;
    },
  },
  web_fetch: {
    description: 'Fetch a public URL and return the response body as text (truncated to 20k chars).',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
    run: async (args) => {
      const res = await fetch(String(args.url), { redirect: 'follow', signal: AbortSignal.timeout(20000) });
      let text = await res.text();
      if ((res.headers.get('content-type') || '').includes('text/html') || /^\s*<(!doctype|html)/i.test(text)) {
        text = htmlToText(text);
      }
      return `HTTP ${res.status}\n` + text.slice(0, 20000);
    },
  },
  random_number: {
    description: 'Generate a random integer between min and max (inclusive), or a random float between them.',
    inputSchema: {
      type: 'object',
      properties: {
        min: { type: 'number', description: 'Lower bound (default 0)' },
        max: { type: 'number', description: 'Upper bound (default 100)' },
        float: { type: 'boolean', description: 'Return a float instead of an integer' },
      },
    },
    run: (args) => {
      const min = Number.isFinite(Number(args.min)) ? Number(args.min) : 0;
      const max = Number.isFinite(Number(args.max)) ? Number(args.max) : 100;
      if (max < min) throw new Error('max must be >= min');
      const x = min + Math.random() * (max - min);
      return String(args.float ? x : Math.floor(x));
    },
  },
  uuid4: {
    description: 'Generate a random UUID (version 4).',
    inputSchema: { type: 'object', properties: { count: { type: 'number', description: 'How many (1-10, default 1)' } } },
    run: (args) => {
      const n = Math.min(10, Math.max(1, Number(args.count) || 1));
      return Array.from({ length: n }, () => randomUUID()).join('\n');
    },
  },
  base64_convert: {
    description: 'Encode text to base64, or decode base64 back to text.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        mode: { type: 'string', description: '"encode" (default) or "decode"' },
      },
      required: ['text'],
    },
    run: (args) => {
      const text = String(args.text);
      if (String(args.mode || 'encode').toLowerCase() === 'decode') {
        return Buffer.from(text, 'base64').toString('utf8');
      }
      return Buffer.from(text, 'utf8').toString('base64');
    },
  },
  hash_text: {
    description: 'Hash text with sha256 (default), sha1, sha512 or md5. Returns the hex digest.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        algo: { type: 'string', description: 'sha256 | sha512 | sha1 | md5' },
      },
      required: ['text'],
    },
    run: (args) => {
      const algo = ['sha256', 'sha512', 'sha1', 'md5'].includes(String(args.algo || '').toLowerCase())
        ? String(args.algo).toLowerCase() : 'sha256';
      return createHash(algo).update(String(args.text)).digest('hex');
    },
  },
  text_stats: {
    description: 'Count characters, words, lines and bytes in a text.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    run: (args) => {
      const text = String(args.text);
      const words = text.trim() ? text.trim().split(/\s+/).length : 0;
      const lines = text ? text.split('\n').length : 0;
      return `characters: ${text.length}\nwords: ${words}\nlines: ${lines}\nbytes: ${Buffer.byteLength(text, 'utf8')}`;
    },
  },
  json_format: {
    description: 'Validate JSON and return it pretty-printed (or minified).',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The JSON text' },
        minify: { type: 'boolean', description: 'Strip whitespace instead of pretty-printing' },
      },
      required: ['text'],
    },
    run: (args) => {
      const parsed = JSON.parse(String(args.text));
      return args.minify ? JSON.stringify(parsed) : JSON.stringify(parsed, null, 2);
    },
  },
  knowledge_search: {
    description: "Search the current user's document library (notes, files, manuals they uploaded) and return the most relevant passages.",
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'What to look for in the documents' } },
      required: ['query'],
    },
    run: (args, user) => {
      const q = String(args.query || '').trim();
      if (!tokenize(q).length) {
        // no usable query: give the model the openings of the newest documents
        const rows = db.prepare(`SELECT d.name AS doc, c.content AS text FROM document_chunks c
                                 JOIN documents d ON d.id=c.doc_id WHERE c.user_id=? ORDER BY c.id LIMIT 3`).all(user.id);
        return rows.length
          ? `No search terms given. Document excerpts:\n${rows.map((h) => `[${h.doc}] ${h.text.slice(0, 300)}`).join('\n---\n')}`
          : 'No matching passages in the document library.';
      }
      const hits = searchDocuments(user.id, q, 3);
      if (!hits.length) return 'No matching passages in the document library.';
      return hits.map((h) => `[${h.doc}] ${h.text}`).join('\n---\n');
    },
  },
};

// ---------- knowledge base (per-user RAG-lite) ----------
// Documents are split into ~700-char chunks at paragraph boundaries so search
// results (and the tokens we spend on them) stay small. Scoring is term
// frequency overlap — no embeddings, no external services.
function tokenize(text) {
  return String(text).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);
}
function chunkDocument(content) {
  const paras = String(content).replace(/\r\n/g, '\n').split(/\n{2,}/);
  const chunks = [];
  let cur = '';
  for (const para of paras) {
    if ((cur + '\n\n' + para).length > 700 && cur) {
      chunks.push(cur.trim());
      cur = para;
    } else {
      cur = cur ? cur + '\n\n' + para : para;
    }
    // a single huge paragraph gets split hard
    while (cur.length > 900) {
      chunks.push(cur.slice(0, 700).trim());
      cur = cur.slice(650);
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}
function indexDocument(docId, userId, content) {
  db.prepare('DELETE FROM document_chunks WHERE doc_id=?').run(docId);
  const ins = db.prepare('INSERT INTO document_chunks (doc_id, user_id, content) VALUES (?,?,?)');
  for (const chunk of chunkDocument(content)) ins.run(docId, userId, chunk);
}
function searchDocuments(userId, query, limit = 3) {
  const words = tokenize(query);
  if (!words.length) return [];
  const rows = db.prepare('SELECT d.name AS doc, c.content AS text FROM document_chunks c JOIN documents d ON d.id=c.doc_id WHERE c.user_id=?').all(userId);
  const scored = [];
  for (const r of rows) {
    const tokens = tokenize(r.text);
    if (!tokens.length) continue;
    const counts = new Map();
    for (const t of tokens) counts.set(t, (counts.get(t) || 0) + 1);
    let score = 0;
    for (const w of new Set(words)) {
      const tf = counts.get(w) || 0;
      if (tf) score += 1 + Math.log(tf); // query-term frequency in this chunk
    }
    if (score > 0) scored.push({ ...r, score: score / Math.sqrt(tokens.length) });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

function toolEnabled(id) {
  const row = db.prepare('SELECT enabled FROM tool_settings WHERE tool_id=?').get(id);
  return row ? !!row.enabled : true; // enabled by default
}
function effectiveBuiltins() {
  return Object.fromEntries(Object.entries(BUILTIN_TOOLS).filter(([id]) => toolEnabled(id)));
}

// ---------- MCP manager ----------
// Long-lived connection cache: one process/connection per server config, reused across requests.
const mcpCache = new Map(); // row id -> { key, inst, tools, error }
function mcpKey(row) { return [row.kind, row.command, row.args, row.env, row.url, row.headers, row.enabled].join('|'); }
function evictMcp(id) {
  const hit = mcpCache.get(id);
  if (hit) { try { hit.inst.stop(); } catch {} mcpCache.delete(id); }
}
function makeMcpInstance(row) {
  if (row.kind === 'http') return new HttpMcp({ url: row.url, headers: row.headers });
  return new McpServer({ id: row.id, name: row.name, command: row.command, args: JSON.parse(row.args || '[]'), env: row.env });
}
async function getMcpEntry(row) {
  const key = mcpKey(row);
  const hit = mcpCache.get(row.id);
  if (hit && hit.key === key && !hit.inst.dead) return hit;
  evictMcp(row.id);
  const inst = makeMcpInstance(row);
  const entry = { key, inst, tools: [], extras: { resources: [], prompts: [] }, error: null };
  try {
    entry.tools = await inst.start();
    if (inst.extras) entry.extras = await inst.extras().catch(() => ({ resources: [], prompts: [] }));
  } catch (e) {
    entry.error = e.message;
    try { inst.stop(); } catch {}
  }
  mcpCache.set(row.id, entry);
  return entry;
}
function nsFor(name) {
  const ns = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 28);
  return ns || 'srv';
}
// Tools are exposed to models as "<server>__<tool>" so identically-named tools
// from different servers can't shadow each other. `rows` carry cache-ready ids
// (admin rows use their numeric id, user rows use a "u<id>" prefix so the
// connection cache never mixes the two tables).
async function mcpEntriesFor(rows, nsOf) {
  const defs = [], executors = new Map();
  for (const row of rows) {
    const entry = await getMcpEntry(row);
    const ns = nsOf(row);
    if (entry.error) {
      defs.push({ name: `mcp_error_${ns}`, description: `MCP server "${row.name}" failed to start: ${entry.error}`, inputSchema: { type: 'object', properties: {} } });
      continue;
    }
    for (const t of entry.tools) {
      const fullName = `${ns}__${String(t.name).replace(/[^a-zA-Z0-9_]/g, '_')}`.slice(0, 64);
      if (!toolEnabled(fullName)) continue; // per-tool admin toggle
      defs.push({ name: fullName, description: `[${row.name}] ${t.description || ''}`, inputSchema: t.inputSchema });
      const origName = t.name;
      executors.set(fullName, async (args) => {
        try {
          return await entry.inst.callTool(origName, args);
        } catch (e) {
          if (entry.inst.dead) {
            evictMcp(row.id);
            const fresh = await getMcpEntry(row);
            if (!fresh.error) return fresh.inst.callTool(origName, args);
          }
          throw e;
        }
      });
    }
  }
  return { defs, executors };
}
async function collectMcp() {
  return mcpEntriesFor(db.prepare('SELECT * FROM mcp_servers WHERE enabled=1').all(), (row) => nsFor(row.name));
}
// user-registered servers: namespaced by row id so two users registering a
// server with the same name can never collide
async function collectUserMcp(user) {
  const rows = db.prepare('SELECT * FROM user_mcp WHERE user_id=? AND enabled=1').all(user.id)
    .map((r) => ({ ...r, numId: r.id, id: `u${r.id}` }));
  return mcpEntriesFor(rows, (row) => `u${row.numId}`);
}
// validate + normalize a personal provider config (BYOK)
function parseProviderConfig(b) {
  if (!b.name || !String(b.name).trim()) throw { status: 400, error: 'Name required' };
  if (b.kind !== 'anthropic' && b.kind !== 'openai') throw { status: 400, error: 'kind must be openai or anthropic' };
  const base_url = String(b.base_url || '').trim();
  if (!/^https?:\/\//.test(base_url)) throw { status: 400, error: 'Base URL must start with http:// or https://' };
  const model = String(b.model || '').trim();
  if (!model) throw { status: 400, error: 'Model required' };
  return { name: String(b.name).trim().slice(0, 60), kind: b.kind, base_url, api_key: String(b.api_key || '').slice(0, 500), model: model.slice(0, 120) };
}
// validate + normalize a new/updated MCP server config from either admin or user routes
function parseMcpConfig(b) {
  if (!b.name || !String(b.name).trim()) throw { status: 400, error: 'Name required' };
  const kind = b.kind === 'http' ? 'http' : 'stdio';
  let command = '', args = '[]', url = '';
  if (kind === 'http') {
    url = String(b.url || '').trim();
    if (!/^https?:\/\//.test(url)) throw { status: 400, error: 'URL must start with http:// or https://' };
  } else {
    command = String(b.command || '').trim();
    if (!command) throw { status: 400, error: 'Command required' };
    args = typeof b.args === 'string' ? b.args.trim() : JSON.stringify(b.args || []);
    if (args) {
      try { JSON.parse(args); } catch { throw { status: 400, error: 'args is not valid JSON' }; }
    }
  }
  return { name: String(b.name).trim().slice(0, 60), kind, command, args: args || '[]', env: String(b.env || '').slice(0, 2000), url, headers: String(b.headers || '').slice(0, 2000) };
}
// admin view of a server's tools with per-tool toggle state (cache only, no spawning)
function cachedMcpTools(row) {
  const hit = mcpCache.get(row.id);
  if (!hit || hit.key !== mcpKey(row) || hit.error) return [];
  const ns = nsFor(row.name);
  return hit.tools.map((t) => {
    const fullName = `${ns}__${String(t.name).replace(/[^a-zA-Z0-9_]/g, '_')}`.slice(0, 64);
    return { ns: fullName, orig: t.name, enabled: toolEnabled(fullName) };
  });
}
// plain tool list for a user-registered server (cache only, no spawning)
function cachedUserMcpTools(row) {
  const hit = mcpCache.get(`u${row.id}`);
  if (!hit || hit.key !== mcpKey(row) || hit.error) return [];
  return hit.tools.map((t) => ({ name: t.name, description: t.description }));
}

// shared by the admin and user "test connection" endpoints: spin up a temporary
// connection, list its tools, and always tear it down
async function testMcpConnection(req, res) {
  const b = await readBody(req);
  let inst;
  if (b.kind === 'http') {
    const cfg = parseMcpConfig({ name: b.name || 'test', kind: 'http', url: b.url, headers: b.headers });
    inst = new HttpMcp({ url: cfg.url, headers: cfg.headers });
  } else {
    const cfg = parseMcpConfig({ name: b.name || 'test', kind: 'stdio', command: b.command, args: b.args, env: b.env });
    inst = new McpServer({ id: 'test', name: cfg.name, command: cfg.command, args: JSON.parse(cfg.args), env: cfg.env });
  }
  try {
    const tools = await inst.start();
    const list = tools.map((t) => ({ name: t.name, description: t.description }));
    inst.stop();
    return send(res, 200, { ok: true, tools: list });
  } catch (e) {
    try { inst.stop(); } catch {}
    return send(res, 200, { ok: false, error: e.message });
  }
}

// ---------- provider presets ----------
const PRESETS = [
  { name: 'OpenRouter', kind: 'openai', base_url: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-sonnet-4' },
  { name: 'Anthropic', kind: 'anthropic', base_url: 'https://api.anthropic.com', model: 'claude-sonnet-4-20250514' },
  { name: 'OpenAI', kind: 'openai', base_url: 'https://api.openai.com/v1', model: 'gpt-4o' },
  { name: 'DeepSeek', kind: 'openai', base_url: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { name: 'Ollama', kind: 'openai', base_url: 'http://localhost:11434/v1', model: 'llama3.1', api_key: '' },
  { name: 'Ollama Cloud', kind: 'openai', base_url: 'https://ollama.com/v1', model: 'gpt-oss:120b' },
  { name: 'SpaceXAI', kind: 'openai', base_url: 'https://api.spacexai.com/v1', model: 'gpt-4o' },
  { name: 'Custom (OpenAI-compatible)', kind: 'openai', base_url: '', model: '' },
];

// ---------- model calling ----------
// callModel(provider, messages, tools, onDelta?, signal?) — when onDelta is given
// the provider is asked to stream and text fragments are passed to it as they
// arrive; signal aborts the upstream request (client hit "stop" or disconnected).
async function callModel(provider, messages, tools, onDelta, signal) {
  if (provider.kind === 'anthropic') return onDelta ? callAnthropicStream(provider, messages, tools, onDelta, signal) : callAnthropic(provider, messages, tools, signal);
  return onDelta ? callOpenAIStream(provider, messages, tools, onDelta, signal) : callOpenAI(provider, messages, tools, signal);
}

async function callOpenAI(provider, messages, tools, signal) {
  const body = { model: provider.model, messages };
  if (provider.temperature != null) body.temperature = provider.temperature;
  if (tools?.length) body.tools = tools.map((t) => ({ type: 'function', function: t }));
  const headers = { 'Content-Type': 'application/json' };
  if (provider.api_key) headers.Authorization = `Bearer ${provider.api_key}`;
  const res = await fetch(provider.base_url.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST', headers, body: JSON.stringify(body), signal: signal || AbortSignal.timeout(180000),
  });
  if (!res.ok) throw new Error(`${provider.name} HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);

  // some servers stream even when stream wasn't requested — consume the SSE anyway
  if ((res.headers.get('content-type') || '').includes('text/event-stream')) {
    return consumeOpenAIStream(res, null);
  }
  const data = await res.json();
  const msg = data.choices?.[0]?.message || {};
  const toolCalls = (msg.tool_calls || []).map((tc) => ({ id: tc.id, name: tc.function.name, arguments: safeJson(tc.function.arguments) }));
  return { content: msg.content || '', toolCalls, usage: normUsage(data.usage) };
}

// drain an OpenAI-style SSE body, accumulating content + tool calls; text
// fragments go to onDelta when provided
async function consumeOpenAIStream(res, onDelta) {
  let content = '';
  let usage = null;
  // tool call arguments arrive as delta chunks indexed by tool position
  const tcAcc = new Map(); // index -> { id, name, args }
  await consumeSSE(res, (evt) => {
    if (evt.usage) usage = normUsage(evt.usage); // final chunk when include_usage is on
    const delta = evt.choices?.[0]?.delta;
    if (!delta) return;
    if (delta.content) {
      content += delta.content;
      if (onDelta) onDelta(delta.content);
    }
    for (const tc of delta.tool_calls || []) {
      const acc = tcAcc.get(tc.index ?? 0) || { id: '', name: '', args: '' };
      if (tc.id) acc.id = tc.id;
      if (tc.function?.name) acc.name += tc.function.name;
      if (tc.function?.arguments) acc.args += tc.function.arguments;
      tcAcc.set(tc.index ?? 0, acc);
    }
  });
  const toolCalls = [...tcAcc.values()]
    .filter((tc) => tc.name)
    .map((tc) => ({ id: tc.id || `call_${tcAcc.size}`, name: tc.name, arguments: safeJson(tc.args || '{}') }));
  return { content, toolCalls, usage };
}

// normalize OpenAI-style usage {prompt_tokens, completion_tokens} / Anthropic
// {input_tokens, output_tokens} into a common shape
function normUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const p = Number(u.prompt_tokens ?? u.input_tokens) || 0;
  const c = Number(u.completion_tokens ?? u.output_tokens) || 0;
  return p || c ? { prompt: p, completion: c } : null;
}

// Parse an SSE body (fetch ReadableStream) line by line, invoking onEvent for
// every `data:` payload. Returns when the stream ends.
async function consumeSSE(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try { onEvent(JSON.parse(payload)); } catch {}
    }
  }
}

async function callOpenAIStream(provider, messages, tools, onDelta, signal) {
  const body = { model: provider.model, messages, stream: true };
  if (provider.temperature != null) body.temperature = provider.temperature;
  if (tools?.length) body.tools = tools.map((t) => ({ type: 'function', function: t }));
  const headers = { 'Content-Type': 'application/json' };
  if (provider.api_key) headers.Authorization = `Bearer ${provider.api_key}`;
  const res = await fetch(provider.base_url.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST', headers, body: JSON.stringify(body), signal: signal || AbortSignal.timeout(180000),
  });
  if (!res.ok) throw new Error(`${provider.name} HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);

  // Some OpenAI-compatible servers ignore stream:true and answer with plain JSON —
  // treat that as a single-chunk completion instead of failing to parse it as SSE.
  if (!(res.headers.get('content-type') || '').includes('text/event-stream')) {
    const data = await res.json();
    const msg = data.choices?.[0]?.message || {};
    const toolCalls = (msg.tool_calls || []).map((tc) => ({ id: tc.id, name: tc.function.name, arguments: safeJson(tc.function.arguments) }));
    if (msg.content) onDelta(msg.content);
    return { content: msg.content || '', toolCalls, usage: normUsage(data.usage) };
  }

  return consumeOpenAIStream(res, onDelta);
}

async function callAnthropicStream(provider, messages, tools, onDelta, signal) {
  const body = await anthropicBody(provider, messages, tools);
  body.stream = true;
  if (provider.temperature != null) body.temperature = provider.temperature;
  const res = await fetch(provider.base_url.replace(/\/$/, '') + '/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': provider.api_key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body), signal: signal || AbortSignal.timeout(180000),
  });
  if (!res.ok) throw new Error(`${provider.name} HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);

  // same fallback as the OpenAI path: a JSON body means the server ignored stream:true
  if (!(res.headers.get('content-type') || '').includes('text/event-stream')) {
    const data = await res.json();
    const text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
    const toolCalls = (data.content || []).filter((c) => c.type === 'tool_use').map((c) => ({ id: c.id, name: c.name, arguments: c.input }));
    if (text) onDelta(text);
    return { content: text, toolCalls, usage: normUsage(data.usage) };
  }

  let content = '';
  let usage = null;
  const toolCalls = [];
  let currentTool = null; // { id, name, args }
  await consumeSSE(res, (evt) => {
    if (evt.type === 'message_start' && evt.message?.usage) usage = normUsage(evt.message.usage);
    if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
      currentTool = { id: evt.content_block.id, name: evt.content_block.name, args: '' };
    } else if (evt.type === 'content_block_delta') {
      if (evt.delta?.type === 'text_delta') {
        content += evt.delta.text;
        onDelta(evt.delta.text);
      } else if (evt.delta?.type === 'input_json_delta' && currentTool) {
        currentTool.args += evt.delta.partial_json;
      }
    } else if (evt.type === 'content_block_stop' && currentTool) {
      toolCalls.push({ id: currentTool.id, name: currentTool.name, arguments: safeJson(currentTool.args || '{}') });
      currentTool = null;
    } else if (evt.type === 'message_delta' && evt.usage) {
      usage = { prompt: usage?.prompt || 0, completion: Number(evt.usage.output_tokens) || 0 };
    }
  });
  return { content, toolCalls, usage };
}

async function callAnthropic(provider, messages, tools, signal) {
  const body = await anthropicBody(provider, messages, tools);
  if (provider.temperature != null) body.temperature = provider.temperature;
  const res = await fetch(provider.base_url.replace(/\/$/, '') + '/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': provider.api_key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body), signal: signal || AbortSignal.timeout(180000),
  });
  if (!res.ok) throw new Error(`${provider.name} HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const data = await res.json();
  const text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  const toolCalls = (data.content || []).filter((c) => c.type === 'tool_use').map((c) => ({ id: c.id, name: c.name, arguments: c.input }));
  return { content: text, toolCalls, usage: normUsage(data.usage) };
}

async function anthropicBody(provider, messages, tools) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  const conv = messages.filter((m) => m.role !== 'system').map(toAnthropicMsg).filter(Boolean);
  const body = { model: provider.model, max_tokens: 8096, messages: conv };
  if (system) body.system = system;
  if (tools?.length) body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
  return body;
}

function toAnthropicMsg(m) {
  if (m.role === 'user') {
    if (!Array.isArray(m.content)) return { role: 'user', content: m.content };
    // multimodal parts: text + base64 images
    const parts = [];
    for (const p of m.content) {
      if (p.type === 'text' && p.text) parts.push({ type: 'text', text: p.text });
      if (p.type === 'image_url') {
        const dm = String(p.image_url?.url || '').match(/^data:(image\/[a-z+]+);base64,(.+)$/);
        if (dm) parts.push({ type: 'image', source: { type: 'base64', media_type: dm[1], data: dm[2] } });
      }
    }
    return parts.length ? { role: 'user', content: parts } : null;
  }
  if (m.role === 'assistant') {
    if (m.tool_calls?.length) {
      return { role: 'assistant', content: m.tool_calls.map((tc) => ({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments })) };
    }
    return m.content ? { role: 'assistant', content: m.content } : null;
  }
  if (m.role === 'tool') {
    return { role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: String(m.content) }] };
  }
  return null;
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

function stripTags(html) {
  return htmlToText(html).replace(/\s+/g, ' ').trim();
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*/g, '\n\n')
    .trim();
}

// ---------- chat orchestration ----------
// runChat drives the model/tool loop. When `onDelta` is provided, provider text
// is streamed through it as it arrives; `onEvent` receives tool activity; the
// `signal` aborts generation when the user presses stop or disconnects.
async function runChat(user, conv, provider, history, opts = {}) {
  const { onDelta, onEvent, signal } = opts;
  const memsOk = memoryAllowed(user, conv);
  // private chats and blocked users get none of the memory tools
  const builtins = memsOk ? effectiveBuiltins()
    : Object.fromEntries(Object.entries(effectiveBuiltins()).filter(([name]) => !name.startsWith('memory_')));
  const mcp = await collectMcp().catch(() => ({ defs: [], executors: new Map() }));
  // admin kill-switch: when user MCP is disallowed, personal tools pause everywhere
  const umcp = settingOn('allow_user_mcp')
    ? await collectUserMcp(user).catch(() => ({ defs: [], executors: new Map() }))
    : { defs: [], executors: new Map() };
  const toolDefs = [
    ...Object.entries(builtins).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })),
    ...mcp.defs,
    ...umcp.defs,
  ];

  // inject memory context so the AI "knows" the user. Persona precedence:
  // conversation system prompt → project prompt → default Orion preamble.
  const mems = memsOk ? db.prepare('SELECT key, value FROM memories WHERE user_id=?').all(user.id) : [];
  let sys = conv.system_prompt?.trim()
    ? conv.system_prompt.trim()
    : '';
  if (!sys && conv.project_id) {
    const proj = db.prepare('SELECT * FROM projects WHERE id=? AND user_id=?').get(conv.project_id, user.id);
    if (proj?.system_prompt?.trim()) sys = proj.system_prompt.trim();
  }
  if (!sys) sys = `You are a helpful assistant inside OrionChatV3, chatting with ${user.username} (role: ${user.role}).`;
  if (user.instructions) sys += `\n\nThe user has given you these standing instructions — follow them in every reply:\n${user.instructions}`;
  if (mems.length) sys += `\n\nKnown facts about this user:\n${mems.map((m) => `- ${m.key}: ${m.value}`).join('\n')}`;

  // recent text attachments ride along as context every turn (images are
  // handled separately — they become vision input on the latest user turn)
  const files = db.prepare(`SELECT name, content FROM attachments WHERE conv_id=? AND mime NOT LIKE 'image/%' ORDER BY id DESC LIMIT 3`).all(conv.id);
  if (files.length) sys += `\n\nFiles attached to this conversation:\n${files.map((f) => `--- ${f.name} ---\n${String(f.content).slice(0, 6000)}`).join('\n')}`;

  if (memsOk && toolDefs.length) sys += '\nUse the memory_save tool to remember durable facts about the user, and memory_recall to look them up.';
  if (settingOn('allow_documents') && toolDefs.some((t) => t.name === 'knowledge_search')) {
    const docCount = db.prepare('SELECT COUNT(*) c FROM documents WHERE user_id=?').get(user.id).c;
    if (docCount) sys += `\nThe user has a library of ${docCount} document(s). When a question might be answered by their documents, search them with knowledge_search before answering.`;
  }

  const messages = [{ role: 'system', content: sys }, ...history];

  // vision: attach the most recent uploaded images to the latest user turn as
  // multimodal content parts (OpenAI shape; converted for Anthropic below)
  const images = db.prepare(`SELECT content, mime FROM attachments WHERE conv_id=? AND mime LIKE 'image/%' ORDER BY id DESC LIMIT 3`).all(conv.id).reverse();
  if (images.length) {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    if (lastUser) {
      lastUser.content = [
        { type: 'text', text: typeof lastUser.content === 'string' ? lastUser.content : '' },
        ...images.map((img) => ({ type: 'image_url', image_url: { url: img.content } })),
      ];
    }
  }

  const toolExecutors = new Map([...mcp.executors, ...umcp.executors]);
  for (const [name, t] of Object.entries(builtins)) toolExecutors.set(name, (args) => t.run(args, user));

  // per-conversation sampling override rides on the provider config
  if (conv.temperature != null) provider = { ...provider, temperature: conv.temperature };

  const usageTotals = { prompt: 0, completion: 0 };
  for (let i = 0; i < 8; i++) {
    if (signal?.aborted) break; // user pressed stop / closed the tab
    const out = await callModel(provider, messages, toolDefs.length ? toolDefs : undefined, onDelta, signal);
    if (out.usage) {
      usageTotals.prompt += out.usage.prompt;
      usageTotals.completion += out.usage.completion;
    }
    if (out.content) {
      db.prepare('INSERT INTO messages (conv_id, role, content, model, prompt_tokens, completion_tokens) VALUES (?,?,?,?,?,?)')
        .run(conv.id, 'assistant', out.content, provider.model || '', usageTotals.prompt, usageTotals.completion);
    }
    if (!out.toolCalls.length) return { content: out.content || '(empty response)', usage: usageTotals };

    messages.push({
      role: 'assistant',
      content: out.content || null,
      tool_calls: out.toolCalls.map((tc) => ({
        id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      })),
    });
    for (const tc of out.toolCalls) {
      let result;
      const t0 = Date.now();
      try {
        const fn = toolExecutors.get(tc.name);
        if (!fn) throw new Error(`Unknown tool: ${tc.name}`);
        result = await fn(tc.arguments);
      } catch (e) {
        result = `Tool error: ${e.message}`;
      }
      const dur = Date.now() - t0;
      // persist tool usage so users can see what the AI did (the copy fed back
      // to the model stays clean; the duration suffix is for the transcript)
      db.prepare('INSERT INTO messages (conv_id, role, content, tool_name) VALUES (?,?,?,?)')
        .run(conv.id, 'tool_event', String(result).slice(0, 4000) + `\n⏱ ${dur}ms`, tc.name);
      if (onEvent) onEvent({ type: 'tool', name: tc.name, result: String(result).slice(0, 200), ms: dur });
      messages.push({ role: 'tool', tool_call_id: tc.id, content: String(result) });
    }
  }
  return { content: '(reached tool-use limit)', usage: usageTotals };
}

// Resolve the provider + conversation for a chat request; creates the
// conversation when needed. `provider_id` may be an admin provider id (number)
// or a personal provider reference like "u3" (the caller's own user_providers
// row). Throws a routable error when nothing is usable.
function resolveChatTarget(u, b) {
  if (!b.message || !String(b.message).trim()) throw { status: 400, error: 'Message required' };
  let conv = b.conversation_id
    ? db.prepare('SELECT * FROM conversations WHERE id=? AND user_id=?').get(b.conversation_id, u.id)
    : null;
  const pidRaw = b.provider_id ?? null;
  const pidStr = pidRaw == null ? null : String(pidRaw);
  const mine = pidStr && pidStr.startsWith('u') ? Number(pidStr.slice(1)) : null; // "u3" → personal provider 3
  const pid = mine ? null : (pidRaw == null ? null : Number(pidRaw));
  if (!conv) {
    const projectId = b.project_id
      ? db.prepare('SELECT id FROM projects WHERE id=? AND user_id=?').get(b.project_id, u.id)?.id ?? null
      : null;
    const r = db.prepare('INSERT INTO conversations (user_id, title, provider_id, user_provider_id, project_id) VALUES (?,?,?,?,?)')
      .run(u.id, String(b.message).slice(0, 50), mine ? null : pid, mine, projectId);
    conv = db.prepare('SELECT * FROM conversations WHERE id=?').get(r.lastInsertRowid);
  } else if (pid) {
    if (mine) {
      db.prepare('UPDATE conversations SET user_provider_id=?, provider_id=NULL WHERE id=?').run(mine, conv.id);
      conv.user_provider_id = mine;
    } else if (pid !== conv.provider_id) {
      db.prepare('UPDATE conversations SET provider_id=?, user_provider_id=NULL WHERE id=?').run(pid, conv.id);
      conv.provider_id = pid;
    }
  }
  // explicit request wins, then the conversation's stored default, then any admin provider
  let provider = null;
  if (conv.user_provider_id) {
    provider = db.prepare('SELECT * FROM user_providers WHERE id=? AND user_id=? AND enabled=1').get(conv.user_provider_id, u.id);
  }
  if (!provider) provider = db.prepare('SELECT * FROM providers WHERE id=?').get(conv.provider_id);
  if (!provider) provider = db.prepare('SELECT * FROM providers WHERE enabled=1 LIMIT 1').get();
  if (!provider) throw { status: 400, error: 'No provider configured. Ask an admin to add one (or add your own under 🧩).' };
  return { conv, provider };
}

function historyFor(convId) {
  return db.prepare('SELECT role, content FROM messages WHERE conv_id=? ORDER BY id').all(convId)
    .filter((m) => m.content && (m.role === 'user' || m.role === 'assistant'));
}

// Best-effort conversation title from the provider; falls back silently.
async function autoTitle(conv, provider, user) {
  if (!conv || !provider) return;
  if (user && !Number(user.auto_title)) return; // user opted out of auto-renaming
  const msgs = db.prepare("SELECT role, content FROM messages WHERE conv_id=? AND role IN ('user','assistant') ORDER BY id").all(conv.id);
  if (msgs.length !== 2 || !conv.title) return; // only title once, after the first exchange
  try {
    const out = await callModel(provider, [
      { role: 'system', content: 'Create a title of at most 6 words for the conversation below. Reply with the title only — no quotes, no punctuation at the end.' },
      { role: 'user', content: msgs.map((m) => `${m.role}: ${m.content}`).join('\n').slice(0, 1500) },
    ], undefined);
    const title = String(out.content || '').trim().replace(/^["'#\s]+|["'\s]+$/g, '').slice(0, 80);
    if (title) db.prepare('UPDATE conversations SET title=? WHERE id=?').run(title, conv.id);
  } catch {} // keep the truncated-message title
}

// ---------- OpenAI-compatible /v1 + share pages ----------
// resolve a model id ("orion-3" admin pool, "orion-u2" personal, provider name,
// or model name) to a provider row; personal ids only match their owner
function resolveV1Model(model, user) {
  const m = String(model || '');
  const byId = m.match(/^orion-(\d+)$/);
  if (byId) return db.prepare('SELECT * FROM providers WHERE id=? AND enabled=1').get(Number(byId[1]));
  const byMine = m.match(/^orion-u(\d+)$/);
  if (byMine && user) {
    return db.prepare('SELECT * FROM user_providers WHERE id=? AND user_id=? AND enabled=1').get(Number(byMine[1]), user.id);
  }
  if (user) {
    const mine = db.prepare('SELECT * FROM user_providers WHERE user_id=? AND enabled=1 AND (name=? OR model=?) ORDER BY id LIMIT 1').get(user.id, m, m);
    if (mine) return mine;
  }
  return db.prepare('SELECT * FROM providers WHERE enabled=1 AND (name=? OR model=?) ORDER BY id LIMIT 1').get(m, m)
    || db.prepare('SELECT * FROM providers WHERE enabled=1 ORDER BY id LIMIT 1').get();
}

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// minimal markdown for share pages — escapes everything up front, so it can
// only emit the safe tags below, never raw HTML from message content
function miniMarkdown(t) {
  const blocks = [];
  t = String(t ?? '').replace(/```([\w+-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push(`<pre><code>${escHtml(code.replace(/\n$/, ''))}</code></pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  t = escHtml(t);
  t = t.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  t = t.replace(/(https?:\/\/[^\s<)"']+)/g, '<a href="$1" rel="noopener">$1</a>');
  t = t.replace(/(?:^|\n)((?:[ \t]*[-*][ \t]+[^\n]+\n?)+)/g, (_, block) =>
    `\n<ul>${block.trim().split('\n').map((l) => `<li>${l.replace(/^[ \t]*[-*][ \t]+/, '')}</li>`).join('')}</ul>\n`);
  t = t.replace(/\n/g, '<br>');
  t = t.replace(/<br>\s*(<ul>|<pre>)/g, '$1').replace(/(<\/ul>|<\/pre>)\s*<br>/g, '$1');
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[i] ?? '');
}

// self-contained read-only transcript page (no external assets, light/dark toggle)
function sharePageHtml(conv, rows) {
  const body = rows.map((m) => {
    if (m.role === 'user') return `<div class="row"><div class="tag you">You</div><div class="msg">${miniMarkdown(m.content)}</div></div>`;
    if (m.role === 'assistant') return `<div class="row"><div class="tag ai">✦ Assistant</div><div class="msg">${miniMarkdown(m.content)}</div></div>`;
    return `<div class="tool">🔧 <code>${escHtml(m.tool_name)}</code> ${escHtml(String(m.content).slice(0, 240))}</div>`;
  }).join('\n');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="/logo.png" type="image/png">
<title>${escHtml(conv?.title || 'Shared chat')} — OrionChatV3</title>
<style>
  :root { color-scheme: dark; }
  body.light { color-scheme: light; }
  body { margin:0; font-family:"Segoe UI",system-ui,sans-serif; background:#0a0714; color:#ece9f7;
    background-image:radial-gradient(900px 600px at 80% -10%, rgba(129,92,246,.2), transparent 60%);
    transition: background .25s ease, color .25s ease; }
  body.light { background:#f6f3fb; color:#241d3d;
    background-image:radial-gradient(900px 600px at 80% -10%, rgba(129,92,246,.14), transparent 60%); }
  main { max-width:760px; margin:0 auto; padding:36px 20px 80px; }
  h1 { font-size:22px; } .meta { color:#9b93b8; font-size:12.5px; margin-bottom:28px; }
  body.light .meta { color:#7a7099; }
  .bar { position:fixed; top:10px; right:12px; display:flex; gap:6px; }
  .bar button { background:rgba(255,255,255,.08); color:inherit; border:1px solid rgba(255,255,255,.16);
    border-radius:9px; padding:5px 10px; font-size:12px; cursor:pointer; }
  body.light .bar button { background:rgba(0,0,0,.05); border-color:rgba(0,0,0,.14); }
  .row { margin:14px 0; } .tag { font-size:11px; font-weight:700; letter-spacing:.08em; text-transform:uppercase;
    color:#a78bfa; margin-bottom:5px; } .tag.you { color:#f0abfc; }
  body.light .tag { color:#7c3aed; } body.light .tag.you { color:#c026d3; }
  .msg { background:rgba(255,255,255,.05); border:1px solid rgba(255,255,255,.09); border-radius:14px;
    padding:12px 15px; word-break:break-word; line-height:1.55; font-size:14px; }
  body.light .msg { background:rgba(255,255,255,.75); border-color:rgba(0,0,0,.09); }
  .msg pre { background:rgba(0,0,0,.3); border-radius:9px; padding:10px 12px; overflow-x:auto; font-size:12.5px; }
  body.light .msg pre { background:#2a2440; color:#ece9f7; }
  .msg code { font-family:ui-monospace,Menlo,Consolas,monospace; font-size:.92em; }
  .msg ul { margin:6px 0; padding-left:22px; }
  .tool { color:#9b93b8; font-size:12.5px; margin:10px 0 10px 4px; }
  body.light .tool { color:#7a7099; }
  .tool code { color:#e9d5ff; background:rgba(167,139,250,.14); border-radius:6px; padding:1px 6px; }
  footer { margin-top:44px; color:#9b93b8; font-size:12px; text-align:center; }
  body.light footer { color:#7a7099; }
</style></head><body>
<div class="bar"><button onclick="document.body.classList.toggle('light')">🌓 light/dark</button>
<button onclick="window.print()">🖨 print</button></div>
<main>
<h1>${escHtml(conv?.title || 'Shared conversation')}</h1>
<div class="meta">Shared read-only transcript · ${rows.length} messages${conv ? ' · started ' + escHtml(conv.created_at) : ''}</div>
${body || '<p>No messages.</p>'}
<footer><img src="/logo.png" alt="" style="width:18px;height:18px;border-radius:6px;vertical-align:-4px"> powered by <b>OrionChatV3</b></footer>
</main></body></html>`;
}

// ---------- HTTP plumbing ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

function send(res, status, obj, headers = {}) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': typeof obj === 'string' ? 'text/plain' : 'application/json',
    ...SECURITY_HEADERS,
    ...headers,
  });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 5e6) req.destroy(); });
    req.on('end', () => resolve(data ? safeJson(data) : {}));
    req.on('error', reject);
  });
}

async function route(req, res, url) {
  const method = req.method;
  const p = url.pathname;

  if (p.startsWith('/api/')) {
    const t0 = Date.now();
    res.on('finish', () => {
      if (p === '/api/chat/stream') return; // logged via its own frames
      console.log(`${method} ${p} -> ${res.statusCode} (${Date.now() - t0}ms)`);
    });
    try {
      const handler = routes[method + ' ' + p];
      if (handler) return await handler(req, res, url);
      throw { status: 404, error: 'Not found' };
    } catch (e) {
      return send(res, e.status || 500, { error: e.error || e.message || 'Server error' });
    }
  }

  // static
  let file = p === '/' ? '/index.html' : p;
  const fp = path.join(ROOT, 'public', path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
  if (fp.startsWith(path.join(ROOT, 'public')) && existsSync(fp)) {
    const ext = path.extname(fp);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', ...SECURITY_HEADERS });
    return res.end(readFileSync(fp));
  }
  send(res, 404, 'Not found');
}

// ---------- route map ----------
// auth      POST /api/register /login /login/totp /logout · GET /api/me
// account   PUT /api/settings · POST /api/password · GET /api/me/sessions ·
//           DELETE /api/me/sessions · GET /api/me/export · POST /api/account/delete ·
//           POST /api/2fa/setup /enable /disable
// chat      POST /api/chat /chat/stream /chat/regenerate · GET /api/tools ·
//           GET /api/conversation/:id/messages · PUT /api/messages · PUT /api/messages/star
// data      GET/POST /api/conversations (+import/clear/rename/fork/share) ·
//           PUT /api/conversation/flags /settings · DELETE /api/conversations
//           GET /api/search · GET/POST/DELETE /api/conversations/attachments
// user res  GET/POST/PUT/DELETE /api/memories · /api/prompts · /api/documents ·
//           /api/my/providers · /api/mcp · /api/projects · /api/tasks · GET /api/personas ·
//           GET /api/me/starred · GET /api/me/stats
// platform  GET /api/announcements · GET /api/health
// admin     GET /api/admin/overview /stats /system /audit /export ·
//           PUT /api/admin/settings · POST /api/admin/providers /mcp_servers /mcp_test
//           /mcp_restart /provider_test /tool_settings /users /personas /backup ·
//           DELETE /api/admin/providers /mcp_servers /personas /backup ·
//           GET /api/admin/backup(+/download)
// openai    GET /v1/models · POST /v1/chat/completions
// ---------- update check helpers ----------
// true when candidate (repo VERSION) is a newer semver than current
function isNewerVersion(candidate, current) {
  const a = String(candidate || '').replace(/^v/, '').split(/[.\-]/).map((n) => parseInt(n, 10) || 0);
  const b = String(current || '').replace(/^v/, '').split(/[.\-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return false;
}
// one cached GitHub answer shared by all admins; refreshed at most hourly
let updateCache = { at: 0, latest: null, error: null };

const routes = {
  // ---- auth ----
  'POST /api/register': async (req, res) => {
    rateLimit(`auth:${clientIp(req)}`, 10, 10 * 60000);
    if (!settingOn('registrations_open')) throw { status: 403, error: 'Registrations are currently closed. Ask an admin.' };
    const b = await readBody(req);
    const username = String(b.username || '').trim();
    if (!username || !b.password || b.password.length < 4) throw { status: 400, error: 'Username and password (min 4 chars) required' };
    if (!/^[A-Za-z0-9_-]{3,32}$/.test(username)) throw { status: 400, error: 'Username must be 3-32 chars: letters, numbers, _ or -' };
    if (db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) throw { status: 409, error: 'Username taken' };
    const u = newUser(username, b.password);
    audit(u.id, u.username, 'register', `role=${u.role}`);
    const token = startSession(u.id);
    send(res, 200, { id: u.id, username: u.username, role: u.role }, { 'Set-Cookie': COOKIE(token) });
  },
  'POST /api/login': async (req, res) => {
    rateLimit(`auth:${clientIp(req)}`, 10, 10 * 60000);
    const b = await readBody(req);
    const u = db.prepare('SELECT * FROM users WHERE username=?').get(String(b.username || '').trim());
    if (!u || !checkPassword(u, b.password || '')) {
      audit(u?.id ?? null, String(b.username || '').trim() || '?', 'login_failed');
      throw { status: 401, error: 'Invalid credentials' };
    }
    // 2FA: password alone gets a short-lived challenge, never a session
    if (Number(u.totp_enabled) && u.totp_secret) {
      const challenge = randomBytes(24).toString('hex');
      db.prepare('INSERT INTO totp_pending (token, user_id) VALUES (?,?)').run(challenge, u.id);
      db.prepare(`DELETE FROM totp_pending WHERE created_at < datetime('now','-5 minutes')`).run();
      return send(res, 200, { totp_required: true, challenge });
    }
    audit(u.id, u.username, 'login');
    const token = startSession(u.id);
    send(res, 200, { id: u.id, username: u.username, role: u.role, api_key: u.api_key }, { 'Set-Cookie': COOKIE(token) });
  },
  // second step of 2FA login: exchange the challenge + authenticator code for a session
  'POST /api/login/totp': async (req, res) => {
    const b = await readBody(req);
    // challenges live for 5 minutes — expired ones are indistinguishable from bogus ones
    const row = db.prepare(`SELECT t.user_id, u.username, u.totp_secret FROM totp_pending t
                            JOIN users u ON u.id = t.user_id
                            WHERE t.token=? AND t.created_at > datetime('now','-5 minutes')`).get(String(b.challenge || ''));
    if (!row) throw { status: 401, error: 'Login challenge expired — start again' };
    rateLimit(`totp:${row.user_id}`, 6, 60000);
    if (!verifyTotp(row.totp_secret, b.token)) throw { status: 401, error: 'Invalid authenticator code' };
    db.prepare('DELETE FROM totp_pending WHERE token=?').run(String(b.challenge || ''));
    audit(row.user_id, row.username, 'login_2fa');
    const token = startSession(row.user_id);
    const u = db.prepare('SELECT id, username, role FROM users WHERE id=?').get(row.user_id);
    send(res, 200, u, { 'Set-Cookie': COOKIE(token) });
  },
  'POST /api/logout': async (req, res) => {
    const m = (req.headers.cookie || '').match(/session=([a-f0-9]+)/);
    if (m) db.prepare('DELETE FROM sessions WHERE token=?').run(m[1]);
    send(res, 200, { ok: true }, { 'Set-Cookie': 'session=; Path=/; Max-Age=0' });
  },
  'GET /api/me': async (req, res) => {
    const u = currentUser(req);
    if (!u) throw { status: 401, error: 'Not authenticated' };
    send(res, 200, {
      id: u.id, username: u.username, role: u.role, api_key: u.api_key,
      display_name: u.display_name || '', avatar_color: u.avatar_color || '',
      totp_enabled: !!Number(u.totp_enabled),
      auto_title: !!Number(u.auto_title),
      memory_enabled: !!Number(u.memory_enabled),
      memory_allowed: !!Number(u.memory_allowed),
      memory_global: settingOn('allow_memory'),
      quota: quotaInfo(u),
      features: {
        user_mcp: settingOn('allow_user_mcp'),
        user_providers: settingOn('allow_user_providers'),
        documents: settingOn('allow_documents'),
      },
    });
  },
  'POST /api/password': async (req, res) => {
    const u = requireAuth(req);
    const b = await readBody(req);
    if (!checkPassword(u, b.current || '')) throw { status: 403, error: 'Current password is wrong' };
    if (!b.password || b.password.length < 4) throw { status: 400, error: 'New password must be at least 4 chars' };
    setPassword(u.id, b.password);
    audit(u.id, u.username, 'password_changed');
    send(res, 200, { ok: true });
  },

  // ---- providers (visible to every authenticated user) ----
  'GET /api/providers': async (req, res) => {
    requireAuth(req);
    send(res, 200, db.prepare('SELECT id, name, model FROM providers WHERE enabled=1 ORDER BY id').all());
  },

  // ---- conversations ----
  'GET /api/conversations': async (req, res, url) => {
    const u = requireAuth(req);
    const filter = url.searchParams.get('archived'); // '1' => only archived, 'all' => everything
    const project = Number(url.searchParams.get('project')) || null; // sidebar project filter
    let where = filter === '1' ? 'c.archived=1 AND c.user_id=?'
      : filter === 'all' ? 'c.user_id=?'
      : 'c.archived=0 AND c.user_id=?';
    const args = [u.id];
    if (project) { where += ' AND c.project_id=?'; args.push(project); }
    const q = String(url.searchParams.get('q') || '').trim(); // server-side title filter
    if (q.length >= 2) {
      where += ' AND c.title LIKE ?';
      args.push('%' + q.replace(/[\\%_]/g, (ch) => '\\' + ch) + '%');
    }
    send(res, 200, db.prepare(`
      SELECT c.*, p.name AS project_name,
        (SELECT content FROM messages WHERE conv_id=c.id AND role IN ('user','assistant') ORDER BY id DESC LIMIT 1) AS preview,
        (SELECT created_at FROM messages WHERE conv_id=c.id ORDER BY id DESC LIMIT 1) AS last_at
      FROM conversations c LEFT JOIN projects p ON p.id = c.project_id WHERE ${where}
      ORDER BY c.pinned DESC, COALESCE(last_at, c.created_at) DESC`).all(...args));
  },
  'POST /api/conversations': async (req, res) => {
    const u = requireAuth(req);
    const b = await readBody(req);
    let projectId = null;
    if (b.project_id) {
      projectId = db.prepare('SELECT id FROM projects WHERE id=? AND user_id=?').get(b.project_id, u.id)?.id ?? null;
    }
    const r = db.prepare('INSERT INTO conversations (user_id, title, provider_id, private, project_id) VALUES (?,?,?,?,?)')
      .run(u.id, b.title || 'New chat', b.provider_id ?? null, b.private ? 1 : 0, projectId);
    send(res, 200, db.prepare('SELECT * FROM conversations WHERE id=?').get(r.lastInsertRowid));
  },
  'POST /api/conversations/rename': async (req, res) => {
    const u = requireAuth(req);
    const b = await readBody(req);
    const title = String(b.title || '').trim().slice(0, 120);
    if (!title) throw { status: 400, error: 'Title required' };
    db.prepare('UPDATE conversations SET title=? WHERE id=? AND user_id=?').run(title, b.id, u.id);
    send(res, 200, { ok: true });
  },
  'GET /api/conversation/:id/messages': null, // handled below via prefix match
  'DELETE /api/conversations': null,

  // ---- chat ----
  'POST /api/chat': async (req, res) => {
    const u = requireAuth(req);
    rateLimit(`chat:${u.id}`, 40, 60000);
    checkQuota(u);
    const b = await readBody(req);
    const { conv, provider } = resolveChatTarget(u, b);
    db.prepare('INSERT INTO messages (conv_id, role, content) VALUES (?,?,?)').run(conv.id, 'user', b.message);
    const ac = new AbortController();
    req.on('close', () => ac.abort());
    const out = await runChat(u, conv, provider, historyFor(conv.id), { signal: ac.signal });
    await autoTitle(conv, provider, u);
    send(res, 200, { conversation_id: conv.id, reply: out.content, usage: out.usage });
  },

  // streaming variant: Server-Sent Events with delta/tool/done frames
  'POST /api/chat/stream': async (req, res) => {
    const u = requireAuth(req);
    rateLimit(`chat:${u.id}`, 40, 60000);
    checkQuota(u);
    const b = await readBody(req);
    const { conv, provider } = resolveChatTarget(u, b);
    db.prepare('INSERT INTO messages (conv_id, role, content) VALUES (?,?,?)').run(conv.id, 'user', b.message);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const frame = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const ac = new AbortController();
    req.on('close', () => ac.abort()); // stop button = fetch abort client-side
    try {
      const out = await runChat(u, conv, provider, historyFor(conv.id), {
        signal: ac.signal,
        onDelta: (text) => frame({ type: 'delta', text }),
        onEvent: (evt) => frame(evt),
      });
      await autoTitle(conv, provider, u);
      frame({ type: 'done', conversation_id: conv.id, reply: out.content, usage: out.usage });
    } catch (e) {
      frame({ type: 'error', error: e.message || 'Chat failed' });
    }
    res.end();
  },

  // regenerate: drop everything after the last user message and answer again
  'POST /api/chat/regenerate': async (req, res) => {
    const u = requireAuth(req);
    rateLimit(`chat:${u.id}`, 40, 60000);
    checkQuota(u);
    const b = await readBody(req);
    const conv = db.prepare('SELECT * FROM conversations WHERE id=? AND user_id=?').get(b.conversation_id, u.id);
    if (!conv) throw { status: 404, error: 'Conversation not found' };
    const lastUser = db.prepare("SELECT * FROM messages WHERE conv_id=? AND role='user' ORDER BY id DESC LIMIT 1").get(conv.id);
    if (!lastUser) throw { status: 400, error: 'Nothing to regenerate yet' };
    db.prepare('DELETE FROM messages WHERE conv_id=? AND id>?').run(conv.id, lastUser.id);
    let provider = null;
    // optional provider override ("retry with another model") persists on the chat
    if (b.provider_id !== undefined) {
      const pidRaw = b.provider_id ?? null;
      const pidStr = pidRaw == null ? null : String(pidRaw);
      const mine = pidStr && pidStr.startsWith('u') ? Number(pidStr.slice(1)) : null;
      if (mine) {
        provider = db.prepare('SELECT * FROM user_providers WHERE id=? AND user_id=? AND enabled=1').get(mine, u.id) || null;
        db.prepare('UPDATE conversations SET user_provider_id=?, provider_id=NULL WHERE id=?').run(provider ? mine : null, conv.id);
      } else {
        const pid = pidRaw == null ? null : Number(pidRaw);
        provider = db.prepare('SELECT * FROM providers WHERE id=?').get(pid) || null;
        db.prepare('UPDATE conversations SET provider_id=?, user_provider_id=NULL WHERE id=?').run(pid, conv.id);
      }
    }
    if (!provider && conv.user_provider_id) {
      provider = db.prepare('SELECT * FROM user_providers WHERE id=? AND user_id=? AND enabled=1').get(conv.user_provider_id, u.id);
    }
    if (!provider) provider = db.prepare('SELECT * FROM providers WHERE id=?').get(conv.provider_id);
    if (!provider) provider = db.prepare('SELECT * FROM providers WHERE enabled=1 LIMIT 1').get();
    if (!provider) throw { status: 400, error: 'No provider configured. Ask an admin to add one (or add your own under 🧩).' };
    const ac = new AbortController();
    req.on('close', () => ac.abort());
    const out = await runChat(u, conv, provider, historyFor(conv.id), { signal: ac.signal });
    send(res, 200, { conversation_id: conv.id, reply: out.content, usage: out.usage });
  },

  // ---- user settings ----
  'PUT /api/settings': async (req, res) => {
    const u = requireAuth(req);
    const b = await readBody(req);
    if (b.instructions !== undefined) {
      const instructions = String(b.instructions).slice(0, 4000);
      db.prepare('UPDATE users SET instructions=? WHERE id=?').run(instructions, u.id);
    }
    if (b.display_name !== undefined) {
      const name = String(b.display_name).replace(/[<>]/g, '').trim().slice(0, 40);
      db.prepare('UPDATE users SET display_name=? WHERE id=?').run(name, u.id);
    }
    if (b.avatar_color !== undefined) {
      const color = /^#[0-9a-fA-F]{6}$/.test(String(b.avatar_color)) ? String(b.avatar_color) : '';
      db.prepare('UPDATE users SET avatar_color=? WHERE id=?').run(color, u.id);
    }
    if (b.auto_title !== undefined) {
      db.prepare('UPDATE users SET auto_title=? WHERE id=?').run(b.auto_title ? 1 : 0, u.id);
    }
    if (b.memory_enabled !== undefined) {
      // turning memory OFF is always allowed; turning it back ON needs the gates open
      if (b.memory_enabled && (!Number(u.memory_allowed) || !settingOn('allow_memory'))) {
        throw { status: 403, error: 'Memory is disabled for your account' };
      }
      db.prepare('UPDATE users SET memory_enabled=? WHERE id=?').run(b.memory_enabled ? 1 : 0, u.id);
    }
    send(res, 200, { ok: true });
  },

  // ---- two-factor auth management (WebAuthn-less TOTP; see /api/login/totp) ----
  'POST /api/2fa/setup': async (req, res) => {
    const u = requireAuth(req);
    if (Number(u.totp_enabled)) throw { status: 400, error: '2FA is already enabled — disable it first' };
    const secret = base32Encode(randomBytes(20));
    db.prepare('UPDATE users SET totp_secret=?, totp_enabled=0 WHERE id=?').run(secret, u.id);
    const otpauth = `otpauth://totp/OrionChatV3:${encodeURIComponent(u.username)}?secret=${secret}&issuer=OrionChatV3&algorithm=SHA1&digits=6&period=30`;
    send(res, 200, { secret, otpauth });
  },
  'POST /api/2fa/enable': async (req, res) => {
    const u = requireAuth(req);
    const b = await readBody(req);
    if (!u.totp_secret) throw { status: 400, error: 'Start the setup first' };
    if (!verifyTotp(u.totp_secret, b.token)) throw { status: 400, error: 'That code is not valid — check your authenticator' };
    db.prepare('UPDATE users SET totp_enabled=1 WHERE id=?').run(u.id);
    audit(u.id, u.username, '2fa_enabled');
    send(res, 200, { ok: true });
  },
  'POST /api/2fa/disable': async (req, res) => {
    const u = requireAuth(req);
    const b = await readBody(req);
    if (!Number(u.totp_enabled)) throw { status: 400, error: '2FA is not enabled' };
    if (!verifyTotp(u.totp_secret, b.token)) throw { status: 400, error: 'Invalid authenticator code' };
    db.prepare('UPDATE users SET totp_secret=NULL, totp_enabled=0 WHERE id=?').run(u.id);
    audit(u.id, u.username, '2fa_disabled');
    send(res, 200, { ok: true });
  },

  // ---- memories ----
  'GET /api/memories': async (req, res) => {
    const u = requireAuth(req);
    send(res, 200, db.prepare('SELECT * FROM memories WHERE user_id=? ORDER BY key').all(u.id));
  },
  'PUT /api/memories': async (req, res) => {
    const u = requireAuth(req);
    const b = await readBody(req);
    if (!b.key || !String(b.value ?? '').trim()) throw { status: 400, error: 'key and value required' };
    db.prepare(`INSERT INTO memories (user_id, key, value, updated_at) VALUES (?,?,?,datetime('now'))
                ON CONFLICT(user_id, key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')`)
      .run(u.id, String(b.key), String(b.value));
    send(res, 200, { ok: true });
  },
  'DELETE /api/memories': async (req, res, url) => {
    const u = requireAuth(req);
    db.prepare('DELETE FROM memories WHERE user_id=? AND key=?').run(u.id, url.searchParams.get('key'));
    send(res, 200, { ok: true });
  },

  // ---- user-registered MCP servers (needs the admin's allow_user_mcp gate) ----
  'GET /api/mcp': async (req, res) => {
    const u = requireAuth(req);
    const rows = db.prepare('SELECT * FROM user_mcp WHERE user_id=? ORDER BY id').all(u.id);
    send(res, 200, {
      allowed: settingOn('allow_user_mcp'),
      max: Number(getSetting('max_user_mcp')) || 5,
      servers: rows.map((r) => {
        const hit = mcpCache.get(`u${r.id}`);
        const fresh = hit && hit.key === mcpKey(r);
        return {
          ...r,
          env: undefined,
          tools: fresh && !hit.error ? cachedUserMcpTools(r) : [],
          state_error: fresh ? hit.error : null,
          connected: !!(fresh && !hit.error),
        };
      }),
    });
  },
  'POST /api/mcp': async (req, res) => {
    const u = requireAuth(req);
    if (!settingOn('allow_user_mcp')) throw { status: 403, error: 'Admins have disabled personal MCP servers' };
    const b = await readBody(req);
    const cfg = parseMcpConfig(b);
    const count = db.prepare('SELECT COUNT(*) c FROM user_mcp WHERE user_id=?').get(u.id).c;
    const max = Number(getSetting('max_user_mcp')) || 5;
    if (count >= max) throw { status: 400, error: `Personal MCP server limit reached (${max}). Remove one first.` };
    const r = db.prepare(`INSERT INTO user_mcp (user_id, name, kind, command, args, env, url, headers, enabled)
                          VALUES (?,?,?,?,?,?,?,?,1)`)
      .run(u.id, cfg.name, cfg.kind, cfg.command, cfg.args, cfg.env, cfg.url, cfg.headers);
    const id = Number(r.lastInsertRowid);
    // connect right away so the panel can show the tool list and any startup errors
    const cacheRow = { ...cfg, numId: id, id: `u${id}`, enabled: 1 };
    const entry = await getMcpEntry(cacheRow).catch((e) => ({ tools: [], error: e.message }));
    send(res, 200, { id, tools: entry.tools.map((t) => t.name), error: entry.error || null });
  },
  'POST /api/mcp/test': async (req, res) => {
    const u = requireAuth(req);
    if (!settingOn('allow_user_mcp')) throw { status: 403, error: 'Admins have disabled personal MCP servers' };
    return testMcpConnection(req, res); // shared with the admin route below
  },
  'PUT /api/mcp': async (req, res) => {
    const u = requireAuth(req);
    const b = await readBody(req);
    const row = db.prepare('SELECT * FROM user_mcp WHERE id=? AND user_id=?').get(b.id, u.id);
    if (!row) throw { status: 404, error: 'Server not found' };
    db.prepare('UPDATE user_mcp SET enabled=? WHERE id=?').run(b.enabled ? 1 : 0, row.id);
    evictMcp(`u${row.id}`);
    send(res, 200, { ok: true });
  },
  'DELETE /api/mcp': async (req, res, url) => {
    const u = requireAuth(req);
    const id = Number(url.searchParams.get('id'));
    const row = db.prepare('SELECT * FROM user_mcp WHERE id=? AND user_id=?').get(id, u.id);
    if (row) {
      db.prepare('DELETE FROM user_mcp WHERE id=?').run(row.id);
      evictMcp(`u${row.id}`);
    }
    send(res, 200, { ok: true });
  },

  // ---- knowledge base: per-user documents the model can search ----
  'GET /api/documents': async (req, res, url) => {
    const u = requireAuth(req);
    if (!settingOn('allow_documents')) throw { status: 403, error: 'Admins have disabled the document library' };
    // ?id= fetches one document with its full content (for download / preview)
    const id = Number(url.searchParams.get('id'));
    if (id) {
      const doc = db.prepare('SELECT id, name, content, created_at FROM documents WHERE id=? AND user_id=?').get(id, u.id);
      if (!doc) throw { status: 404, error: 'Document not found' };
      return send(res, 200, doc);
    }
    send(res, 200, {
      max: Number(getSetting('max_documents')) || 20,
      documents: db.prepare(`SELECT id, name, length(content) AS bytes, created_at FROM documents WHERE user_id=? ORDER BY id DESC`).all(u.id),
    });
  },
  'POST /api/documents': async (req, res) => {
    const u = requireAuth(req);
    if (!settingOn('allow_documents')) throw { status: 403, error: 'Admins have disabled the document library' };
    const b = await readBody(req);
    const name = String(b.name || '').trim().slice(0, 100);
    const content = String(b.content || '');
    if (!name || !content.trim()) throw { status: 400, error: 'Name and content required' };
    if (content.length > 400000) throw { status: 400, error: 'Document too large (400 KB text limit)' };
    const count = db.prepare('SELECT COUNT(*) c FROM documents WHERE user_id=?').get(u.id).c;
    const max = Number(getSetting('max_documents')) || 20;
    if (count >= max) throw { status: 400, error: `Document limit reached (${max}). Remove one first.` };
    const r = db.prepare('INSERT INTO documents (user_id, name, content) VALUES (?,?,?)').run(u.id, name, content);
    indexDocument(Number(r.lastInsertRowid), u.id, content);
    send(res, 200, { id: Number(r.lastInsertRowid), chunks: chunkDocument(content).length });
  },
  'DELETE /api/documents': async (req, res, url) => {
    const u = requireAuth(req);
    const id = Number(url.searchParams.get('id'));
    const row = db.prepare('SELECT id FROM documents WHERE id=? AND user_id=?').get(id, u.id);
    if (row) {
      db.prepare('DELETE FROM document_chunks WHERE doc_id=?').run(row.id);
      db.prepare('DELETE FROM documents WHERE id=?').run(row.id);
    }
    send(res, 200, { ok: true });
  },
  'GET /api/documents/search': async (req, res, url) => {
    const u = requireAuth(req);
    if (!settingOn('allow_documents')) throw { status: 403, error: 'Admins have disabled the document library' };
    const q = String(url.searchParams.get('q') || '');
    send(res, 200, searchDocuments(u.id, q, 5));
  },

  // ---- personal providers (BYOK): the user's own API endpoints ----
  'GET /api/my/providers': async (req, res) => {
    const u = requireAuth(req);
    send(res, 200, {
      allowed: settingOn('allow_user_providers'),
      max: Number(getSetting('max_user_providers')) || 5,
      providers: db.prepare('SELECT id, name, kind, base_url, model, enabled FROM user_providers WHERE user_id=? ORDER BY id').all(u.id),
    });
  },
  'POST /api/my/providers': async (req, res) => {
    const u = requireAuth(req);
    if (!settingOn('allow_user_providers')) throw { status: 403, error: 'Admins have disabled personal providers' };
    const b = await readBody(req);
    const cfg = parseProviderConfig(b);
    const count = db.prepare('SELECT COUNT(*) c FROM user_providers WHERE user_id=?').get(u.id).c;
    const max = Number(getSetting('max_user_providers')) || 5;
    if (count >= max) throw { status: 400, error: `Personal provider limit reached (${max}). Remove one first.` };
    const r = db.prepare('INSERT INTO user_providers (user_id, name, kind, base_url, api_key, model, enabled) VALUES (?,?,?,?,?,?,1)')
      .run(u.id, cfg.name, cfg.kind, cfg.base_url, cfg.api_key, cfg.model);
    audit(u.id, u.username, 'provider_added', `personal:${cfg.name}`);
    send(res, 200, { id: Number(r.lastInsertRowid) });
  },
  'POST /api/my/providers/test': async (req, res) => {
    const u = requireAuth(req);
    if (!settingOn('allow_user_providers')) throw { status: 403, error: 'Admins have disabled personal providers' };
    const b = await readBody(req);
    const t0 = Date.now();
    try {
      await callModel({ name: b.name || 'test', kind: b.kind || 'openai', base_url: b.base_url, api_key: b.api_key || '', model: b.model },
        [{ role: 'user', content: 'Say OK.' }]);
      send(res, 200, { ok: true, ms: Date.now() - t0 });
    } catch (e) {
      send(res, 200, { ok: false, error: e.message, ms: Date.now() - t0 });
    }
  },
  'PUT /api/my/providers': async (req, res) => {
    const u = requireAuth(req);
    const b = await readBody(req);
    const row = db.prepare('SELECT * FROM user_providers WHERE id=? AND user_id=?').get(b.id, u.id);
    if (!row) throw { status: 404, error: 'Provider not found' };
    if (b.enabled !== undefined) {
      db.prepare('UPDATE user_providers SET enabled=? WHERE id=?').run(b.enabled ? 1 : 0, row.id);
      // a conversation parked on this provider falls back to the admin pool when disabled
      if (!b.enabled) db.prepare('UPDATE conversations SET user_provider_id=NULL WHERE user_provider_id=? AND user_id=?').run(row.id, u.id);
    }
    send(res, 200, { ok: true });
  },
  'DELETE /api/my/providers': async (req, res, url) => {
    const u = requireAuth(req);
    const id = Number(url.searchParams.get('id'));
    const row = db.prepare('SELECT * FROM user_providers WHERE id=? AND user_id=?').get(id, u.id);
    if (row) {
      db.prepare('UPDATE conversations SET user_provider_id=NULL WHERE user_provider_id=? AND user_id=?').run(id, u.id);
      db.prepare('DELETE FROM user_providers WHERE id=?').run(row.id);
      audit(u.id, u.username, 'provider_removed', `personal:${row.name}`);
    }
    send(res, 200, { ok: true });
  },

  // ---- projects: group conversations and give them a shared persona ----
  'GET /api/projects': async (req, res) => {
    const u = requireAuth(req);
    send(res, 200, db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM conversations c WHERE c.project_id=p.id) AS chats
                               FROM projects p WHERE p.user_id=? ORDER BY p.id`).all(u.id));
  },
  'POST /api/projects': async (req, res) => {
    const u = requireAuth(req);
    const b = await readBody(req);
    const name = String(b.name || '').trim().slice(0, 60);
    if (!name) throw { status: 400, error: 'Name required' };
    const r = db.prepare('INSERT INTO projects (user_id, name, system_prompt) VALUES (?,?,?)')
      .run(u.id, name, String(b.system_prompt || '').slice(0, 4000));
    send(res, 200, db.prepare('SELECT * FROM projects WHERE id=?').get(r.lastInsertRowid));
  },
  'PUT /api/projects': async (req, res) => {
    const u = requireAuth(req);
    const b = await readBody(req);
    const row = db.prepare('SELECT * FROM projects WHERE id=? AND user_id=?').get(b.id, u.id);
    if (!row) throw { status: 404, error: 'Project not found' };
    db.prepare('UPDATE projects SET name=?, system_prompt=? WHERE id=?')
      .run(String(b.name ?? row.name).trim().slice(0, 60) || row.name,
           String(b.system_prompt ?? row.system_prompt).slice(0, 4000), row.id);
    send(res, 200, { ok: true });
  },
  'DELETE /api/projects': async (req, res, url) => {
    const u = requireAuth(req);
    const id = Number(url.searchParams.get('id'));
    const row = db.prepare('SELECT * FROM projects WHERE id=? AND user_id=?').get(id, u.id);
    if (row) {
      db.prepare('UPDATE conversations SET project_id=NULL WHERE project_id=?').run(row.id);
      db.prepare('DELETE FROM projects WHERE id=?').run(row.id);
    }
    send(res, 200, { ok: true });
  },

  // ---- shared persona library (admin-curated, everyone can use) ----
  'GET /api/personas': async (req, res) => {
    requireAuth(req);
    send(res, 200, db.prepare('SELECT id, title, prompt FROM personas ORDER BY title').all());
  },
  'POST /api/admin/personas': async (req, res) => {
    const me = requireAdmin(req);
    const b = await readBody(req);
    const title = String(b.title || '').trim().slice(0, 60);
    const prompt = String(b.prompt || '').trim().slice(0, 4000);
    if (!title || !prompt) throw { status: 400, error: 'Title and prompt required' };
    if (b.id) {
      db.prepare('UPDATE personas SET title=?, prompt=? WHERE id=?').run(title, prompt, b.id);
    } else {
      db.prepare('INSERT INTO personas (title, prompt) VALUES (?,?)').run(title, prompt);
    }
    audit(me.id, me.username, b.id ? 'persona_updated' : 'persona_added', title);
    send(res, 200, { ok: true });
  },
  'DELETE /api/admin/personas': async (req, res, url) => {
    const me = requireAdmin(req);
    db.prepare('DELETE FROM personas WHERE id=?').run(url.searchParams.get('id'));
    audit(me.id, me.username, 'persona_removed', `id=${url.searchParams.get('id')}`);
    send(res, 200, { ok: true });
  },

  // ---- scheduled tasks: run a prompt later, result lands in a new chat ----
  'GET /api/tasks': async (req, res) => {
    const u = requireAuth(req);
    send(res, 200, db.prepare(`SELECT * FROM scheduled_tasks WHERE user_id=?
                               ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, run_at DESC LIMIT 50`).all(u.id));
  },
  'POST /api/tasks': async (req, res) => {
    const u = requireAuth(req);
    rateLimit(`tasks:${u.id}`, 20, 60000);
    const b = await readBody(req);
    const prompt = String(b.prompt || '').trim().slice(0, 4000);
    const runAt = new Date(String(b.run_at || ''));
    if (!prompt) throw { status: 400, error: 'Prompt required' };
    if (Number.isNaN(runAt.getTime())) throw { status: 400, error: 'run_at must be a valid date' };
    let providerId = null;
    if (b.provider_id) {
      providerId = db.prepare('SELECT id FROM providers WHERE id=? AND enabled=1').get(b.provider_id)?.id ?? null;
    }
    const r = db.prepare('INSERT INTO scheduled_tasks (user_id, prompt, provider_id, run_at) VALUES (?,?,?,?)')
      .run(u.id, prompt, providerId, runAt.toISOString());
    audit(u.id, u.username, 'task_scheduled', `at ${runAt.toISOString()}`);
    send(res, 200, db.prepare('SELECT * FROM scheduled_tasks WHERE id=?').get(r.lastInsertRowid));
  },
  'DELETE /api/tasks': async (req, res, url) => {
    const u = requireAuth(req);
    const id = Number(url.searchParams.get('id'));
    db.prepare(`UPDATE scheduled_tasks SET status='cancelled' WHERE id=? AND user_id=? AND status='pending'`).run(id, u.id);
    send(res, 200, { ok: true });
  },

  // ---- active sessions (see + revoke other logins) ----
  'GET /api/me/sessions': async (req, res) => {
    const u = requireAuth(req);
    const current = (req.headers.cookie || '').match(/session=([a-f0-9]+)/)?.[1];
    send(res, 200, db.prepare(`SELECT token, created_at FROM sessions WHERE user_id=? ORDER BY created_at DESC`).all(u.id)
      .map((s) => ({
        id: s.token.slice(0, 12), created_at: s.created_at, current: s.token === current,
      })));
  },
  'DELETE /api/me/sessions': async (req, res, url) => {
    const u = requireAuth(req);
    const current = (req.headers.cookie || '').match(/session=([a-f0-9]+)/)?.[1];
    if (url.searchParams.get('all')) {
      db.prepare('DELETE FROM sessions WHERE user_id=? AND token != ?').run(u.id, current || '');
      audit(u.id, u.username, 'sessions_revoked', 'all other sessions');
    } else {
      const prefix = url.searchParams.get('id') || '';
      if (!/^[a-f0-9]{12}$/.test(prefix)) throw { status: 400, error: 'Bad session id' };
      const rows = db.prepare('SELECT token FROM sessions WHERE user_id=?').all(u.id).filter((s) => s.token.startsWith(prefix));
      for (const s of rows) {
        if (s.token !== current) db.prepare('DELETE FROM sessions WHERE token=?').run(s.token);
      }
    }
    send(res, 200, { ok: true });
  },

  // ---- export everything that belongs to you (one JSON file) ----
  'GET /api/me/export': async (req, res) => {
    const u = requireAuth(req);
    const convs = db.prepare('SELECT * FROM conversations WHERE user_id=? ORDER BY id').all(u.id)
      .map((c) => ({
        ...c,
        messages: db.prepare('SELECT role, content, tool_name, model, created_at FROM messages WHERE conv_id=? ORDER BY id').all(c.id),
        attachments: db.prepare('SELECT name, mime, content, created_at FROM attachments WHERE conv_id=? ORDER BY id').all(c.id),
      }));
    const payload = {
      exported_at: new Date().toISOString(),
      app: 'OrionChatV3',
      profile: { username: u.username, role: u.role, created_at: u.created_at, instructions: u.instructions },
      conversations: convs,
      prompts: db.prepare('SELECT name, content, created_at FROM prompts WHERE user_id=?').all(u.id),
      memories: db.prepare('SELECT key, value, updated_at FROM memories WHERE user_id=?').all(u.id),
      documents: db.prepare('SELECT name, content, created_at FROM documents WHERE user_id=?').all(u.id),
      projects: db.prepare('SELECT name, system_prompt, created_at FROM projects WHERE user_id=?').all(u.id),
    };
    send(res, 200, payload, { 'Content-Disposition': 'attachment; filename="orionchatv3-export.json"' });
  },

  // ---- import a conversation from JSON (accepts this app's export shape) ----
  'POST /api/conversations/import': async (req, res) => {
    const u = requireAuth(req);
    const b = await readBody(req);
    const msgs = Array.isArray(b.messages) ? b.messages : [];
    if (!msgs.length) throw { status: 400, error: 'messages array required' };
    if (msgs.length > 500) throw { status: 400, error: 'Too many messages (500 max per import)' };
    const title = String(b.title || 'Imported chat').slice(0, 120);
    const r = db.prepare('INSERT INTO conversations (user_id, title) VALUES (?,?)').run(u.id, title);
    const convId = Number(r.lastInsertRowid);
    const ins = db.prepare('INSERT INTO messages (conv_id, role, content) VALUES (?,?,?)');
    let n = 0;
    for (const m of msgs) {
      if ((m.role === 'user' || m.role === 'assistant') && String(m.content ?? '').trim()) {
        ins.run(convId, m.role, String(m.content).slice(0, 32000));
        if (++n >= 500) break;
      }
    }
    send(res, 200, { conversation_id: convId, imported: n });
  },

  // ---- star (bookmark) a message for quick access later ----
  'PUT /api/messages/star': async (req, res) => {
    const u = requireAuth(req);
    const b = await readBody(req);
    const msg = db.prepare(`SELECT m.id FROM messages m JOIN conversations c ON c.id=m.conv_id
                            WHERE m.id=? AND c.user_id=?`).get(b.id, u.id);
    if (!msg) throw { status: 404, error: 'Message not found' };
    db.prepare('UPDATE messages SET starred=? WHERE id=?').run(b.starred ? 1 : 0, msg.id);
    send(res, 200, { ok: true });
  },
  'GET /api/me/starred': async (req, res) => {
    const u = requireAuth(req);
    send(res, 200, db.prepare(`SELECT m.id, m.content, m.role, m.conv_id, m.created_at, c.title FROM messages m
                               JOIN conversations c ON c.id=m.conv_id
                               WHERE c.user_id=? AND m.starred=1 ORDER BY m.id DESC LIMIT 100`).all(u.id));
  },

  // ---- conversation organization: pin / archive ----
  'PUT /api/conversation/flags': async (req, res) => {
    const u = requireAuth(req);
    const b = await readBody(req);
    const conv = db.prepare('SELECT * FROM conversations WHERE id=? AND user_id=?').get(b.id, u.id);
    if (!conv) throw { status: 404, error: 'Conversation not found' };
    if (b.pinned !== undefined) db.prepare('UPDATE conversations SET pinned=? WHERE id=?').run(b.pinned ? 1 : 0, conv.id);
    if (b.archived !== undefined) {
      // archiving also unpins — pinned + archived together makes no sense
      db.prepare('UPDATE conversations SET archived=?, pinned=CASE WHEN ?=1 THEN 0 ELSE pinned END WHERE id=?')
        .run(b.archived ? 1 : 0, b.archived ? 1 : 0, conv.id);
    }
    send(res, 200, { ok: true });
  },

  // wipe a conversation's messages but keep the chat itself (and its settings)
  'POST /api/conversations/clear': async (req, res) => {
    const u = requireAuth(req);
    const b = await readBody(req);
    const conv = db.prepare('SELECT * FROM conversations WHERE id=? AND user_id=?').get(b.id, u.id);
    if (!conv) throw { status: 404, error: 'Conversation not found' };
    db.prepare('DELETE FROM messages WHERE conv_id=?').run(conv.id);
    send(res, 200, { ok: true });
  },

  // full-text-ish search across the user's conversations; multiple terms are
  // combined with AND (every term must appear somewhere in the message)
  'GET /api/search': async (req, res, url) => {
    const u = requireAuth(req);
    const q = String(url.searchParams.get('q') || '').trim();
    const terms = q.split(/\s+/).filter((t) => t.length >= 2).slice(0, 5);
    if (!terms.length) return send(res, 200, []);
    const like = (s) => '%' + s.replace(/[\\%_]/g, (ch) => '\\' + ch) + '%';
    const conds = terms.map(() => `m.content LIKE ? ESCAPE '\\'`).join(' AND ');
    const rows = db.prepare(`
      SELECT m.id, m.conv_id, m.role, m.content, m.created_at, c.title,
        (SELECT COUNT(*) FROM messages w WHERE w.conv_id = m.conv_id AND w.id <= m.id) AS position
      FROM messages m JOIN conversations c ON c.id = m.conv_id
      WHERE c.user_id=? AND m.role IN ('user','assistant') AND (${conds})
      ORDER BY m.id DESC LIMIT 40`).all(u.id, ...terms.map(like));
    // trim each match to a short window around the first hit so the UI stays readable
    send(res, 200, rows.map((r) => {
      const lower = r.content.toLowerCase();
      const idx = Math.min(...terms.map((t) => {
        const i = lower.indexOf(t.toLowerCase());
        return i === -1 ? 0 : i;
      }));
      const start = Math.max(0, idx - 60);
      r.snippet = (start > 0 ? '…' : '') + r.content.slice(start, idx + q.length + 90).trim() + '…';
      return r;
    }));
  },

  // fork: copy a conversation (optionally truncated at a message) into a new one
  'POST /api/conversations/fork': async (req, res) => {
    const u = requireAuth(req);
    const b = await readBody(req);
    const src = db.prepare('SELECT * FROM conversations WHERE id=? AND user_id=?').get(b.id, u.id);
    if (!src) throw { status: 404, error: 'Conversation not found' };
    const upto = b.message_id
      ? db.prepare('SELECT id FROM messages WHERE id=? AND conv_id=?').get(b.message_id, src.id)?.id
      : null;
    const r = db.prepare(`INSERT INTO conversations (user_id, title, provider_id, user_provider_id, project_id, system_prompt, temperature, private)
                          VALUES (?,?,?,?,?,?,?,?)`)
      .run(u.id, `Fork: ${src.title}`.slice(0, 120), src.provider_id, src.user_provider_id, src.project_id, src.system_prompt, src.temperature, src.private);
    const newId = Number(r.lastInsertRowid);
    if (upto) {
      db.prepare(`INSERT INTO messages (conv_id, role, content, tool_name, model, prompt_tokens, completion_tokens, created_at)
                  SELECT ?, role, content, tool_name, model, prompt_tokens, completion_tokens, created_at
                  FROM messages WHERE conv_id=? AND id<=? ORDER BY id`).run(newId, src.id, upto);
    }
    send(res, 200, { conversation_id: newId });
  },

  // edit your own messages. User messages truncate everything after (the client
  // regenerates); assistant messages can be corrected in place.
  'PUT /api/messages': async (req, res) => {
    const u = requireAuth(req);
    const b = await readBody(req);
    const msg = db.prepare(`
      SELECT m.* FROM messages m JOIN conversations c ON c.id = m.conv_id
      WHERE m.id=? AND c.user_id=?`).get(b.id, u.id);
    if (!msg) throw { status: 404, error: 'Message not found' };
    if (msg.role !== 'user' && msg.role !== 'assistant') throw { status: 400, error: 'Only user or assistant messages can be edited' };
    const content = String(b.content ?? '').trim();
    if (!content) throw { status: 400, error: 'Content required' };
    db.prepare('UPDATE messages SET content=? WHERE id=?').run(content.slice(0, 32000), msg.id);
    if (msg.role === 'user') {
      db.prepare('DELETE FROM messages WHERE conv_id=? AND id>?').run(msg.conv_id, msg.id);
    }
    send(res, 200, { ok: true, conversation_id: msg.conv_id, truncated: msg.role === 'user' });
  },

  // ---- prompt library (per user, usable as /commands in the composer) ----
  'GET /api/prompts': async (req, res) => {
    const u = requireAuth(req);
    send(res, 200, db.prepare('SELECT * FROM prompts WHERE user_id=? ORDER BY name').all(u.id));
  },
  'POST /api/prompts': async (req, res) => {
    const u = requireAuth(req);
    const b = await readBody(req);
    const name = String(b.name || '').trim().replace(/\s+/g, '_').slice(0, 40);
    const content = String(b.content || '').trim();
    if (!name || !content) throw { status: 400, error: 'Name and content required' };
    if (db.prepare('SELECT 1 FROM prompts WHERE user_id=? AND name=?').get(u.id, name)) throw { status: 409, error: 'A prompt with that name exists' };
    const r = db.prepare('INSERT INTO prompts (user_id, name, content) VALUES (?,?,?)').run(u.id, name, content.slice(0, 8000));
    send(res, 200, db.prepare('SELECT * FROM prompts WHERE id=?').get(r.lastInsertRowid));
  },
  'PUT /api/prompts': async (req, res) => {
    const u = requireAuth(req);
    const b = await readBody(req);
    const row = db.prepare('SELECT * FROM prompts WHERE id=? AND user_id=?').get(b.id, u.id);
    if (!row) throw { status: 404, error: 'Prompt not found' };
    db.prepare('UPDATE prompts SET name=?, content=? WHERE id=?')
      .run(String(b.name || row.name).trim().slice(0, 40), String(b.content ?? row.content).trim().slice(0, 8000), row.id);
    send(res, 200, { ok: true });
  },
  'DELETE /api/prompts': async (req, res, url) => {
    const u = requireAuth(req);
    db.prepare('DELETE FROM prompts WHERE id=? AND user_id=?').run(url.searchParams.get('id'), u.id);
    send(res, 200, { ok: true });
  },

  // ---- public health probe (no auth; safe counters only) ----
  'GET /api/health': async (req, res) => {
    send(res, 200, {
      ok: true,
      version: APP_VERSION,
      uptime_s: Math.round(process.uptime()),
      users: db.prepare('SELECT COUNT(*) c FROM users').get().c,
      conversations: db.prepare('SELECT COUNT(*) c FROM conversations').get().c,
      messages: db.prepare('SELECT COUNT(*) c FROM messages').get().c,
      documents: db.prepare('SELECT COUNT(*) c FROM documents').get().c,
    });
  },

  // ---- per-conversation persona + sampling ----
  'PUT /api/conversation/settings': async (req, res) => {
    const u = requireAuth(req);
    const b = await readBody(req);
    const conv = db.prepare('SELECT * FROM conversations WHERE id=? AND user_id=?').get(b.id, u.id);
    if (!conv) throw { status: 404, error: 'Conversation not found' };
    const systemPrompt = String(b.system_prompt ?? conv.system_prompt ?? '').slice(0, 4000);
    let temperature = conv.temperature;
    if (b.temperature !== undefined) {
      temperature = b.temperature === null || b.temperature === '' ? null : Math.min(2, Math.max(0, Number(b.temperature)));
      if (Number.isNaN(temperature)) temperature = null;
    }
    db.prepare('UPDATE conversations SET system_prompt=?, temperature=? WHERE id=?').run(systemPrompt, temperature, conv.id);
    if (b.private !== undefined) {
      db.prepare('UPDATE conversations SET private=? WHERE id=?').run(b.private ? 1 : 0, conv.id);
    }
    if (b.project_id !== undefined) {
      // null detaches from any project; otherwise it must be one of the user's projects
      if (b.project_id === null) {
        db.prepare('UPDATE conversations SET project_id=NULL WHERE id=?').run(conv.id);
      } else {
        const proj = db.prepare('SELECT id FROM projects WHERE id=? AND user_id=?').get(b.project_id, u.id);
        if (!proj) throw { status: 400, error: 'Unknown project' };
        db.prepare('UPDATE conversations SET project_id=? WHERE id=?').run(proj.id, conv.id);
      }
    }
    send(res, 200, { ok: true });
  },

  // ---- share links (read-only transcript pages) ----
  'POST /api/conversations/share': async (req, res) => {
    const u = requireAuth(req);
    const b = await readBody(req);
    const conv = db.prepare('SELECT * FROM conversations WHERE id=? AND user_id=?').get(b.id, u.id);
    if (!conv) throw { status: 404, error: 'Conversation not found' };
    let token = db.prepare('SELECT token FROM shares WHERE conv_id=?').get(conv.id)?.token;
    if (!token) {
      token = randomBytes(16).toString('hex');
      db.prepare('INSERT INTO shares (token, conv_id) VALUES (?,?)').run(token, conv.id);
      audit(u.id, u.username, 'share_created', conv.title);
    }
    send(res, 200, { url: `/share/${token}` });
  },
  'DELETE /api/conversations/share': async (req, res, url) => {
    const u = requireAuth(req);
    const id = Number(url.searchParams.get('id'));
    const conv = db.prepare('SELECT * FROM conversations WHERE id=? AND user_id=?').get(id, u.id);
    if (!conv) throw { status: 404, error: 'Conversation not found' };
    db.prepare('DELETE FROM shares WHERE conv_id=?').run(conv.id);
    audit(u.id, u.username, 'share_revoked', conv.title);
    send(res, 200, { ok: true });
  },

  // ---- announcements (admin broadcasts; latest unexpired one is active) ----
  'GET /api/announcements': async (req, res) => {
    requireAuth(req);
    const row = db.prepare(`SELECT * FROM announcements
                            WHERE expires_at IS NULL OR expires_at > datetime('now')
                            ORDER BY id DESC LIMIT 1`).get();
    send(res, 200, row || null);
  },
  'POST /api/admin/announce': async (req, res) => {
    const me = requireAdmin(req);
    const b = await readBody(req);
    const text = String(b.text || '').trim().slice(0, 500);
    const severity = ['info', 'warn', 'critical'].includes(b.severity) ? b.severity : 'info';
    const hours = Number(b.expires_hours) > 0 ? Math.min(720, Number(b.expires_hours)) : null;
    db.prepare('DELETE FROM announcements').run();
    if (text) {
      db.prepare(`INSERT INTO announcements (text, severity, expires_at) VALUES (?, ?, ${hours ? `datetime('now', '+${hours} hours')` : 'NULL'})`)
        .run(text, severity);
    }
    if (text) audit(me.id, me.username, 'announcement', `${severity}: ${text.slice(0, 80)}`);
    send(res, 200, { ok: true });
  },

  // ---- a user's own usage numbers ----
  'GET /api/me/stats': async (req, res) => {
    const u = requireAuth(req);
    // estimate spend from per-provider $/Mtok prices when admins filled them in;
    // messages are matched to providers by model name
    const pricing = new Map();
    for (const p of db.prepare('SELECT model, price_in, price_out FROM providers WHERE price_in IS NOT NULL OR price_out IS NOT NULL').all()) {
      pricing.set(p.model, { in: Number(p.price_in) || 0, out: Number(p.price_out) || 0 });
    }
    let cost = 0;
    for (const m of db.prepare(`SELECT m.model, m.prompt_tokens, m.completion_tokens FROM messages m
                                JOIN conversations c ON c.id=m.conv_id
                                WHERE c.user_id=? AND m.role='assistant' AND m.model != ''`).all(u.id)) {
      const p = pricing.get(m.model);
      if (p) cost += (m.prompt_tokens * p.in + m.completion_tokens * p.out) / 1e6;
    }
    send(res, 200, {
      conversations: db.prepare('SELECT COUNT(*) c FROM conversations WHERE user_id=?').get(u.id).c,
      messages: db.prepare(`SELECT COUNT(*) c FROM messages m JOIN conversations c ON c.id=m.conv_id
                            WHERE c.user_id=? AND m.role IN ('user','assistant')`).get(u.id).c,
      tokens: db.prepare(`SELECT COALESCE(SUM(m.prompt_tokens),0) AS prompt, COALESCE(SUM(m.completion_tokens),0) AS completion
                          FROM messages m JOIN conversations c ON c.id=m.conv_id WHERE c.user_id=?`).get(u.id),
      est_cost_usd: Math.round(cost * 10000) / 10000,
      quota: quotaInfo(u),
      starred: db.prepare(`SELECT COUNT(*) c FROM messages m JOIN conversations c ON c.id=m.conv_id
                           WHERE c.user_id=? AND m.starred=1`).get(u.id).c,
      tool_uses: db.prepare(`SELECT m.tool_name AS tool, COUNT(*) AS count FROM messages m
                             JOIN conversations c ON c.id=m.conv_id
                             WHERE c.user_id=? AND m.role='tool_event' AND m.tool_name IS NOT NULL
                             GROUP BY m.tool_name ORDER BY count DESC LIMIT 8`).all(u.id),
      daily: db.prepare(`SELECT date(m.created_at) AS day, COUNT(*) AS count FROM messages m
                         JOIN conversations c ON c.id=m.conv_id
                         WHERE c.user_id=? AND m.created_at > datetime('now','-14 days')
                         GROUP BY day ORDER BY day`).all(u.id),
    });
  },

  // ---- attachments (small text files riding along every turn) ----
  'GET /api/conversations/attachments': async (req, res, url) => {
    const u = requireAuth(req);
    const conv = db.prepare('SELECT * FROM conversations WHERE id=? AND user_id=?').get(url.searchParams.get('conv_id'), u.id);
    if (!conv) throw { status: 404, error: 'Conversation not found' };
    send(res, 200, db.prepare('SELECT id, name, length(content) AS bytes, created_at FROM attachments WHERE conv_id=? ORDER BY id DESC').all(conv.id));
  },
  'POST /api/conversations/attachments': async (req, res) => {
    const u = requireAuth(req);
    const b = await readBody(req);
    let convId = b.conversation_id ?? null;
    if (convId) {
      const conv = db.prepare('SELECT * FROM conversations WHERE id=? AND user_id=?').get(convId, u.id);
      if (!conv) throw { status: 404, error: 'Conversation not found' };
    } else {
      const r = db.prepare('INSERT INTO conversations (user_id, title) VALUES (?,?)').run(u.id, b.name || 'Files');
      convId = Number(r.lastInsertRowid);
    }
    const content = String(b.content || '');
    const mime = String(b.mime || 'text/plain');
    const isImage = /^image\/(png|jpeg|gif|webp)$/.test(mime);
    if (isImage) {
      // images are stored as data URLs and ride along as vision input
      if (!/^data:image\/(png|jpeg|gif|webp);base64,/.test(content)) {
        throw { status: 400, error: 'Images must be base64 data URLs (png, jpeg, gif, webp)' };
      }
      if (content.length > 3_500_000) throw { status: 400, error: 'Image too large (~2.5 MB limit)' };
    } else {
      if (!content.trim()) throw { status: 400, error: 'File is empty (binary files are not supported)' };
      if (content.length > 200000) throw { status: 400, error: 'File too large (200 KB text limit)' };
    }
    const name = String(b.name || (isImage ? 'image.png' : 'file.txt')).replace(/[^\w .-]/g, '_').slice(0, 80);
    const r = db.prepare('INSERT INTO attachments (conv_id, name, content, mime) VALUES (?,?,?,?)').run(convId, name, content, isImage ? mime : 'text/plain');
    send(res, 200, { id: Number(r.lastInsertRowid), conversation_id: convId, name, mime: isImage ? mime : 'text/plain' });
  },
  'DELETE /api/conversations/attachments': async (req, res, url) => {
    const u = requireAuth(req);
    const row = db.prepare(`SELECT a.id FROM attachments a JOIN conversations c ON c.id=a.conv_id
                            WHERE a.id=? AND c.user_id=?`).get(url.searchParams.get('id'), u.id);
    if (row) db.prepare('DELETE FROM attachments WHERE id=?').run(row.id);
    send(res, 200, { ok: true });
  },

  // ---- admin ----
  'GET /api/admin/overview': async (req, res) => {
    requireAdmin(req);
    send(res, 200, {
      presets: PRESETS,
      providers: db.prepare('SELECT * FROM providers').all(),
      mcp_servers: db.prepare('SELECT * FROM mcp_servers').all().map((m) => {
        const hit = mcpCache.get(m.id);
        const fresh = hit && hit.key === mcpKey(m);
        return {
          ...m,
          tools: fresh && !hit.error ? cachedMcpTools(m) : [],
          extras: fresh && !hit.error ? (hit.extras || { resources: [], prompts: [] }) : { resources: [], prompts: [] },
          state_error: fresh ? hit.error : null,
        };
      }),
      builtin_tools: Object.keys(BUILTIN_TOOLS).map((id) => ({ id, enabled: toolEnabled(id), description: BUILTIN_TOOLS[id].description })),
      settings: allSettings(),
      users: db.prepare(`SELECT u.id, u.username, u.display_name, u.avatar_color, u.role, u.api_key, u.memory_allowed, u.memory_enabled, u.totp_enabled, u.quota_override, u.created_at,
          (SELECT MAX(m.created_at) FROM messages m JOIN conversations c2 ON c2.id=m.conv_id WHERE c2.user_id=u.id) AS last_activity,
          (SELECT COUNT(*) FROM documents d WHERE d.user_id=u.id) AS documents,
          (SELECT COUNT(*) FROM user_mcp um WHERE um.user_id=u.id) AS mcp_servers,
          (SELECT COUNT(*) FROM user_providers up WHERE up.user_id=u.id) AS providers
        FROM users u ORDER BY u.id`).all(),
      counts: {
        conversations: db.prepare('SELECT COUNT(*) c FROM conversations').get().c,
        messages: db.prepare('SELECT COUNT(*) c FROM messages').get().c,
        memories: db.prepare('SELECT COUNT(*) c FROM memories').get().c,
        documents: db.prepare('SELECT COUNT(*) c FROM documents').get().c,
        tasks_pending: db.prepare(`SELECT COUNT(*) c FROM scheduled_tasks WHERE status='pending'`).get().c,
        shares: db.prepare('SELECT COUNT(*) c FROM shares').get().c,
      },
      stats: {
        daily: db.prepare(`SELECT date(created_at) AS day, COUNT(*) AS count FROM messages
                           WHERE created_at > datetime('now', '-14 days') GROUP BY day ORDER BY day`).all(),
        per_user: db.prepare(`SELECT u.username, COUNT(m.id) AS messages FROM messages m
                              JOIN conversations cv ON m.conv_id = cv.id
                              JOIN users u ON cv.user_id = u.id
                              GROUP BY u.username ORDER BY messages DESC LIMIT 10`).all(),
        tool_uses: db.prepare(`SELECT tool_name, COUNT(*) AS count FROM messages
                               WHERE role='tool_event' AND tool_name IS NOT NULL
                               GROUP BY tool_name ORDER BY count DESC LIMIT 10`).all(),
        tokens: db.prepare('SELECT COALESCE(SUM(prompt_tokens),0) AS prompt, COALESCE(SUM(completion_tokens),0) AS completion FROM messages').get(),
        audit_summary: db.prepare(`SELECT action, COUNT(*) AS count FROM audit_log
                                   WHERE created_at > datetime('now','-7 days')
                                   GROUP BY action ORDER BY count DESC LIMIT 12`).all(),
      },
    });
  },
  'PUT /api/admin/settings': async (req, res) => {
    const me = requireAdmin(req);
    const b = await readBody(req);
    const changed = [];
    for (const key of Object.keys(SETTING_DEFAULTS)) {
      if (b[key] === undefined) continue;
      setSetting(key, ['max_user_mcp', 'max_user_providers', 'max_documents', 'daily_message_limit', 'session_days'].includes(key)
        ? String(Math.min(100000, Math.max(0, Number(b[key]) || 0))) : (b[key] ? '1' : '0'));
      changed.push(`${key}=${b[key]}`);
    }
    audit(me.id, me.username, 'settings_changed', changed.join(', '));
    send(res, 200, allSettings());
  },
  'GET /api/admin/export': async (req, res, url) => {
    requireAdmin(req);
    const dump = (sql) => db.prepare(sql).all();
    send(res, 200, {
      exported_at: new Date().toISOString(),
      users: dump('SELECT id, username, role, api_key, instructions, created_at FROM users'),
      providers: dump('SELECT * FROM providers'),
      mcp_servers: dump('SELECT id, name, kind, command, args, env, url, headers, enabled FROM mcp_servers'),
      tool_settings: dump('SELECT * FROM tool_settings'),
      conversations: dump('SELECT * FROM conversations'),
      messages: dump('SELECT * FROM messages'),
      memories: dump('SELECT * FROM memories'),
    });
  },
  'POST /api/admin/providers': async (req, res) => {
    const me = requireAdmin(req);
    const b = await readBody(req);
    const priceIn = b.price_in === '' || b.price_in == null ? null : Number(b.price_in);
    const priceOut = b.price_out === '' || b.price_out == null ? null : Number(b.price_out);
    if (b.id) {
      db.prepare('UPDATE providers SET name=?, kind=?, base_url=?, api_key=?, model=?, enabled=?, price_in=?, price_out=? WHERE id=?')
        .run(b.name, b.kind, b.base_url, b.api_key, b.model, b.enabled ? 1 : 0, priceIn, priceOut, b.id);
      audit(me.id, me.username, 'provider_updated', String(b.name));
      send(res, 200, db.prepare('SELECT * FROM providers WHERE id=?').get(b.id));
    } else {
      const r = db.prepare('INSERT INTO providers (name, kind, base_url, api_key, model, enabled, price_in, price_out) VALUES (?,?,?,?,?,?,?,?)')
        .run(b.name, b.kind, b.base_url, b.api_key || '', b.model, 1, priceIn, priceOut);
      audit(me.id, me.username, 'provider_added', String(b.name));
      send(res, 200, db.prepare('SELECT * FROM providers WHERE id=?').get(r.lastInsertRowid));
    }
  },
  'DELETE /api/admin/providers': async (req, res, url) => {
    const me = requireAdmin(req);
    db.prepare('DELETE FROM providers WHERE id=?').run(url.searchParams.get('id'));
    audit(me.id, me.username, 'provider_removed', `id=${url.searchParams.get('id')}`);
    send(res, 200, { ok: true });
  },
  'POST /api/admin/mcp_servers': async (req, res) => {
    requireAdmin(req);
    const b = await readBody(req);
    const cfg = parseMcpConfig(b);
    if (b.id) {
      db.prepare('UPDATE mcp_servers SET name=?, kind=?, command=?, args=?, env=?, url=?, headers=?, enabled=? WHERE id=?')
        .run(cfg.name, cfg.kind, cfg.command, cfg.args, cfg.env, cfg.url, cfg.headers, b.enabled ? 1 : 0, b.id);
    } else {
      db.prepare('INSERT INTO mcp_servers (name, kind, command, args, env, url, headers, enabled) VALUES (?,?,?,?,?,?,?,1)')
        .run(cfg.name, cfg.kind, cfg.command, cfg.args, cfg.env, cfg.url, cfg.headers);
    }
    evictMcp(b.id); // config changed or new — drop any cached connection
    send(res, 200, { ok: true });
  },
  'DELETE /api/admin/mcp_servers': async (req, res, url) => {
    requireAdmin(req);
    const id = Number(url.searchParams.get('id'));
    db.prepare('DELETE FROM mcp_servers WHERE id=?').run(id);
    evictMcp(id);
    send(res, 200, { ok: true });
  },
  'POST /api/admin/mcp_test': async (req, res) => {
    requireAdmin(req);
    return testMcpConnection(req, res);
  },
  'POST /api/admin/mcp_restart': async (req, res) => {
    requireAdmin(req);
    const b = await readBody(req);
    const row = db.prepare('SELECT * FROM mcp_servers WHERE id=?').get(b.id);
    if (!row) throw { status: 404, error: 'Not found' };
    evictMcp(row.id);
    const entry = await getMcpEntry(row);
    send(res, 200, { ok: !entry.error, error: entry.error, tools: entry.tools.map((t) => t.name) });
  },
  'POST /api/admin/provider_test': async (req, res) => {
    requireAdmin(req);
    const b = await readBody(req);
    const provider = b.id
      ? db.prepare('SELECT * FROM providers WHERE id=?').get(b.id)
      : { name: b.name || 'test', kind: b.kind || 'openai', base_url: b.base_url, api_key: b.api_key || '', model: b.model };
    if (!provider || !provider.base_url || !provider.model) throw { status: 400, error: 'Provider needs base_url and model' };
    const t0 = Date.now();
    try {
      await callModel(provider, [{ role: 'user', content: 'Say OK.' }]);
      send(res, 200, { ok: true, ms: Date.now() - t0 });
    } catch (e) {
      send(res, 200, { ok: false, error: e.message, ms: Date.now() - t0 });
    }
  },
  'POST /api/admin/tool_settings': async (req, res) => {
    requireAdmin(req);
    const b = await readBody(req);
    db.prepare(`INSERT INTO tool_settings (tool_id, enabled) VALUES (?,?)
                ON CONFLICT(tool_id) DO UPDATE SET enabled=excluded.enabled`).run(b.tool_id, b.enabled ? 1 : 0);
    send(res, 200, { ok: true });
  },
  'POST /api/admin/users': async (req, res) => {
    const me = requireAdmin(req);
    const b = await readBody(req);
    const self = Number(b.id) === me.id;
    if (b.action === 'create') {
      const username = String(b.username || '').trim();
      if (!username || !b.password || b.password.length < 4) throw { status: 400, error: 'Username and password (min 4 chars) required' };
      if (!/^[A-Za-z0-9_-]{3,32}$/.test(username)) throw { status: 400, error: 'Username must be 3-32 chars: letters, numbers, _ or -' };
      if (db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) throw { status: 409, error: 'Username taken' };
      const u = newUser(username, b.password);
      if (b.role === 'admin' || b.role === 'user') db.prepare('UPDATE users SET role=? WHERE id=?').run(b.role, u.id);
      audit(me.id, me.username, 'user_created', `${username} (${b.role === 'admin' ? 'admin' : 'user'})`);
      return send(res, 200, db.prepare('SELECT id, username, role FROM users WHERE id=?').get(u.id));
    }
    if (b.action === 'set_role') {
      if (self && b.role !== 'admin') throw { status: 400, error: "You can't demote yourself" };
      db.prepare('UPDATE users SET role=? WHERE id=?').run(b.role, b.id);
      audit(me.id, me.username, 'role_changed', `user ${b.id} → ${b.role}`);
    } else if (b.action === 'set_memory') {
      if (self && !b.allowed) throw { status: 400, error: "You can't block your own memory access" };
      db.prepare('UPDATE users SET memory_allowed=? WHERE id=?').run(b.allowed ? 1 : 0, b.id);
      audit(me.id, me.username, 'memory_access', `user ${b.id} → ${b.allowed ? 'allowed' : 'blocked'}`);
    } else if (b.action === 'rotate_key') {
      db.prepare('UPDATE users SET api_key=? WHERE id=?').run('oc_' + randomBytes(24).toString('hex'), b.id);
      audit(me.id, me.username, 'key_rotated', `user ${b.id}`);
    } else if (b.action === 'impersonate') {
      // support tool: the admin's browser is signed in as the target user.
      // The admin's own session stays alive in the DB but the cookie is
      // replaced, so returning means logging in again. Always audited.
      if (self) throw { status: 400, error: "You're already yourself" };
      const target = db.prepare('SELECT id, username FROM users WHERE id=?').get(b.id);
      if (!target) throw { status: 404, error: 'User not found' };
      audit(me.id, me.username, 'impersonate', `as ${target.username} (user ${target.id})`);
      const token = startSession(target.id);
      return send(res, 200, { ok: true, username: target.username }, { 'Set-Cookie': COOKIE(token) });
    } else if (b.action === 'set_password') {
      if (!b.password || b.password.length < 4) throw { status: 400, error: 'Password must be at least 4 chars' };
      setPassword(b.id, b.password);
      audit(me.id, me.username, 'password_reset', `user ${b.id}`);
    } else if (b.action === 'logout_everywhere') {
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(b.id);
      audit(me.id, me.username, 'force_logout', `user ${b.id}`);
    } else if (b.action === 'set_quota') {
      // -2 = follow the global default, -1 = unlimited, n = custom daily limit
      const q = Math.trunc(Number(b.quota));
      if (![-2, -1].includes(q) && !(q >= 0)) throw { status: 400, error: 'Quota must be -2 (global), -1 (unlimited) or a number' };
      db.prepare('UPDATE users SET quota_override=? WHERE id=?').run(q, b.id);
      audit(me.id, me.username, 'quota_set', `user ${b.id} → ${q === -2 ? 'global' : q === -1 ? 'unlimited' : q + '/day'}`);
    } else if (b.action === 'delete') {
      if (self) throw { status: 400, error: "You can't delete yourself" };
      deleteUserData(b.id);
      audit(me.id, me.username, 'user_deleted', `user ${b.id}`);
    } else throw { status: 400, error: 'Unknown action' };
    send(res, 200, { ok: true });
  },

  // ---- self-service account deletion (GDPR-style "right to erasure") ----
  'POST /api/account/delete': async (req, res) => {
    const u = requireAuth(req);
    const b = await readBody(req);
    if (!checkPassword(u, b.password || '')) throw { status: 403, error: 'Enter your password to confirm deletion' };
    const name = u.username;
    deleteUserData(u.id);
    audit(null, name, 'account_selfdeleted');
    send(res, 200, { ok: true }, { 'Set-Cookie': 'session=; Path=/; Max-Age=0' });
  },
  // ---- live system vitals for ops ----
  'GET /api/admin/system': async (req, res) => {
    requireAdmin(req);
    const mem = process.memoryUsage();
    const dbPages = db.prepare('PRAGMA page_count').get().page_count;
    const pageSize = db.prepare('PRAGMA page_size').get().page_size;
    send(res, 200, {
      version: APP_VERSION,
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      uptime_s: Math.round(process.uptime()),
      rss_mb: Math.round(mem.rss / 1048576),
      heap_mb: Math.round(mem.heapUsed / 1048576),
      db_size_mb: Math.round((dbPages * pageSize) / 1048576 * 100) / 100,
      sessions_active: db.prepare('SELECT COUNT(*) c FROM sessions').get().c,
      mcp_connections: [...mcpCache.entries()].map(([id, e]) => ({
        id: String(id), ok: !e.error, error: e.error || null, tools: e.tools.length,
      })),
      tasks_pending: db.prepare(`SELECT COUNT(*) c FROM scheduled_tasks WHERE status='pending'`).get().c,
      documents: db.prepare('SELECT COUNT(*) c FROM documents').get().c,
      providers_enabled: db.prepare('SELECT COUNT(*) c FROM providers WHERE enabled=1').get().c,
      shares_active: db.prepare('SELECT COUNT(*) c FROM shares').get().c,
    });
  },

  // ---- database backups: dump to data/backups/, list, download, delete ----
  'POST /api/admin/backup': async (req, res) => {
    const me = requireAdmin(req);
    const dir = path.join(DATA_DIR, 'backups');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const dump = (sql) => db.prepare(sql).all();
    const payload = {
      exported_at: new Date().toISOString(),
      users: dump('SELECT id, username, role, api_key, instructions, created_at FROM users'),
      providers: dump('SELECT * FROM providers'),
      mcp_servers: dump('SELECT id, name, kind, command, args, env, url, headers, enabled FROM mcp_servers'),
      tool_settings: dump('SELECT * FROM tool_settings'),
      conversations: dump('SELECT * FROM conversations'),
      messages: dump('SELECT * FROM messages'),
      memories: dump('SELECT * FROM memories'),
      documents: dump('SELECT * FROM documents'),
      app_settings: dump('SELECT * FROM app_settings'),
    };
    const name = `backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    writeFileSync(path.join(dir, name), JSON.stringify(payload, null, 2));
    // keep the 10 most recent backups
    const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort().reverse();
    for (const old of files.slice(10)) { try { unlinkSync(path.join(dir, old)); } catch {} }
    audit(me.id, me.username, 'backup_created', name);
    send(res, 200, { ok: true, file: name, kept: Math.min(10, files.length) });
  },
  'GET /api/admin/backup': async (req, res) => {
    requireAdmin(req);
    const dir = path.join(DATA_DIR, 'backups');
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort().reverse() : [];
    send(res, 200, files.map((f) => {
      const st = statSync(path.join(dir, f));
      return { name: f, bytes: st.size, created_at: st.mtime.toISOString() };
    }));
  },
  'GET /api/admin/backup/download': async (req, res, url) => {
    requireAdmin(req);
    const name = String(url.searchParams.get('name') || '');
    if (!/^backup-[\w:-]+\.json$/.test(name)) throw { status: 400, error: 'Bad backup name' };
    const fp = path.join(DATA_DIR, 'backups', name);
    if (!existsSync(fp)) throw { status: 404, error: 'Backup not found' };
    send(res, 200, readFileSync(fp, 'utf8'), {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="${name}"`,
    });
  },
  'DELETE /api/admin/backup': async (req, res, url) => {
    const me = requireAdmin(req);
    const name = String(url.searchParams.get('name') || '');
    if (!/^backup-[\w:-]+\.json$/.test(name)) throw { status: 400, error: 'Bad backup name' };
    const fp = path.join(DATA_DIR, 'backups', name);
    if (existsSync(fp)) unlinkSync(fp);
    audit(me.id, me.username, 'backup_deleted', name);
    send(res, 200, { ok: true });
  },

  // ---- update check: compare the running version with the GitHub repo ----
  'GET /api/update/check': async (req, res, url) => {
    requireAdmin(req);
    const ttl = url.searchParams.get('refresh') ? -1 : 3600e3; // cache the GitHub answer for an hour
    if (Date.now() - updateCache.at > ttl) {
      try {
        const r = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/VERSION`, {
          headers: { 'User-Agent': `OrionChatV3/${APP_VERSION}`, Accept: 'application/vnd.github+json' },
          signal: AbortSignal.timeout(10000),
        });
        if (!r.ok) throw new Error(`GitHub HTTP ${r.status}`);
        const j = await r.json();
        const latest = Buffer.from(j.content || '', 'base64').toString('utf8').trim();
        updateCache = { at: Date.now(), latest, error: null };
      } catch (e) {
        updateCache = { at: Date.now(), latest: null, error: e.message };
      }
    }
    send(res, 200, {
      current: APP_VERSION,
      latest: updateCache.latest,
      update_available: updateCache.latest ? isNewerVersion(updateCache.latest, APP_VERSION) : false,
      error: updateCache.error,
      checked_at: updateCache.at ? new Date(updateCache.at).toISOString() : null,
      release_url: `https://github.com/${GITHUB_REPO}`,
    });
  },

  // ---- audit trail + analytics ----
  'GET /api/admin/audit': async (req, res, url) => {
    requireAdmin(req);
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 150));
    const action = String(url.searchParams.get('action') || '').trim();
    const rows = action
      ? db.prepare('SELECT * FROM audit_log WHERE action LIKE ? ORDER BY id DESC LIMIT ?').all(`${action}%`, limit)
      : db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit);
    send(res, 200, rows);
  },
  'GET /api/admin/stats': async (req, res) => {
    requireAdmin(req);
    const q = (sql) => db.prepare(sql).all();
    send(res, 200, {
      messages_daily: q(`SELECT date(created_at) AS day, COUNT(*) AS count FROM messages
        WHERE created_at > datetime('now','-30 days') AND role IN ('user','assistant') GROUP BY day ORDER BY day`),
      tokens_daily: q(`SELECT date(created_at) AS day, SUM(prompt_tokens + completion_tokens) AS tokens FROM messages
        WHERE created_at > datetime('now','-30 days') AND role='assistant' GROUP BY day ORDER BY day`),
      chats_daily: q(`SELECT date(created_at) AS day, COUNT(*) AS count FROM conversations
        WHERE created_at > datetime('now','-30 days') GROUP BY day ORDER BY day`),
      hours: q(`SELECT strftime('%H', created_at) AS hour, COUNT(*) AS count FROM messages
        WHERE created_at > datetime('now','-7 days') AND role IN ('user','assistant') GROUP BY hour ORDER BY hour`),
      models: q(`SELECT model, COUNT(*) AS count, SUM(prompt_tokens + completion_tokens) AS tokens FROM messages
        WHERE role='assistant' AND model != '' GROUP BY model ORDER BY count DESC LIMIT 12`),
      tools: q(`SELECT tool_name, COUNT(*) AS count FROM messages WHERE role='tool_event' AND tool_name IS NOT NULL
        GROUP BY tool_name ORDER BY count DESC LIMIT 12`),
      users: q(`SELECT u.username, u.role, COUNT(DISTINCT c.id) AS chats, COUNT(m.id) AS messages,
        COALESCE(SUM(m.prompt_tokens + m.completion_tokens),0) AS tokens
        FROM users u LEFT JOIN conversations c ON c.user_id=u.id
        LEFT JOIN messages m ON m.conv_id=c.id AND m.role IN ('user','assistant')
        GROUP BY u.id ORDER BY messages DESC LIMIT 25`),
      totals: {
        users: db.prepare('SELECT COUNT(*) c FROM users').get().c,
        chats: db.prepare('SELECT COUNT(*) c FROM conversations').get().c,
        messages: db.prepare("SELECT COUNT(*) c FROM messages WHERE role IN ('user','assistant')").get().c,
        tokens: db.prepare('SELECT COALESCE(SUM(prompt_tokens+completion_tokens),0) t FROM messages').get().t,
        tool_calls: db.prepare("SELECT COUNT(*) c FROM messages WHERE role='tool_event'").get().c,
        shares: db.prepare('SELECT COUNT(*) c FROM shares').get().c,
      },
    });
  },
};

// dynamic routes that need params
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  // conversation messages + delete + export (with optional cursor paging)
  const m = p.match(/^\/api\/conversation\/(\d+)\/messages$/);
  if (m && req.method === 'GET') {
    try {
      const u = requireAuth(req);
      const conv = db.prepare('SELECT * FROM conversations WHERE id=? AND user_id=?').get(Number(m[1]), u.id);
      if (!conv) return send(res, 404, { error: 'Not found' });
      const after = Number(url.searchParams.get('after'));
      const before = Number(url.searchParams.get('before'));
      if (after > 0) {
        // live-tail mode: only rows newer than the cursor (API clients can poll)
        return send(res, 200, db.prepare('SELECT * FROM messages WHERE conv_id=? AND id>? ORDER BY id').all(conv.id, after));
      }
      if (before > 0) {
        // history page: up to 100 rows immediately older than the cursor
        return send(res, 200, db.prepare('SELECT * FROM messages WHERE conv_id=? AND id<? ORDER BY id DESC LIMIT 100').all(conv.id, before).reverse());
      }
      return send(res, 200, db.prepare('SELECT * FROM messages WHERE conv_id=? ORDER BY id').all(conv.id));
    } catch (e) { return send(res, e.status || 500, { error: e.error || e.message }); }
  }
  const mx = p.match(/^\/api\/conversation\/(\d+)\/export$/);
  if (mx && req.method === 'GET') {
    try {
      const u = requireAuth(req);
      const conv = db.prepare('SELECT * FROM conversations WHERE id=? AND user_id=?').get(Number(mx[1]), u.id);
      if (!conv) return send(res, 404, { error: 'Not found' });
      const rows = db.prepare('SELECT * FROM messages WHERE conv_id=? ORDER BY id').all(conv.id);
      const safeName = conv.title.replace(/[^A-Za-z0-9 _-]/g, '').trim() || `conversation-${conv.id}`;
      if (url.searchParams.get('format') === 'json') {
        return send(res, 200, { title: conv.title, created_at: conv.created_at, messages: rows }, {
          'Content-Disposition': `attachment; filename="${safeName}.json"`,
        });
      }
      if (url.searchParams.get('format') === 'html') {
        // styled, self-contained transcript you can open or attach anywhere
        return send(res, 200, sharePageHtml(conv, rows.filter((r) => r.role !== 'tool_event')), {
          'Content-Disposition': `attachment; filename="${safeName}.html"`,
        });
      }
      const md = [
        `# ${conv.title}`, '',
        `> Exported from OrionChatV3 — ${rows.length} messages, started ${conv.created_at}`, '',
        ...rows.map((r) => {
          if (r.role === 'user') return `**You:**\n\n${r.content}\n`;
          if (r.role === 'assistant') return `**Assistant:**\n\n${r.content}\n`;
          if (r.role === 'tool_event') return `> 🔧 \`${r.tool_name}\` → ${String(r.content).slice(0, 300).replace(/\n/g, ' ')}`;
          return null;
        }).filter(Boolean),
      ].join('\n');
      return send(res, 200, md, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="${safeName}.md"`,
      });
    } catch (e) { return send(res, e.status || 500, { error: e.error || e.message }); }
  }
  if (p === '/api/conversations' && req.method === 'DELETE') {
    try {
      const u = requireAuth(req);
      const id = Number(url.searchParams.get('id'));
      const conv = db.prepare('SELECT * FROM conversations WHERE id=? AND user_id=?').get(id, u.id);
      if (conv) {
        db.prepare('DELETE FROM messages WHERE conv_id=?').run(id);
        db.prepare('DELETE FROM conversations WHERE id=?').run(id);
      }
      return send(res, 200, { ok: true });
    } catch (e) { return send(res, e.status || 500, { error: e.error || e.message }); }
  }

  // ---- OpenAI-compatible API: point any OpenAI SDK / tool at OrionChatV3 ----
  if (p === '/v1/models' && req.method === 'GET') {
    try {
      const u = requireAuth(req); // oc_ API keys via Authorization: Bearer work here
      const rows = db.prepare('SELECT id, name, model FROM providers WHERE enabled=1 ORDER BY id').all();
      const mine = db.prepare('SELECT id, name, model FROM user_providers WHERE user_id=? AND enabled=1 ORDER BY id').all(u.id);
      return send(res, 200, {
        object: 'list',
        data: [
          ...rows.map((r) => ({ id: `orion-${r.id}`, object: 'model', created: 0, owned_by: r.name, orion_model: r.model })),
          ...mine.map((r) => ({ id: `orion-u${r.id}`, object: 'model', created: 0, owned_by: r.name, orion_model: r.model, orion_personal: true })),
        ],
      });
    } catch (e) { return send(res, e.status || 500, { error: { message: e.error || e.message } }); }
  }
  if (p === '/v1/chat/completions' && req.method === 'POST') {
    (async () => {
      try {
        const u = requireAuth(req);
        rateLimit(`chat:${u.id}`, 60, 60000);
        checkQuota(u);
        const b = await readBody(req);
        const provider = resolveV1Model(b.model, u);
        if (!provider) throw { status: 400, error: `Unknown model "${b.model}". GET /v1/models lists valid ids.` };
        const messages = Array.isArray(b.messages) ? b.messages : [];
        if (!messages.length) throw { status: 400, error: 'messages array required' };
        const prov = b.temperature != null ? { ...provider, temperature: Number(b.temperature) } : provider;
        const id = 'chatcmpl-' + randomBytes(8).toString('hex');
        const created = Math.floor(Date.now() / 1000);
        if (b.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
          const chunk = (delta, finish) => res.write(`data: ${JSON.stringify({
            id, object: 'chat.completion.chunk', created, model: b.model,
            choices: [{ index: 0, delta, finish_reason: finish ?? null }],
          })}\n\n`);
          chunk({ role: 'assistant' });
          const out = await callModel(prov, messages, b.tools, (t) => chunk({ content: t }));
          if (out.toolCalls.length) {
            chunk({
              tool_calls: out.toolCalls.map((tc, i) => ({ index: i, id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } })),
            }, 'tool_calls');
          } else chunk({}, 'stop');
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          const out = await callModel(prov, messages, b.tools);
          send(res, 200, {
            id, object: 'chat.completion', created, model: b.model,
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: out.content || '',
                ...(out.toolCalls.length ? { tool_calls: out.toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } })) } : {}),
              },
              finish_reason: out.toolCalls.length ? 'tool_calls' : 'stop',
            }],
            ...(out.usage ? { usage: { prompt_tokens: out.usage.prompt, completion_tokens: out.usage.completion, total_tokens: out.usage.prompt + out.usage.completion } } : {}),
          });
        }
      } catch (e) { send(res, e.status || 500, { error: { message: e.error || e.message, type: 'orionchat_error' } }); }
    })();
    return;
  }

  // ---- public read-only share pages ----
  if (p.startsWith('/share/') && req.method === 'GET') {
    const token = p.slice('/share/'.length);
    const share = db.prepare('SELECT * FROM shares WHERE token=?').get(token);
    if (!share) return send(res, 404, 'Share link not found or revoked');
    const conv = db.prepare('SELECT * FROM conversations WHERE id=?').get(share.conv_id);
    const rows = conv ? db.prepare(`SELECT role, content, tool_name, created_at FROM messages
                                    WHERE conv_id=? AND role IN ('user','assistant','tool_event') ORDER BY id`).all(conv.id) : [];
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
    return res.end(sharePageHtml(conv, rows));
  }

  // GET effective tool list (for AI clients)
  if (p === '/api/tools' && req.method === 'GET') {
    (async () => {
      try {
        const u = requireAuth(req);
        const builtins = effectiveBuiltins();
        const mcp = await collectMcp().catch(() => ({ defs: [], executors: new Map() }));
        const umcp = settingOn('allow_user_mcp')
          ? await collectUserMcp(u).catch(() => ({ defs: [], executors: new Map() }))
          : { defs: [] };
        const toolNameToServer = {};
        for (const t of mcp.defs) {
          const m = t.description.match(/^\[([^\]]+)\]/);
          if (m) toolNameToServer[t.name] = m[1];
        }
        send(res, 200, {
          builtin: Object.entries(builtins).map(([name, t]) => ({ name, description: t.description, parameters: t.inputSchema })),
          mcp: mcp.defs.map((t) => ({ name: t.name, server: toolNameToServer[t.name] || null, description: t.description, error: t.name.startsWith('mcp_error_'), parameters: t.inputSchema })),
          user_mcp: umcp.defs.map((t) => ({ name: t.name, description: t.description, error: t.name.startsWith('mcp_error_'), parameters: t.inputSchema })),
        });
      } catch (e) { send(res, e.status || 500, { error: e.error || e.message }); }
    })();
    return;
  }

  route(req, res, url).catch((e) => send(res, 500, { error: e.message }));
});

// ---------- scheduled tasks runner ----------
// Every tick, due pending tasks run their prompt against the configured (or
// first) admin provider and the reply lands in a fresh conversation. The tick
// interval is env-tunable so the test suite can exercise it quickly.
const TASK_TICK_MS = Math.max(100, Number(process.env.ORION_TASK_TICK_MS) || 30000);
function markTask(id, status, note = '', convId = null) {
  db.prepare('UPDATE scheduled_tasks SET status=?, result_note=?, result_conv_id=? WHERE id=?')
    .run(status, String(note).slice(0, 300), convId, id);
}
async function runDueTasks() {
  const due = db.prepare(`SELECT * FROM scheduled_tasks WHERE status='pending'`).all()
    .filter((t) => new Date(t.run_at + (t.run_at.endsWith('Z') ? '' : 'Z')).getTime() <= Date.now());
  for (const t of due) {
    const provider = db.prepare('SELECT * FROM providers WHERE id=? AND enabled=1').get(t.provider_id || 0)
      || db.prepare('SELECT * FROM providers WHERE enabled=1 LIMIT 1').get();
    if (!provider) { markTask(t.id, 'failed', 'No provider available'); continue; }
    try {
      const out = await callModel(provider, [{ role: 'user', content: t.prompt }]);
      const r = db.prepare('INSERT INTO conversations (user_id, title) VALUES (?,?)').run(t.user_id, `⏰ ${t.prompt.slice(0, 60)}`);
      const convId = Number(r.lastInsertRowid);
      db.prepare('INSERT INTO messages (conv_id, role, content) VALUES (?,?,?)').run(convId, 'user', t.prompt);
      db.prepare('INSERT INTO messages (conv_id, role, content, model) VALUES (?,?,?,?)')
        .run(convId, 'assistant', out.content || '(empty response)', provider.model || '');
      markTask(t.id, 'done', String(out.content || ''), convId);
    } catch (e) {
      markTask(t.id, 'failed', e.message);
    }
  }
}
const taskTimer = setInterval(() => { runDueTasks().catch(() => {}); }, TASK_TICK_MS);
if (taskTimer.unref) taskTimer.unref();

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received — closing server, MCP connections and database…`);
  server.close(() => {
    for (const entry of mcpCache.values()) { try { entry.inst.stop(); } catch {} }
    try { db.close(); } catch {}
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

server.listen(PORT, HOST, () => {
  const lan = Object.values(os.networkInterfaces()).flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
  console.log(`OrionChatV3 running at http://${HOST}:${PORT}${lan ? ` (LAN: http://${lan}:${PORT})` : ''} — first registered user becomes admin.`);
});
