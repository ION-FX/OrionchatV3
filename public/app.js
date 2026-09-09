// OrionChatV3 frontend — single-file app, section map:
//   auth · conversations (list/search/projects) · messages (render/star/TTS) ·
//   send (SSE streaming) · providers (shared + personal) · panels (memories,
//   tools, documents, providers, tasks, starred, usage, account) ·
//   admin (providers, MCP, tools, personas, users, system, backups, audit) ·
//   chat settings (persona/temperature/privacy/project) · share/export ·
//   attachments (text + vision images) · prompts & slash commands ·
//   themes · command palette · onboarding tour · PWA
const $ = (id) => document.getElementById(id);
const modal = $('modal');
$('modal-close').onclick = () => modal.classList.add('hidden');
modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });

// ---------- mobile sidebar drawer ----------
const appShell = document.querySelector('.app');
function setDrawer(open) { appShell.classList.toggle('side-open', open); }
$('menu-btn').onclick = () => setDrawer(!appShell.classList.contains('side-open'));
$('side-backdrop').onclick = () => setDrawer(false);
window.addEventListener('resize', () => { if (window.innerWidth > 768) setDrawer(false); });

let me = null, convs = [], activeConv = null, adminData = null;
let authMode = 'login';
let editingProviderId = null;
let userFilter = '';

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- markdown + code blocks (renderer lives in markdown.js) ----------
const md = window.OrionMD.md;
const rawCode = window.OrionMD.rawCode;

// event delegation: copy + live-preview buttons on rendered code blocks
document.addEventListener('click', async (e) => {
  const copyBtn = e.target.closest('.code-copy');
  if (copyBtn) {
    const block = copyBtn.closest('.codeblock');
    try { await navigator.clipboard.writeText(rawCode(block)); copyBtn.textContent = '✓ copied'; }
    catch { copyBtn.textContent = '✕ failed'; }
    setTimeout(() => { copyBtn.textContent = '⧉ copy'; }, 1200);
    return;
  }
  const prevBtn = e.target.closest('.code-preview');
  if (prevBtn) {
    const block = prevBtn.closest('.codeblock');
    openArtifact(rawCode(block), prevBtn.closest('.msg-body')?.querySelector('.who')?.textContent || 'Preview');
  }
});

// ---------- live artifact preview (sandboxed iframe side panel, editable) ----------
const artifactPanel = $('artifact-panel');
const artifactFrame = $('artifact-frame');
const artifactEditor = $('artifact-editor');
let artifactUrl = null;
function openArtifact(code, title = 'Preview') {
  artifactEditor.value = code;
  artifactEditor.classList.add('hidden');
  artifactFrame.classList.remove('hidden');
  runArtifact(code);
  $('artifact-title').textContent = title;
  artifactPanel.classList.remove('hidden');
  document.body.classList.add('artifact-open');
  if (artifactUrl) { URL.revokeObjectURL(artifactUrl); artifactUrl = null; }
}
function runArtifact(code) {
  const isSvg = /^\s*<\?xml|<svg[\s>]/i.test(code);
  const doc = isSvg
    ? `<!DOCTYPE html><html><body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#fff">${code}</body></html>`
    : code;
  artifactFrame.srcdoc = doc;
}
function closeArtifact() {
  artifactPanel.classList.add('hidden');
  document.body.classList.remove('artifact-open');
  artifactFrame.srcdoc = '';
  if (artifactUrl) { URL.revokeObjectURL(artifactUrl); artifactUrl = null; }
}
$('artifact-close').onclick = closeArtifact;
$('artifact-edit').onclick = () => {
  const editing = !artifactEditor.classList.contains('hidden');
  if (editing) {
    // back to preview, applying the edited code
    artifactEditor.classList.add('hidden');
    artifactFrame.classList.remove('hidden');
    runArtifact(artifactEditor.value);
    $('artifact-edit').textContent = '✎';
  } else {
    artifactFrame.classList.add('hidden');
    artifactEditor.classList.remove('hidden');
    $('artifact-edit').textContent = '✓ run';
    artifactEditor.focus();
  }
};
$('artifact-open').onclick = () => {
  const code = artifactEditor.classList.contains('hidden') ? (artifactFrame.srcdoc || '') : artifactEditor.value;
  if (!code) return;
  if (artifactUrl) URL.revokeObjectURL(artifactUrl);
  artifactUrl = URL.createObjectURL(new Blob([code], { type: 'text/html' }));
  window.open(artifactUrl, '_blank');
};

// ---------- toasts ----------
function toast(msg, kind = 'ok') {
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = msg;
  $('toasts').appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 350); }, 2800);
}

// ---------- auth ----------
$('tab-login').onclick = () => setAuthMode('login');
$('tab-register').onclick = () => setAuthMode('register');
function setAuthMode(m) {
  authMode = m;
  $('tab-login').classList.toggle('active', m === 'login');
  $('tab-register').classList.toggle('active', m === 'register');
  $('auth-submit').textContent = m === 'login' ? 'Log in' : 'Create account';
  $('auth-msg').textContent = '';
}
$('auth-submit').onclick = doAuth;
$('auth-password').addEventListener('keydown', (e) => e.key === 'Enter' && doAuth());
$('auth-username').addEventListener('keydown', (e) => e.key === 'Enter' && $('auth-password').focus());
async function doAuth() {
  try {
    if (totpChallenge) {
      // second step of two-factor login
      const r = await api('POST', '/api/login/totp', { challenge: totpChallenge, token: $('auth-totp').value.trim() });
      totpChallenge = null;
      if (r.username) { await boot(); return; }
    }
    const r = await api('POST', `/api/${authMode === 'login' ? 'login' : 'register'}`, {
      username: $('auth-username').value.trim(), password: $('auth-password').value,
    });
    if (r.totp_required) {
      totpChallenge = r.challenge;
      $('auth-totp').classList.remove('hidden');
      $('auth-submit').textContent = 'Verify code';
      $('auth-msg').textContent = '';
      $('auth-totp').focus();
      return;
    }
    await boot();
  } catch (e) { $('auth-msg').textContent = e.message; }
}
let totpChallenge = null;

async function boot() {
  try { me = await api('GET', '/api/me'); } catch { showAuth(); return; }
  $('auth-view').classList.add('hidden');
  $('app-view').classList.remove('hidden');
  $('auth-totp').classList.add('hidden');
  $('auth-submit').textContent = 'Log in';
  $('whoami-name').textContent = me.display_name || me.username;
  $('whoami-role').textContent = me.role;
  $('whoami-avatar').textContent = (me.display_name || me.username)[0].toUpperCase();
  if (me.avatar_color) $('whoami-avatar').style.background = me.avatar_color;
  $('show-admin').classList.toggle('hidden', me.role !== 'admin');
  await loadToolsBadge();
  await refreshProviderSelect();
  await loadProjects();
  await loadConvs();
  loadAnnouncement();
  loadAttachments();
  // restore last open conversation after reload
  const last = Number(localStorage.getItem('oc_conv'));
  if (last && convs.some((c) => c.id === last)) await openConv(last);
}
function showAuth() {
  $('app-view').classList.add('hidden');
  $('auth-view').classList.remove('hidden');
}
$('logout').onclick = async () => { await api('POST', '/api/logout'); location.reload(); };

// ---------- tools badge ----------
async function loadToolsBadge() {
  const badge = $('tools-badge');
  try {
    const ov = await api('GET', '/api/tools');
    const tools = (ov.builtin?.length || 0) + (ov.mcp?.filter((t) => !t.error).length || 0);
    badge.textContent = tools ? `✓ ${tools} tools enabled` : 'no tools enabled';
    badge.classList.toggle('has', tools > 0);
    badge.title = [...(ov.builtin || []), ...(ov.mcp || [])].map((t) => t.name).join('\n') || 'no tools';
  } catch { badge.textContent = ''; }
}

// ---------- conversations ----------
$('new-chat').onclick = () => {
  activeConv = null;
  localStorage.removeItem('oc_conv');
  setDrawer(false);
  renderMessages([]);
  updateExportVisibility();
  $('input').focus();
};
let convFilter = '';
let convView = 'active'; // 'active' | 'archived'
$('tab-active-chats').onclick = () => { convView = 'active'; renderConvTabs(); loadConvs(); };
$('tab-archived').onclick = () => { convView = 'archived'; renderConvTabs(); loadConvs(); };
function renderConvTabs() {
  $('tab-active-chats').classList.toggle('active', convView === 'active');
  $('tab-archived').classList.toggle('active', convView === 'archived');
}

async function loadConvs() {
  const params = new URLSearchParams();
  if (convView === 'archived') params.set('archived', '1');
  if (activeProject) params.set('project', String(activeProject));
  convs = await api('GET', `/api/conversations${params.toString() ? '?' + params : ''}`);
  renderConvList();
}
function dayLabel(iso) {
  if (!iso) return '';
  const d = new Date(String(iso).replace(' ', 'T') + (iso.endsWith('Z') || iso.includes('T') ? '' : 'Z'));
  const today = new Date();
  const one = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = (one(today) - one(d)) / 86400000;
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return 'This week';
  return d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
}

function renderConvList() {
  const list = $('conv-list');
  list.innerHTML = '';
  const q = convFilter.trim().toLowerCase();
  const shown = q
    ? convs.filter((c) => (c.title || '').toLowerCase().includes(q) || (c.preview || '').toLowerCase().includes(q))
    : convs;
  let lastDay = '';
  for (const c of shown) {
    // group chats under day headers — Today / Yesterday / this week / date
    const day = dayLabel(c.last_at || c.created_at);
    if (day && day !== lastDay) {
      lastDay = day;
      const head = document.createElement('div');
      head.className = 'conv-day muted small';
      head.textContent = day;
      list.appendChild(head);
    }
    const div = document.createElement('div');
    div.className = 'conv-item' + (activeConv === c.id ? ' active' : '');
    div.innerHTML = `<div class="conv-main"><span class="conv-title"></span><span class="conv-sub"></span></div>
      <span class="conv-actions">
        <button class="pin ${c.pinned ? 'on' : ''}" title="${c.pinned ? 'Unpin' : 'Pin'}">${c.pinned ? '📌' : '📍'}</button>
        <button class="arch" title="${c.archived ? 'Unarchive' : 'Archive'}">${c.archived ? '📤' : '🗄'}</button>
        <button class="del" title="delete">🗑</button>
      </span>`;
    div.querySelector('.conv-title').textContent = (c.private ? '🕶 ' : '') + (c.pinned ? '📌 ' : '') + (c.title || 'New chat');
    const when = c.last_at ? timeLabel(c.last_at) : timeLabel(c.created_at);
    div.querySelector('.conv-sub').textContent = [when, c.project_name ? `🗂 ${c.project_name}` : '', (c.preview || '').replace(/\s+/g, ' ').slice(0, 42)].filter(Boolean).join(' · ');
    div.title = 'Double-click to rename';
    div.onclick = (e) => {
      const cls = e.target.classList;
      if (cls.contains('del')) {
        e.stopPropagation();
        if (confirm(`Delete "${c.title}"?`)) delConv(c.id);
        return;
      }
      if (cls.contains('pin')) {
        e.stopPropagation();
        api('PUT', '/api/conversation/flags', { id: c.id, pinned: !c.pinned }).then(loadConvs);
        return;
      }
      if (cls.contains('arch')) {
        e.stopPropagation();
        api('PUT', '/api/conversation/flags', { id: c.id, archived: !c.archived }).then(() => {
          toast(c.archived ? 'Restored' : 'Archived');
          loadConvs();
          if (activeConv === c.id) { /* keep it open, just refresh list state */ }
        });
        return;
      }
      openConv(c.id);
    };
    div.ondblclick = async (e) => {
      if (['del', 'pin', 'arch'].some((k) => e.target.classList.contains(k))) return;
      const title = prompt('Rename chat:', c.title);
      if (title && title.trim()) {
        await api('POST', '/api/conversations/rename', { id: c.id, title: title.trim() });
        loadConvs();
      }
    };
    list.appendChild(div);
  }
  if (!shown.length) {
    const empty = document.createElement('div');
    empty.className = 'conv-empty muted small';
    empty.textContent = q ? 'No chats match.' : convView === 'archived' ? 'Nothing archived.' : 'No chats yet.';
    list.appendChild(empty);
  }
}

// ---------- global message search ----------
let searchTimer = null;
$('conv-search').addEventListener('input', (e) => {
  convFilter = e.target.value;
  renderConvList();
  clearTimeout(searchTimer);
  const q = convFilter.trim();
  if (q.length < 2) { $('search-results').classList.add('hidden'); return; }
  searchTimer = setTimeout(async () => {
    try {
      const hits = await api('GET', `/api/search?q=${encodeURIComponent(q)}`);
      renderSearchResults(hits, q);
    } catch { /* non-fatal */ }
  }, 250);
});
function renderSearchResults(hits, q) {
  const box = $('search-results');
  if (!hits.length) { box.classList.add('hidden'); return; }
  box.innerHTML = '<div class="side-label">Message matches</div>';
  for (const h of hits.slice(0, 12)) {
    const div = document.createElement('div');
    div.className = 'search-hit';
    div.innerHTML = `<b class="hit-title"></b><span class="hit-snippet"></span>`;
    div.querySelector('.hit-title').textContent = `${h.role === 'user' ? 'You' : '✦'} · ${h.title}`;
    div.querySelector('.hit-snippet').textContent = h.snippet || '';
    div.onclick = () => {
      box.classList.add('hidden');
      $('conv-search').value = '';
      convFilter = '';
      renderConvList();
      if (convView === 'archived') { convView = 'active'; renderConvTabs(); loadConvs(); }
      openConv(h.conv_id);
    };
    box.appendChild(div);
  }
  box.classList.remove('hidden');
}
function hideSearchResults() {
  $('search-results').classList.add('hidden');
}
async function openConv(id) {
  activeConv = id;
  localStorage.setItem('oc_conv', String(id));
  setDrawer(false); // on phones, tapping a chat should reveal the chat pane
  const msgs = await api('GET', `/api/conversation/${id}/messages`);
  renderMessages(msgs);
  loadAttachments();
  loadConvs();
}
async function delConv(id) {
  await api('DELETE', `/api/conversations?id=${id}`);
  if (activeConv === id) { activeConv = null; renderMessages([]); }
  loadConvs();
  toast('Chat deleted');
}

function timeLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso.replace(' ', 'T') + 'Z');
  const diff = (Date.now() - d.getTime()) / 60000;
  if (diff < 1) return 'just now';
  if (diff < 60) return `${Math.floor(diff)}m ago`;
  if (diff < 1440) return `${Math.floor(diff / 60)}h ago`;
  return d.toLocaleDateString();
}

function renderMessages(msgs) {
  const box = $('messages');
  box.innerHTML = '';
  const visible = msgs.filter((m) => ['user', 'assistant', 'tool_event'].includes(m.role));
  noteLastMsgId(visible.filter((m) => m.id));
  if (!visible.length) {
    box.innerHTML = `
      <div id="empty-state" class="empty">
        <div class="empty-orb">✦</div>
        <h2>How can I help you today?</h2>
        <p class="muted">The assistant can call tools, remember facts about you, and reach MCP servers your admin connected.</p>
        <div class="chips">
          <button class="chip" data-fill="Remember that I prefer TypeScript and use Arch Linux">Remember I prefer TypeScript</button>
          <button class="chip" data-fill="What do you remember about me?">What do you know about me?</button>
          <button class="chip" data-fill="What tools do you have available right now?">List your tools</button>
        </div>
      </div>`;
    box.querySelectorAll('.chip').forEach((c) => {
      c.onclick = () => { $('input').value = c.dataset.fill; $('input').focus(); send(); };
    });
    return;
  }
  for (const m of visible) {
    if (m.role === 'tool_event') {
      box.appendChild(toolEventRow(m.tool_name, m.content));
    } else {
      box.appendChild(messageRow(m.role, m.role === 'assistant' ? md(m.content) : esc(m.content), m.created_at, m.role === 'assistant', m.content, m));
    }
  }
  scrollToLatest();
  renderOutline(visible);
  updateExportVisibility();
  // regenerate affordance under the final assistant reply, with a
  // "retry with another model" picker
  const last = visible[visible.length - 1];
  if (last?.role === 'assistant' && activeConv && !sending) {
    const regenRow = document.createElement('div');
    regenRow.className = 'msg-row tool';
    const btn = document.createElement('button');
    btn.className = 'regen-btn';
    btn.textContent = '↻ Regenerate reply';
    btn.onclick = () => send(true, activeConv);
    const sel = document.createElement('select');
    sel.className = 'regen-provider';
    sel.title = 'Retry with a different model';
    sel.innerHTML = `<option value="">with same model</option>` + buildProviderOptions();
    const retry = document.createElement('button');
    retry.className = 'regen-btn';
    retry.textContent = '↻ Retry with…';
    retry.onclick = () => send(true, activeConv, sel.value || null);
    regenRow.append(btn, sel, retry);
    box.appendChild(regenRow);
  }
}
// flat option list for the retry picker (admin pool + personal providers)
function buildProviderOptions() {
  const opts = [];
  document.querySelectorAll('#provider-select option').forEach((o) => {
    if (!o.value) return;
    opts.push(`<option value="${esc(o.value)}">${esc(o.textContent)}</option>`);
  });
  return opts.join('');
}

function toolEventRow(name, content) {
  const row = document.createElement('div');
  row.className = 'msg-row tool';
  const chip = document.createElement('div');
  chip.className = 'tool-chip';
  const dur = String(content || '').match(/⏱\s*(\d+)\s*ms$/);
  const body = String(content || '').replace(/\n⏱\s*\d+\s*ms$/, '');
  const preview = body.replace(/\s+/g, ' ').slice(0, 90);
  chip.innerHTML = `<span class="tool-icon">🔧</span><b>${esc(name)}</b>` +
    (dur ? `<span class="tool-dur" title="execution time">${dur[1]}ms</span>` : '') +
    `<span class="tool-result">${esc(preview)}${body.length > 90 ? '…' : ''}</span>`;
  row.appendChild(chip);
  return row;
}

function fmtTok(n) {
  n = Number(n) || 0;
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

// ---------- text-to-speech (Web Speech API, graceful when unsupported) ----------
let speakingBtn = null;
function speakText(text, btn) {
  if (!('speechSynthesis' in window)) { toast('Speech is not supported in this browser', 'bad'); return; }
  if (speechSynthesis.speaking) {
    speechSynthesis.cancel();
    if (speakingBtn === btn) { speakingBtn = null; return; } // second click just stops
  }
  const plain = String(text || '').replace(/```[\s\S]*?```/g, ' code block ').replace(/[#*_`>~]/g, '');
  const u = new SpeechSynthesisUtterance(plain.slice(0, 4000));
  u.rate = 1.02;
  u.onend = () => { if (speakingBtn) speakingBtn.style.opacity = ''; speakingBtn = null; };
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
  speakingBtn = btn;
  btn.style.opacity = '1';
  toast('Reading aloud — click 🔊 again to stop');
}

function messageRow(role, htmlContent, createdAt, isHtml, raw, msg = null) {
  const row = document.createElement('div');
  row.className = `msg-row ${role}`;
  const avatar = document.createElement('div');
  avatar.className = 'avatar' + (role === 'assistant' ? ' ai' : '');
  avatar.textContent = role === 'assistant' ? '✦' : (me?.display_name || me?.username || 'U')[0].toUpperCase();
  if (role !== 'assistant' && me?.avatar_color) avatar.style.background = me.avatar_color;
  const body = document.createElement('div');
  body.className = 'msg-body';
  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  meta.innerHTML = `<span class="who">${esc(role === 'assistant' ? 'Assistant' : me?.display_name || me?.username || 'You')}</span><span>${timeLabel(createdAt)}</span>`;
  const addBtn = (title, text, fn) => {
    const b = document.createElement('button');
    b.className = 'msg-copy';
    b.title = title;
    b.textContent = text;
    b.onclick = fn;
    meta.appendChild(b);
    return b;
  };
  // token usage chip on assistant messages when the provider reported it
  if (role === 'assistant' && msg && (Number(msg.prompt_tokens) || Number(msg.completion_tokens))) {
    const chip = document.createElement('span');
    chip.className = 'tok-chip';
    chip.title = `${msg.prompt_tokens} prompt + ${msg.completion_tokens} completion tokens`;
    chip.textContent = `Σ ${fmtTok(Number(msg.prompt_tokens) + Number(msg.completion_tokens))}`;
    meta.appendChild(chip);
  }
  // model attribution on assistant replies
  if (role === 'assistant' && msg?.model) {
    const chip = document.createElement('span');
    chip.className = 'model-chip';
    chip.title = 'model that produced this reply';
    chip.textContent = msg.model;
    meta.appendChild(chip);
  }
  addBtn('Copy', '⧉', async () => {
    try { await navigator.clipboard.writeText(raw ?? ''); toast('Copied to clipboard'); }
    catch { toast('Copy failed', 'bad'); }
  });
  if (msg && msg.id) {
    row.dataset.mid = msg.id; // anchor so ⭐ Starred can jump back here
    if (role === 'user') addBtn('Edit & resend', '✎', () => startEdit(msg, bubble));
    const star = addBtn('Star this message', msg.starred ? '★' : '☆', async () => {
      const on = star.textContent === '☆';
      await api('PUT', '/api/messages/star', { id: msg.id, starred: on });
      star.textContent = on ? '★' : '☆';
      star.classList.toggle('starred', on);
      toast(on ? 'Starred' : 'Unstarred');
    });
    star.classList.toggle('starred', !!msg.starred);
    addBtn('Fork from here', '⑂', async () => {
      const r = await api('POST', '/api/conversations/fork', { id: msg.conv_id, message_id: msg.id });
      toast('Forked into a new chat');
      await loadConvs();
      openConv(r.conversation_id);
    });
  }
  if (role === 'assistant') {
    const speakBtn = addBtn('Read aloud', '🔊', () => speakText(raw, speakBtn));
  }
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (isHtml) bubble.innerHTML = htmlContent;
  else bubble.textContent = htmlContent;
  body.append(meta, bubble);
  row.append(avatar, body);
  return row;
}

// inline "edit your message, then the assistant answers the edited version"
function startEdit(m, bubble) {
  if (bubble.dataset.editing) return;
  bubble.dataset.editing = '1';
  const old = bubble.innerHTML;
  bubble.innerHTML = '';
  const ta = document.createElement('textarea');
  ta.className = 'edit-area';
  ta.value = m.content;
  const actions = document.createElement('div');
  actions.className = 'edit-actions';
  const save = document.createElement('button');
  save.className = 'primary';
  save.textContent = 'Save & resend';
  const cancel = document.createElement('button');
  cancel.textContent = 'Cancel';
  cancel.onclick = () => { bubble.innerHTML = old; delete bubble.dataset.editing; };
  save.onclick = async () => {
    const content = ta.value.trim();
    if (!content || content === m.content) { cancel.onclick(); return; }
    await api('PUT', '/api/messages', { id: m.id, content });
    toast('Resending with your edit…');
    await regenerateConv(m.conv_id);
  };
  actions.append(save, cancel);
  bubble.append(ta, actions);
  ta.focus();
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save.click(); }
    if (e.key === 'Escape') cancel.onclick();
  });
}

// regenerate the latest reply in a conversation, then re-render from the server
async function regenerateConv(convId) {
  const box = $('messages');
  const row = messageRow('assistant', '', null, false, '');
  row.querySelector('.bubble').innerHTML = '<div class="typing"><span></span><span></span><span></span></div>';
  box.appendChild(row);
  box.scrollTop = box.scrollHeight;
  try {
    await api('POST', '/api/chat/regenerate', { conversation_id: convId });
  } catch (e) {
    row.querySelector('.bubble').textContent = '⚠️ ' + e.message;
  }
  const msgs = await api('GET', `/api/conversation/${convId}/messages`);
  renderMessages(msgs);
  loadConvs();
}

// ---------- send (streaming with graceful fallback) ----------
$('send').onclick = send;
const inputEl = $('input');
inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + 'px';
});
inputEl.addEventListener('keydown', (e) => {
  // when the slash popup is open the dedicated handler below handles keys
  if (!slashPop.classList.contains('hidden')) return;
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
  else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});

let sending = false;
let activeAbort = null; // lets the stop button cancel an in-flight generation
async function send(regenerating = false, existingConv = null, retryProvider = undefined) {
  if (sending) return;
  const text = regenerating ? '' : inputEl.value.trim();
  if (!text && !regenerating) return;
  if (regenerating && !activeConv) return;
  sending = true;
  setStreamUi(true);
  if (!regenerating) {
    inputEl.value = '';
    inputEl.style.height = 'auto';
    hideSlashPop();
  }
  const box = $('messages');
  const empty = $('empty-state');
  if (empty) empty.remove();

  if (!regenerating) box.appendChild(messageRow('user', text, null, false, text));
  const row = messageRow('assistant', '', null, false, '');
  const bubble = row.querySelector('.bubble');
  bubble.innerHTML = '<div class="typing"><span></span><span></span><span></span></div>';
  box.appendChild(row);
  scrollToLatest(true);

  const payload = regenerating
    ? { conversation_id: existingConv ?? activeConv, ...(retryProvider ? { provider_id: retryProvider } : {}) }
    : {
        conversation_id: activeConv, message: text,
        provider_id: $('provider-select').value || null,
        ...(activeConv || !activeProject ? {} : { project_id: activeProject }),
      };

  try {
    let streamFailed = false;
    if (!regenerating) {
      // live stream render: deltas accumulate into the newest bubble,
      // tool chips slot in between as the model calls tools
      let acc = '';
      let lastPaint = 0;
      let activeBubble = bubble;
      const paint = (force) => {
        const now = performance.now();
        if (force || now - lastPaint > 60) { activeBubble.innerHTML = md(acc); lastPaint = now; }
      };
      activeAbort = new AbortController();
      const res = await fetch('/api/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: activeAbort.signal,
      });
      if (!res.ok || !res.body) {
        streamFailed = true; // fall back to the plain endpoint
      } else {
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        outer: for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 2);
            if (!chunk.startsWith('data:')) continue;
            let evt;
            try { evt = JSON.parse(chunk.slice(5)); } catch { continue; }
            if (evt.type === 'delta') {
              acc += evt.text;
              paint();
            } else if (evt.type === 'tool') {
              paint(true);
              box.appendChild(toolEventRow(evt.name, evt.result));
              const nr = messageRow('assistant', '', null, false, '');
              activeBubble = nr.querySelector('.bubble');
              box.appendChild(nr);
              acc = '';
            } else if (evt.type === 'done') {
              activeConv = evt.conversation_id;
              acc = evt.reply ?? acc;
              paint(true);
              break outer;
            } else if (evt.type === 'error') {
              activeBubble.classList.add('error');
              activeBubble.textContent = '⚠️ ' + evt.error;
              break outer;
            }
          }
        }
        paint(true);
      }
      if (streamFailed) {
        const res2 = await api('POST', '/api/chat', payload);
        activeConv = res2.conversation_id;
        bubble.innerHTML = md(res2.reply);
      }
    } else {
      const res2 = await api('POST', '/api/chat/regenerate', payload);
      activeConv = res2.conversation_id;
      bubble.innerHTML = md(res2.reply);
    }
    // canonical re-render (timestamps, tool chips, correct order)
    if (activeConv) {
      const msgs = await api('GET', `/api/conversation/${activeConv}/messages`);
      renderMessages(msgs);
      localStorage.setItem('oc_conv', String(activeConv));
      playChime();
      notifyReply();
      if (localStorage.getItem('oc_autoread') === '1') {
        const lastA = [...msgs].reverse().find((m) => m.role === 'assistant');
        if (lastA) speakText(lastA.content, null);
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      // user pressed stop: the server persisted any partial reply — reload it
      toast('Generation stopped');
      if (activeConv) {
        const msgs = await api('GET', `/api/conversation/${activeConv}/messages`);
        renderMessages(msgs);
      }
    } else {
      bubble.classList.add('error');
      bubble.textContent = '⚠️ ' + e.message;
      if (/Daily limit/.test(e.message)) {
        // show when the quota resets (midnight UTC)
        const reset = new Date(Date.now() + 86400000);
        reset.setUTCHours(0, 0, 0, 0);
        const mins = Math.max(1, Math.round((reset - Date.now()) / 60000));
        const h = Math.floor(mins / 60), m = mins % 60;
        const note = document.createElement('div');
        note.className = 'muted small';
        note.style.marginTop = '6px';
        note.textContent = `Resets in ${h ? h + 'h ' : ''}${m}m — an admin can raise your limit.`;
        bubble.appendChild(note);
      }
    }
  }
  activeAbort = null;
  setStreamUi(false);
  sending = false;
  if (!regenerating && !document.hidden) inputEl.focus();
  loadConvs();
  updateExportVisibility();
}

// swap send ↔ stop while the model is working
function setStreamUi(on) {
  $('send').classList.toggle('hidden', on);
  $('stop').classList.toggle('hidden', !on);
  $('send').disabled = on;
  // nudge the user when a reply lands while the tab is in the background
  if (!on && document.hidden) {
    const orig = 'OrionChatV3';
    let flips = 0;
    const timer = setInterval(() => {
      document.title = (document.title === orig ? '✦ Reply ready!' : orig);
      if (++flips > 5 || !document.hidden) { clearInterval(timer); document.title = orig; }
    }, 900);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { clearInterval(timer); document.title = orig; } }, { once: true });
  }
}
$('stop').onclick = () => activeAbort?.abort();

// ---------- voice input (Web Speech API) ----------
(() => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const micBtn = $('mic-btn');
  if (!SR) return; // stay hidden where speech recognition isn't available
  micBtn.classList.remove('hidden');
  let rec = null;
  micBtn.onclick = () => {
    if (rec) { rec.stop(); return; }
    rec = new SR();
    rec.lang = navigator.language || 'en-US';
    rec.interimResults = true;
    const base = inputEl.value;
    micBtn.classList.add('listening');
    rec.onresult = (e) => {
      let text = '';
      for (const r of e.results) text += r[0].transcript;
      inputEl.value = (base ? base + ' ' : '') + text;
      inputEl.dispatchEvent(new Event('input'));
    };
    rec.onend = () => { rec = null; micBtn.classList.remove('listening'); inputEl.focus(); };
    rec.onerror = () => { rec = null; micBtn.classList.remove('listening'); toast('Voice input failed', 'bad'); };
    rec.start();
    toast('Listening… click the mic again to stop');
  };
})();

// ---------- provider select (admin pool + the user's own personal providers) ----------
let myProvidersCache = [];
async function refreshProviderSelect() {
  const sel = $('provider-select');
  try {
    const [providers, mine] = await Promise.all([
      api('GET', '/api/providers'),
      api('GET', '/api/my/providers').catch(() => ({ allowed: false, providers: [] })),
    ]);
    myProvidersCache = mine.allowed ? (mine.providers || []).filter((p) => p.enabled) : [];
    const mineOpts = myProvidersCache
      .map((p) => `<option value="u${p.id}">🧩 ${esc(p.name)} · ${esc(p.model)}</option>`).join('');
    sel.disabled = false;
    sel.innerHTML = providers.length
      ? providers.map((p) => `<option value="${p.id}">${esc(p.name)} · ${esc(p.model)}</option>`).join('') + (mineOpts ? `<optgroup label="Your providers">${mineOpts}</optgroup>` : '')
      : (mineOpts || '<option value="">No providers configured</option>');
    const saved = localStorage.getItem('oc_provider');
    if (saved && [...sel.options].some((o) => o.value === saved)) sel.value = saved;
    sel.onchange = () => localStorage.setItem('oc_provider', sel.value);
  } catch {
    sel.innerHTML = '<option value="">Unavailable</option>';
  }
}

// ---------- instructions modal (custom standing prompts) ----------
$('show-instructions').onclick = async () => {
  openModal(`
    <h2>📝 Custom instructions</h2>
    <p class="muted small">Standing instructions the assistant follows in every reply — tone, preferences, context about your work.</p>
    <textarea id="instr-text" rows="9" placeholder="e.g. Always answer in English. Prefer concise bullet points. I'm a backend engineer using PostgreSQL…"></textarea>
    <p id="instr-msg" class="msg"></p>
    <button id="instr-save" class="primary wide">Save instructions</button>`);
  try {
    const me2 = await api('GET', '/api/me');
    $('instr-text').value = me2.instructions || '';
  } catch {}
  $('instr-save').onclick = async () => {
    const btn = $('instr-save');
    btn.disabled = true;
    try {
      await api('PUT', '/api/settings', { instructions: $('instr-text').value });
      modal.classList.add('hidden');
      toast('Instructions saved');
    } catch (e) { $('instr-msg').textContent = e.message; }
    btn.disabled = false;
  };
};

// ---------- command palette (Alt+K): jump anywhere fast ----------
const palette = document.createElement('div');
palette.id = 'palette';
palette.className = 'palette hidden';
document.body.appendChild(palette);
let paletteIdx = 0;
function paletteItems() {
  const chats = convs.slice(0, 8).map((c) => ({
    label: `💬 ${c.title || 'New chat'}`, hint: 'open chat',
    run: () => openConv(c.id),
  }));
  return [
    { label: '✨ New chat', hint: 'Ctrl/⌘+Shift+O', run: () => $('new-chat').click() },
    { label: '🗂 Documents', hint: 'knowledge base', run: () => $('show-documents').click() },
    { label: '🧩 My providers', hint: 'BYOK', run: () => $('show-myproviders').click() },
    { label: '⏰ Reminders', hint: 'scheduled prompts', run: () => $('show-tasks').click() },
    { label: '⭐ Starred', hint: 'bookmarks', run: () => $('show-starred').click() },
    { label: '📊 My usage', hint: 'stats', run: () => $('show-usage').click() },
    { label: '🔌 My tools', hint: 'personal MCP', run: () => $('show-usermcp').click() },
    { label: '💡 Prompts', hint: 'library', run: () => $('show-prompts').click() },
    { label: '🧠 Memories', hint: 'what the AI knows', run: () => $('show-memories').click() },
    { label: '📝 Instructions', hint: 'standing prompt', run: () => $('show-instructions').click() },
    { label: '🎨 Cycle theme', hint: 'next palette', run: () => {
        const ids = THEMES.map((t) => t.id);
        setTheme(ids[(ids.indexOf(currentTheme()) + 1) % ids.length]);
      } },
    { label: '⌨️ Shortcuts', hint: '?', run: showShortcuts },
    ...(me?.role === 'admin' ? [{ label: '⚙️ Admin', hint: 'panel', run: openAdmin }] : []),
    ...chats,
  ];
}
function openPalette() {
  paletteIdx = 0;
  renderPalette('');
  palette.classList.remove('hidden');
  palette.querySelector('input').focus();
}
function renderPalette(q) {
  const items = paletteItems().filter((i) => i.label.toLowerCase().includes(q.toLowerCase()));
  paletteIdx = Math.min(paletteIdx, Math.max(0, items.length - 1));
  palette.innerHTML = `<input placeholder="Jump to… (chats, panels, actions)" value="${esc(q)}">` +
    (items.length
      ? items.map((i, idx) => `<div class="palette-item ${idx === paletteIdx ? 'sel' : ''}" data-idx="${idx}"><span>${esc(i.label)}</span><span class="muted small">${esc(i.hint)}</span></div>`).join('')
      : '<div class="muted small" style="padding:10px">No matches.</div>');
  const input = palette.querySelector('input');
  input.oninput = () => { paletteIdx = 0; renderPalette(input.value); };
  input.onkeydown = (e) => {
    const items2 = paletteItems().filter((i) => i.label.toLowerCase().includes(input.value.toLowerCase()));
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      paletteIdx = (paletteIdx + (e.key === 'ArrowDown' ? 1 : items2.length - 1)) % Math.max(1, items2.length);
      renderPalette(input.value);
      palette.querySelector('input').focus();
    } else if (e.key === 'Enter') {
      const filtered = paletteItems().filter((i) => i.label.toLowerCase().includes(input.value.toLowerCase()));
      if (filtered[paletteIdx]) { closePalette(); filtered[paletteIdx].run(); }
    } else if (e.key === 'Escape') closePalette();
  };
  palette.querySelectorAll('.palette-item').forEach((el) => {
    el.onclick = () => {
      const items3 = paletteItems().filter((i) => i.label.toLowerCase().includes(input.value.toLowerCase()));
      closePalette();
      items3[Number(el.dataset.idx)]?.run();
    };
    el.onmousemove = () => {
      palette.querySelectorAll('.palette-item.sel').forEach((x) => x.classList.remove('sel'));
      el.classList.add('sel');
    };
  });
}
function closePalette() { palette.classList.add('hidden'); }
document.addEventListener('keydown', (e) => {
  if (e.altKey && e.key.toLowerCase() === 'k' && me) { e.preventDefault(); openPalette(); }
});
palette.addEventListener('click', (e) => { if (e.target === palette) closePalette(); });

// ---------- keyboard shortcuts ----------
document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  const typingElsewhere = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
  if (mod && e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); $('new-chat').click(); }
  else if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); $('conv-search').focus(); }
  else if (e.key === '?' && !typingElsewhere) { e.preventDefault(); showShortcuts(); }
  else if (e.key === '/' && !typingElsewhere) { e.preventDefault(); inputEl.focus(); }
  else if (e.key === 'Escape' && !modal.classList.contains('hidden')) modal.classList.add('hidden');
  else if (e.key === 'Escape') { hideThemePop(); setDrawer(false); }
});

// ---------- memories modal ----------
$('show-memories').onclick = async () => {
  const [mems, meFresh] = await Promise.all([api('GET', '/api/memories'), api('GET', '/api/me')]);
  me.memory_enabled = meFresh.memory_enabled;
  me.memory_allowed = meFresh.memory_allowed;
  me.memory_global = meFresh.memory_global;
  const blocked = !meFresh.memory_allowed || !meFresh.memory_global;
  const gatedHere = !activeConv || !(convs.find((c) => c.id === activeConv) || {}).private;
  openModal(`
    <h2>🧠 What the AI remembers about you</h2>
    <p class="muted small">The assistant saves facts with the memory_save tool and sees them in every new message. Private chats (🎛) never use memories.</p>
    <div class="card">
      <div class="row"><b>Memory for your account</b>
        <span><button id="mem-toggle" class="${meFresh.memory_enabled ? '' : 'ghost'}">${meFresh.memory_enabled ? 'On — turn off' : 'Off — turn on'}</button></span></div>
      <div class="muted small">${blocked
        ? (meFresh.memory_global
          ? 'An admin has disabled memory for your account.'
          : 'Memory is disabled platform-wide by an admin.')
        : 'Turn memory off and the AI stops reading and writing memories in all chats.'}</div>
    </div>
    <div class="admin-section">
      ${mems.length ? mems.map((m) => `
        <div class="card">
          <div class="row"><b>${esc(m.key)}</b>
            <span><button data-edit="${esc(m.key)}">edit</button>
            <button class="danger" data-del="${esc(m.key)}">forget</button></span></div>
          <div class="muted">${esc(m.value)}</div>
          <div class="kv">updated ${esc(m.updated_at)}</div>
        </div>`).join('')
      : `<div class="card"><p class="muted">${meFresh.memory_enabled && gatedHere ? 'Nothing remembered yet — tell the AI something about yourself.' : 'Memory is currently off, so nothing new is being remembered.'}</p></div>`}
    </div>`);
  if (!blocked) {
    $('mem-toggle').onclick = async () => {
      await api('PUT', '/api/settings', { memory_enabled: !me.memory_enabled });
      toast(me.memory_enabled ? 'Memory turned off' : 'Memory turned on');
      $('show-memories').click();
    };
  } else {
    $('mem-toggle').disabled = true;
  }
  modal.querySelectorAll('[data-del]').forEach((btn) => {
    btn.onclick = async () => { await api('DELETE', `/api/memories?key=${encodeURIComponent(btn.dataset.del)}`); $('show-memories').click(); };
  });
  modal.querySelectorAll('[data-edit]').forEach((btn) => {
    btn.onclick = () => {
      const m = mems.find((x) => x.key === btn.dataset.edit);
      const value = prompt(`Edit memory "${m.key}":`, m.value);
      if (value === null || !value.trim()) return;
      api('PUT', '/api/memories', { key: m.key, value: value.trim() })
        .then(() => { toast('Memory updated'); $('show-memories').click(); })
        .catch((e) => toast(e.message, 'bad'));
    };
  });
};

// ---------- personal MCP servers (each user's own tool connections) ----------
$('show-usermcp').onclick = async () => {
  const data = await api('GET', '/api/mcp');
  openModal(`
    <h2>🔌 My MCP tools</h2>
    <p class="muted small">Connect your own MCP servers — stdio (local process) or HTTP (remote). Their tools join every chat automatically, namespaced <b>u&lt;id&gt;__tool</b> so they never clash with anything else.</p>
    ${data.allowed ? '' : '<div class="card"><p class="muted">⚠️ Admins have paused personal MCP servers — your tools are disconnected until they allow them again.</p></div>'}
    <div class="admin-section">
      ${data.servers.length ? data.servers.map((s) => `
        <div class="card">
          <div class="row"><b>${esc(s.name)}</b>
            <span class="pill ${s.enabled ? 'on' : 'off'}">${s.enabled ? (s.connected ? 'connected' : 'idle') : 'disabled'}</span>
            <span>
              <button data-uen="${s.id}">${s.enabled ? 'disable' : 'enable'}</button>
              <button class="danger" data-udel="${s.id}">remove</button>
            </span></div>
          <div class="kv">${s.kind === 'http' ? esc(s.url) : esc(s.command) + ' ' + esc(s.args)}</div>
          ${s.state_error ? `<div class="kv bad">✗ ${esc(s.state_error)}</div>` : ''}
          ${s.tools.length ? `<div class="kv">tools: ${s.tools.map((t) => `<span class="tool-tag">u${s.id}__${esc(t.name)}</span>`).join(' ')}</div>` : ''}
        </div>`).join('')
      : '<div class="card"><p class="muted small">No personal servers yet.</p></div>'}
    </div>
    ${data.allowed ? `
    <div class="card">
      <div class="row"><b>Add MCP server</b>
        <select id="um-kind">
          <option value="stdio">stdio — local process</option>
          <option value="http">HTTP — remote server</option>
        </select></div>
      <div class="grid2" id="um-stdio-fields">
        <input id="um-name" placeholder="name">
        <input id="um-command" placeholder="command e.g. node">
        <input id="um-args" placeholder='args JSON e.g. ["my-mcp-server.js","/tmp"]' style="grid-column: 1 / -1;">
        <input id="um-env" placeholder="env lines KEY=val" style="grid-column: 1 / -1;">
      </div>
      <div class="grid2 hidden" id="um-http-fields">
        <input id="um-url" placeholder="https://example.com/mcp" style="grid-column: 1 / -1;">
        <input id="um-headers" placeholder="headers, one per line — e.g. Authorization: Bearer …" style="grid-column: 1 / -1;">
      </div>
      <p id="um-msg" class="msg"></p>
      <div class="row">
        <button id="um-test">test connection</button>
        <span id="um-test-result" class="small"></span>
        <button class="primary" id="um-add" style="margin-left:auto">Add &amp; connect</button>
      </div>
      <div class="muted small" style="margin-top:6px">Personal servers: ${data.servers.length}/${data.max}</div>
    </div>` : ''}
  `);

  if (data.allowed) {
    $('um-kind').onchange = () => {
      const http = $('um-kind').value === 'http';
      $('um-stdio-fields').classList.toggle('hidden', http);
      $('um-http-fields').classList.toggle('hidden', !http);
    };
    $('um-test').onclick = async () => {
      const line = $('um-test-result');
      line.textContent = 'connecting…'; line.className = 'small';
      try {
        const body = $('um-kind').value === 'http'
          ? { kind: 'http', name: $('um-name').value.trim() || 'test', url: $('um-url').value.trim(), headers: $('um-headers').value }
          : { kind: 'stdio', name: $('um-name').value.trim() || 'test', command: $('um-command').value.trim(), args: $('um-args').value.trim(), env: $('um-env').value };
        const r = await api('POST', '/api/mcp/test', body);
        line.textContent = r.ok
          ? `✓ connected · ${r.tools.length} tool${r.tools.length === 1 ? '' : 's'}: ${r.tools.map((t) => t.name).join(', ') || '(none)'}`
          : `✗ ${r.error}`;
        line.className = `small ${r.ok ? 'ok' : 'bad'}`;
      } catch (e) { line.textContent = `✗ ${e.message}`; line.className = 'small bad'; }
    };
    $('um-add').onclick = async () => {
      const body = $('um-kind').value === 'http'
        ? { kind: 'http', name: $('um-name').value.trim(), url: $('um-url').value.trim(), headers: $('um-headers').value }
        : { kind: 'stdio', name: $('um-name').value.trim(), command: $('um-command').value.trim(), args: $('um-args').value.trim(), env: $('um-env').value };
      try {
        await api('POST', '/api/mcp', body);
        toast('MCP server added');
        $('show-usermcp').click();
      } catch (e) { $('um-msg').textContent = e.message; }
    };
  }
  modal.querySelectorAll('[data-uen]').forEach((b) => b.onclick = async () => {
    const s = data.servers.find((x) => x.id == b.dataset.uen);
    await api('PUT', '/api/mcp', { id: s.id, enabled: !s.enabled });
    $('show-usermcp').click();
  });
  modal.querySelectorAll('[data-udel]').forEach((b) => b.onclick = async () => {
    const s = data.servers.find((x) => x.id == b.dataset.udel);
    if (!confirm(`Remove "${s.name}" and disconnect its tools?`)) return;
    await api('DELETE', `/api/mcp?id=${s.id}`);
    toast('Server removed');
    $('show-usermcp').click();
  });
};

// ---------- admin modal (section-based rendering — no full rebuilds) ----------
$('show-admin').onclick = openAdmin;
async function openAdmin() {
  adminData = await api('GET', '/api/admin/overview');
  const { counts, users } = adminData;
  openModal(`
    <h2>⚙️ Admin</h2>
    <p class="muted small" id="adm-stats">${counts.conversations} chats · ${counts.messages} messages · ${counts.memories} memories · ${users.length} users</p>
    <div class="row">
      <button id="export-data">⬇ Export all data (JSON)</button>
      <span class="muted small">Full database dump: users (without passwords), providers, chats, memories.</span>
    </div>
    <div id="stats-box" class="stats-box"></div>

    <h3>Platform</h3>
    <div class="admin-section" id="platform-list"></div>

    <h3>Providers — model backends</h3>
    <div class="admin-section" id="prov-list"></div>
    <div class="card">
      <div class="row"><b id="prov-form-title">Add provider</b>
        <select id="preset-sel"></select>
        <button id="prov-cancel" class="hidden">cancel edit</button>
      </div>
      <div class="grid2">
        <input id="p-name" placeholder="name">
        <select id="p-kind"><option value="openai">openai-compatible</option><option value="anthropic">anthropic</option></select>
        <input id="p-url" placeholder="base URL">
        <input id="p-model" placeholder="model">
        <input id="p-key" placeholder="API key" type="password" style="grid-column: 1 / -1;">
        <input id="p-price-in" placeholder="$ / Mtok input (optional, for cost estimates)">
        <input id="p-price-out" placeholder="$ / Mtok output (optional)">
      </div>
      <p id="prov-msg" class="msg"></p>
      <div class="row">
        <button id="test-prov">test connection</button>
        <span id="test-prov-result" class="small"></span>
        <button class="primary" id="add-prov" style="margin-left:auto">Add provider</button>
      </div>
    </div>

    <h3>MCP servers — custom tools</h3>
    <div class="admin-section" id="mcp-list"></div>
    <div class="card">
      <div class="row"><b>Add MCP server</b>
        <select id="m-kind">
          <option value="stdio">stdio — local process</option>
          <option value="http">HTTP — remote server</option>
        </select>
      </div>
      <div class="grid2" id="m-stdio-fields">
        <input id="m-name" placeholder="name">
        <input id="m-command" placeholder="command e.g. node">
        <input id="m-args" placeholder='args JSON e.g. ["-y","@modelcontextprotocol/server-filesystem","/tmp"]' style="grid-column: 1 / -1;">
        <input id="m-env" placeholder="env lines KEY=val" style="grid-column: 1 / -1;">
      </div>
      <div class="grid2 hidden" id="m-http-fields">
        <input id="m-url" placeholder="https://example.com/mcp" style="grid-column: 1 / -1;">
        <input id="m-headers" placeholder="headers, one per line — e.g. Authorization: Bearer sk-…" style="grid-column: 1 / -1;">
      </div>
      <p id="mcp-msg" class="msg"></p>
      <div class="row">
        <button id="test-mcp">test connection</button>
        <span id="test-mcp-result" class="small"></span>
        <button class="primary" id="add-mcp" style="margin-left:auto">Add &amp; connect</button>
      </div>
    </div>

    <h3>Built-in tools</h3>
    <div class="admin-section" id="tools-list"></div>

    <h3>Persona library — prompts every user can pick</h3>
    <div class="admin-section" id="persona-list"></div>
    <div class="card">
      <div class="grid2">
        <input id="pe-title" placeholder="title, e.g. Code reviewer">
        <button id="pe-add" class="primary">Publish persona</button>
      </div>
      <textarea id="pe-prompt" rows="3" placeholder="The system prompt this persona sets, e.g. You are a meticulous code reviewer…" style="margin-top:8px"></textarea>
      <p id="pe-msg" class="msg"></p>
    </div>

    <h3>Users</h3>
    <input id="user-search" placeholder="Filter users…" style="max-width:260px;">
    <div class="admin-section" id="user-list"></div>

    <div class="card">
      <div class="row"><b>Create user</b>
        <select id="nu-role"><option value="user">user</option><option value="admin">admin</option></select></div>
      <div class="grid2">
        <input id="nu-name" placeholder="username">
        <input id="nu-pass" placeholder="password (min 4 chars)" type="password">
      </div>
      <p id="nu-msg" class="msg"></p>
      <div class="grid2"><button id="nu-create" class="primary">Create user</button></div>
    </div>

    <h3>Audit log</h3>
    <p class="muted small">Security-relevant activity: logins, admin changes, shares, key rotations…</p>
    <div class="grid2" style="max-width:420px">
      <input id="audit-filter" placeholder="filter by action prefix, e.g. login">
      <button id="audit-load">load recent activity</button>
    </div>
    <div class="admin-section" id="audit-list"><p class="muted small">Not loaded yet.</p></div>

    <h3>System</h3>
    <div class="admin-section" id="system-list"><p class="muted small">loading…</p></div>

    <h3>Database backups</h3>
    <p class="muted small">JSON snapshots of every table, stored on the server in <code>data/backups/</code> (the 10 most recent are kept).</p>
    <div class="grid2" style="max-width:420px">
      <button id="backup-create" class="primary">Create backup now</button>
      <button id="backup-refresh">refresh list</button>
    </div>
    <div class="admin-section" id="backup-list"></div>`);
  loadSystemSection();
  renderPersonaSection();

  $('preset-sel').innerHTML = adminData.presets
    .map((p) => `<option value='${esc(JSON.stringify(p))}'>${esc(p.name)}</option>`).join('');
  $('preset-sel').onchange = (e) => {
    const p = JSON.parse(e.target.value);
    editingProviderId = null;
    $('prov-form-title').textContent = 'Add provider';
    $('prov-cancel').classList.add('hidden');
    $('add-prov').textContent = 'Add provider';
    $('p-name').value = p.name === 'Custom (OpenAI-compatible)' ? '' : p.name;
    $('p-kind').value = p.kind; $('p-url').value = p.base_url; $('p-model').value = p.model; $('p-key').value = '';
    $('p-price-in').value = ''; $('p-price-out').value = '';
  };
  $('preset-sel').onchange({ target: $('preset-sel') });

  renderProvSection();
  renderPlatformSection();
  renderMcpSection();
  renderToolsSection();
  renderUsersSection();
  renderStats();
  wireAdminForms();
}

function renderPlatformSection() {
  const s = adminData.settings || {};
  const el = $('platform-list');
  if (!el) return;
  const row = (key, label, hint) => {
    const on = s[key] === '1';
    return `
      <div class="card"><div class="row"><b>${label}</b>
        <span><button data-set="${key}" class="${on ? '' : 'ghost'}">${on ? 'On — turn off' : 'Off — turn on'}</button></span></div>
        <div class="muted small">${hint}</div></div>`;
  };
  const numRow = (key, label, hint, max = 100000, id = `set-${key}`) => `
    <div class="card"><div class="row"><b>${label}</b>
      <span><input id="${id}" type="number" min="0" max="${max}" value="${esc(s[key] ?? '0')}" style="width:90px">
      <button id="${id}-save">save</button></span></div>
      <div class="muted small">${hint}</div></div>`;
  el.innerHTML = `
    ${row('registrations_open', 'Open registration', 'When off, new sign-ups are refused (existing users unaffected).')}
    ${row('allow_memory', 'Memory feature', 'Master switch for AI memory — off disables it for everyone, including tools and saved facts.')}
    ${row('allow_user_mcp', 'Users may connect MCP servers', 'Lets each user register personal stdio/HTTP MCP servers from the 🔌 My tools panel. Turning this off disconnects every personal server until re-enabled.')}
    ${numRow('max_user_mcp', 'Personal MCP limit per user', 'How many personal MCP servers each user may register.', 50)}
    ${row('allow_user_providers', 'Users may add personal providers (BYOK)', 'Lets each user connect their own OpenAI-compatible/Anthropic API keys from the 🧩 panel. Their keys stay private to their account.')}
    ${numRow('max_user_providers', 'Personal provider limit per user', 'How many personal providers each user may register.', 50)}
    ${row('allow_documents', 'Document library', 'Per-user knowledge base; the AI can search it with the knowledge_search tool.')}
    ${numRow('max_documents', 'Documents per user', 'How many documents each user may store.', 500)}
    ${numRow('daily_message_limit', 'Daily message limit', 'Chat messages per user per UTC day. 0 = unlimited. Admins are always exempt.')}
    ${numRow('session_days', 'Login lifetime (days)', 'Sessions older than this are dropped — how long a login stays valid.')}`;
  el.querySelectorAll('[data-set]').forEach((b) => b.onclick = async () => {
    try {
      adminData.settings = await api('PUT', '/api/admin/settings', { [b.dataset.set]: adminData.settings[b.dataset.set] !== '1' });
      renderPlatformSection();
      toast('Setting saved');
    } catch (e) { toast(e.message, 'bad'); }
  });
  for (const key of ['max_user_mcp', 'max_user_providers', 'max_documents', 'daily_message_limit', 'session_days']) {
    const btn = $(`set-${key}-save`);
    if (btn) btn.onclick = async () => {
      try {
        adminData.settings = await api('PUT', '/api/admin/settings', { [key]: Number($(`set-${key}`).value) });
        renderPlatformSection();
        toast('Setting saved');
      } catch (e) { toast(e.message, 'bad'); }
    };
  }
}

function renderStats() {
  const box = $('stats-box');
  if (!box) return;
  const { daily = [], per_user = [], tool_uses = [] } = adminData.stats || {};
  const max = Math.max(1, ...daily.map((d) => d.count));
  const chart = daily.length
    ? `<div class="bar-chart">${daily.map((d) => `
        <div class="bar-col" title="${esc(d.day)}: ${d.count} messages">
          <div class="bar" style="height:${Math.max(6, Math.round((d.count / max) * 72))}px"></div>
          <span class="bar-label">${esc(d.day.slice(5))}</span>
        </div>`).join('')}</div>`
    : '<p class="muted small">No messages in the last 14 days.</p>';
  const usersHtml = per_user.length
    ? per_user.map((u) => `<div class="stat-row"><span>${esc(u.username)}</span><b>${u.messages}</b></div>`).join('')
    : '<p class="muted small">No messages yet.</p>';
  const toolsHtml = tool_uses.length
    ? tool_uses.map((t) => `<div class="stat-row"><span>${esc(t.tool_name)}</span><b>${t.count}</b></div>`).join('')
    : '<p class="muted small">No tool calls yet.</p>';
  box.innerHTML = `
    <div class="stat-block"><h4>Messages · last 14 days</h4>${chart}</div>
    <div class="stat-block"><h4>Most active users</h4>${usersHtml}</div>
    <div class="stat-block"><h4>Most used tools</h4>${toolsHtml}</div>`;
  // rich analytics from the dedicated endpoint: 30-day series, hour-of-day load, model mix
  api('GET', '/api/admin/stats').then((st) => {
    if (!$('stats-box') || !adminData) return;
    const series = (rows, key, label) => {
      if (!rows?.length) return `<p class="muted small">No data yet.</p>`;
      const mx = Math.max(1, ...rows.map((r) => r[key] || r.count));
      return `<div class="bar-chart">${rows.map((r) => `
        <div class="bar-col" title="${esc(r.day || r.hour)}: ${r[key] ?? r.count} ${label}">
          <div class="bar" style="height:${Math.max(4, Math.round(((r[key] ?? r.count) / mx) * 72))}px"></div>
          <span class="bar-label">${esc(String(r.day ? r.day.slice(5) : r.hour))}</span>
        </div>`).join('')}</div>`;
    };
    const grid = document.createElement('div');
    grid.style.gridColumn = '1 / -1';
    grid.innerHTML = `
      <div class="stat-block"><h4>Tokens · last 30 days</h4>${series(st.tokens_daily, 'tokens', 'tokens')}</div>
      <div class="stat-block"><h4>New chats · last 30 days</h4>${series(st.chats_daily, 'count', 'chats')}</div>
      <div class="stat-block"><h4>Activity by hour (UTC, last 7 days)</h4>
        ${st.hours?.length ? `<div class="bar-chart">${Array.from({ length: 24 }, (_, h) => {
          const hit = st.hours.find((x) => Number(x.hour) === h);
          const mx = Math.max(1, ...st.hours.map((x) => x.count));
          return `<div class="bar-col" title="${String(h).padStart(2, '0')}:00 — ${hit?.count || 0} messages">
            <div class="bar" style="height:${Math.max(3, Math.round(((hit?.count || 0) / mx) * 60))}px"></div>
            <span class="bar-label">${h % 6 === 0 ? h : ''}</span>
          </div>`;
        }).join('')}</div>` : '<p class="muted small">No data yet.</p>'}
      </div>
      <div class="stat-block"><h4>Model mix</h4>
        ${st.models?.length ? st.models.map((m) => `<div class="stat-row"><span>${esc(m.model)}</span><b>${m.count} · ${fmtTok(m.tokens)} tok</b></div>`).join('') : '<p class="muted small">No messages yet.</p>'}
      </div>
      <div class="stat-block"><h4>Per-user totals</h4>
        ${st.users?.length ? st.users.slice(0, 12).map((u) => `
          <div class="stat-row"><span>${esc(u.username)} ${u.role === 'admin' ? '⚙️' : ''}</span><b>${u.messages} msg · ${fmtTok(u.tokens)} tok</b></div>`).join('') : '<p class="muted small">No users yet.</p>'}
      </div>`;
    // insert before the announcement block (last child)
    box.insertBefore(grid, box.lastElementChild);
  }).catch(() => {});
  // audit activity summary (last 7 days) as a compact strip
  api('GET', '/api/admin/overview').then((ov) => {
    const rows = ov?.stats?.audit_summary || [];
    if (!rows.length || !$('stats-box') || !adminData) return;
    const strip = document.createElement('div');
    strip.className = 'stat-block';
    strip.style.gridColumn = '1 / -1';
    strip.innerHTML = `<h4>🛡 Activity (audit, last 7 days)</h4>` +
      rows.map((r) => `<span class="tool-tag" title="${r.count} events">${esc(r.action)} · ${r.count}</span>`).join(' ');
    box.insertBefore(strip, box.lastElementChild);
  }).catch(() => {});
  // token totals line
  const tok = adminData.stats?.tokens;
  if (tok) {
    const el = document.createElement('p');
    el.className = 'muted small';
    el.style.marginTop = '10px';
    el.textContent = `Total tokens: ${fmtTok(tok.prompt)} prompt · ${fmtTok(tok.completion)} completion`;
    box.appendChild(el);
  }
  // announcement broadcast form (severity + optional expiry)
  const ann = document.createElement('div');
  ann.className = 'stat-block';
  ann.style.gridColumn = '1 / -1';
  ann.innerHTML = `<h4>📢 Announcement (shown to everyone)</h4>
    <textarea id="ann-text" rows="2" placeholder="Leave empty and send to clear the current announcement"></textarea>
    <div class="grid2" style="margin-top:8px">
      <select id="ann-severity">
        <option value="info">ℹ️ info</option>
        <option value="warn">⚠️ warning</option>
        <option value="critical">🚨 critical</option>
      </select>
      <select id="ann-expiry">
        <option value="">until cleared</option>
        <option value="1">expires in 1 hour</option>
        <option value="24">expires in 24 hours</option>
        <option value="168">expires in 7 days</option>
      </select>
      <button id="ann-send" class="primary">Publish announcement</button>
    </div>`;
  box.appendChild(ann);
  api('GET', '/api/announcements').then((row) => {
    if (row && $('ann-text')) {
      $('ann-text').value = row.text;
      $('ann-severity').value = row.severity || 'info';
    }
  }).catch(() => {});
  $('ann-send').onclick = async () => {
    try {
      await api('POST', '/api/admin/announce', {
        text: $('ann-text').value,
        severity: $('ann-severity').value,
        expires_hours: $('ann-expiry').value ? Number($('ann-expiry').value) : null,
      });
      toast($('ann-text').value.trim() ? 'Announcement published' : 'Announcement cleared');
      loadAnnouncement();
    } catch (e) { toast(e.message, 'bad'); }
  };
  $('export-data').onclick = async () => {
    try {
      const data = await api('GET', '/api/admin/export');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `orionchat-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast('Database exported');
    } catch (e) { toast(e.message, 'bad'); }
  };
}

function updateStats() {
  const { counts, users } = adminData;
  const el = $('adm-stats');
  if (el) el.textContent = `${counts.conversations} chats · ${counts.messages} messages · ${counts.memories} memories · ${users.length} users`;
}

function renderProvSection() {
  const { providers } = adminData;
  const el = $('prov-list');
  el.innerHTML = '';
  for (const p of providers) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="row"><b>${esc(p.name)} <span class="muted small">· ${esc(p.model)}</span></b>
        <span><span class="pill ${p.enabled ? 'on' : 'off'}">${p.enabled ? 'enabled' : 'disabled'}</span>
        <button data-test="${p.id}">test</button>
        <button data-edit="${p.id}">edit</button>
        <button data-toggle="${p.id}">${p.enabled ? 'disable' : 'enable'}</button>
        <button class="danger" data-delp="${p.id}">delete</button></span></div>
      <div class="kv">${esc(p.kind)} · ${esc(p.base_url)}${p.price_in != null || p.price_out != null ? ` · $${p.price_in ?? '?'}/Mtok in, $${p.price_out ?? '?'}/Mtok out` : ''}</div>
      <div class="small test-line" data-testline="${p.id}"></div>`;
    el.appendChild(card);
  }
  if (!providers.length) el.innerHTML = '<div class="card"><p class="muted small">None yet — add one below so chats have a model.</p></div>';

  el.querySelectorAll('[data-toggle]').forEach((b) => b.onclick = async () => {
    const p = providers.find((x) => x.id == b.dataset.toggle);
    await api('POST', '/api/admin/providers', { ...p, enabled: !p.enabled });
    await reloadAdminData(); renderProvSection(); refreshProviderSelect();
    toast(p.enabled ? `${p.name} disabled` : `${p.name} enabled`);
  });
  el.querySelectorAll('[data-delp]').forEach((b) => b.onclick = async () => {
    const p = providers.find((x) => x.id == b.dataset.delp);
    if (!confirm(`Delete provider "${p.name}"?`)) return;
    await api('DELETE', `/api/admin/providers?id=${b.dataset.delp}`);
    await reloadAdminData(); renderProvSection(); refreshProviderSelect();
    toast('Provider deleted');
  });
  el.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => {
    const p = providers.find((x) => x.id == b.dataset.edit);
    editingProviderId = p.id;
    $('prov-form-title').textContent = `Edit: ${p.name}`;
    $('prov-cancel').classList.remove('hidden');
    $('add-prov').textContent = 'Save changes';
    $('p-name').value = p.name; $('p-kind').value = p.kind;
    $('p-url').value = p.base_url; $('p-model').value = p.model; $('p-key').value = p.api_key || '';
    $('p-price-in').value = p.price_in ?? ''; $('p-price-out').value = p.price_out ?? '';
    $('prov-msg').textContent = '';
    $('p-name').focus();
  });
  el.querySelectorAll('[data-test]').forEach((b) => b.onclick = async () => {
    const line = el.querySelector(`[data-testline="${b.dataset.test}"]`);
    line.textContent = 'testing…';
    line.className = 'small test-line';
    try {
      const r = await api('POST', '/api/admin/provider_test', { id: Number(b.dataset.test) });
      line.textContent = r.ok ? `✓ responded in ${r.ms}ms` : `✗ ${r.error}`;
      line.className = `small test-line ${r.ok ? 'ok' : 'bad'}`;
    } catch (e) { line.textContent = `✗ ${e.message}`; line.className = 'small test-line bad'; }
  });
}

function renderMcpSection() {
  const { mcp_servers } = adminData;
  const el = $('mcp-list');
  el.innerHTML = '';
  for (const m of mcp_servers) {
    const card = document.createElement('div');
    card.className = 'card';
    const isHttp = m.kind === 'http';
    const endpoint = isHttp ? esc(m.url) : `${esc(m.command)} ${esc(m.args)}`;
    const statePill = !m.enabled
      ? '<span class="pill off">disabled</span>'
      : m.state_error
        ? `<span class="pill err" title="${esc(m.state_error)}">error</span>`
        : m.tools?.length
          ? `<span class="pill on">${m.tools.filter((t) => t.enabled).length}/${m.tools.length} tools</span>`
          : '<span class="pill off">no tools yet</span>';
    const toolTags = m.tools?.length
      ? `<div class="tool-names">${m.tools.map((t) =>
          `<button class="tool-tag ${t.enabled ? '' : 'tag-off'}" data-ttool="${esc(t.ns)}" data-en="${t.enabled ? 1 : 0}" title="${esc(t.orig)} — click to ${t.enabled ? 'disable' : 'enable'}">${esc(t.orig)}</button>`
        ).join('')}</div>
        <div class="kv">click a tool to enable/disable it for chats</div>`
      : '';
    card.innerHTML = `
      <div class="row"><b>${esc(m.name)}</b> <span class="pill kind">${isHttp ? 'http' : 'stdio'}</span>
        <span>${statePill}
        <button data-mtest="${m.id}">test</button>
        <button data-mrestart="${m.id}">restart</button>
        <button data-mtoggle="${m.id}">${m.enabled ? 'disable' : 'enable'}</button>
        <button class="danger" data-delm="${m.id}">delete</button></span></div>
      <div class="kv">${endpoint}</div>
      ${(m.extras?.resources?.length || m.extras?.prompts?.length)
        ? `<div class="kv">📚 ${m.extras.resources.length} resource${m.extras.resources.length === 1 ? '' : 's'} · 💬 ${m.extras.prompts.length} prompt template${m.extras.prompts.length === 1 ? '' : 's'}</div>`
        : ''}
      ${toolTags}
      <div class="small test-line" data-mtestline="${m.id}"></div>`;
    el.appendChild(card);
  }
  if (!mcp_servers.length) el.innerHTML = '<div class="card"><p class="muted small">None connected. Add a local process (stdio) or a remote server (HTTP URL) below.</p></div>';

  el.querySelectorAll('[data-ttool]').forEach((b) => b.onclick = async () => {
    await api('POST', '/api/admin/tool_settings', { tool_id: b.dataset.ttool, enabled: b.dataset.en !== '1' });
    await reloadAdminData(); renderMcpSection(); loadToolsBadge();
  });
  el.querySelectorAll('[data-mtoggle]').forEach((b) => b.onclick = async () => {
    const m = mcp_servers.find((x) => x.id == b.dataset.mtoggle);
    await api('POST', '/api/admin/mcp_servers', { ...m, enabled: !m.enabled });
    await reloadAdminData(); renderMcpSection(); loadToolsBadge();
    toast(m.enabled ? `${m.name} disabled` : `${m.name} enabled`);
  });
  el.querySelectorAll('[data-delm]').forEach((b) => b.onclick = async () => {
    const m = mcp_servers.find((x) => x.id == b.dataset.delm);
    if (!confirm(`Delete MCP server "${m.name}"?`)) return;
    await api('DELETE', `/api/admin/mcp_servers?id=${b.dataset.delm}`);
    await reloadAdminData(); renderMcpSection(); loadToolsBadge();
    toast('MCP server deleted');
  });
  el.querySelectorAll('[data-mtest]').forEach((b) => b.onclick = async () => {
    const m = mcp_servers.find((x) => x.id == b.dataset.mtest);
    const line = el.querySelector(`[data-mtestline="${b.dataset.mtest}"]`);
    line.textContent = 'connecting…';
    line.className = 'small test-line';
    try {
      const body = m.kind === 'http'
        ? { kind: 'http', name: m.name, url: m.url, headers: m.headers }
        : { kind: 'stdio', name: m.name, command: m.command, args: m.args, env: m.env };
      const r = await api('POST', '/api/admin/mcp_test', body);
      line.textContent = r.ok
        ? `✓ connected · ${r.tools.length} tool${r.tools.length === 1 ? '' : 's'}: ${r.tools.map((t) => t.name).join(', ') || '(none)'}`
        : `✗ ${r.error}`;
      line.className = `small test-line ${r.ok ? 'ok' : 'bad'}`;
      if (r.ok) { await reloadAdminData(); renderMcpSection(); loadToolsBadge(); }
    } catch (e) { line.textContent = `✗ ${e.message}`; line.className = 'small test-line bad'; }
  });
  el.querySelectorAll('[data-mrestart]').forEach((b) => b.onclick = async () => {
    const m = mcp_servers.find((x) => x.id == b.dataset.mrestart);
    const line = el.querySelector(`[data-mtestline="${b.dataset.mrestart}"]`);
    line.textContent = 'restarting…';
    line.className = 'small test-line';
    try {
      const r = await api('POST', '/api/admin/mcp_restart', { id: m.id });
      line.textContent = r.ok
        ? `✓ restarted · ${r.tools.length} tool${r.tools.length === 1 ? '' : 's'}`
        : `✗ ${r.error}`;
      line.className = `small test-line ${r.ok ? 'ok' : 'bad'}`;
      await reloadAdminData(); renderMcpSection(); loadToolsBadge();
    } catch (e) { line.textContent = `✗ ${e.message}`; line.className = 'small test-line bad'; }
  });
}

function renderToolsSection() {
  const { builtin_tools } = adminData;
  const el = $('tools-list');
  el.innerHTML = '';
  for (const t of builtin_tools) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="row"><span><b>${esc(t.id)}</b> <span class="muted small">${esc(t.description)}</span></span>
        <button data-tool="${t.id}" data-en="${t.enabled ? 1 : 0}">${t.enabled ? 'disable' : 'enable'}</button></div>`;
    el.appendChild(card);
  }
  el.querySelectorAll('[data-tool]').forEach((b) => b.onclick = async () => {
    await api('POST', '/api/admin/tool_settings', { tool_id: b.dataset.tool, enabled: b.dataset.en !== '1' });
    await reloadAdminData(); renderToolsSection(); loadToolsBadge();
  });
}

function renderUsersSection() {
  const { users } = adminData;
  const el = $('user-list');
  el.innerHTML = '';
  const filtered = userFilter
    ? users.filter((u) => u.username.toLowerCase().includes(userFilter.toLowerCase()))
    : users;
  for (const u of filtered) {
    const card = document.createElement('div');
    card.className = 'card';
    const isSelf = u.id === me.id;
    const activity = (adminData.stats?.per_user || []).find((s) => s.username === u.username);
    card.innerHTML = `
      <div class="row"><b>${esc(u.username)}</b>
        <span class="pill ${u.role === 'admin' ? 'on' : 'off'}">${esc(u.role)}</span>
        ${Number(u.totp_enabled) ? '<span class="pill ok" title="two-factor enabled">2FA</span>' : ''}
        <span>
          <button data-copy="${u.id}" title="copy API key">copy key</button>
          <button data-rot="${u.id}">rotate key</button>
          <button data-mem="${u.id}" title="allow or block the memory feature for this user">memory: ${Number(u.memory_allowed) ? 'allowed' : 'blocked'}</button>
          <button data-pw="${u.id}">set password</button>
          ${isSelf ? '' : `<button data-imp="${u.id}" title="sign this browser in as the user (support tool, audited)">impersonate</button>`}
          ${isSelf ? '' : `<button data-flo="${u.id}" title="revoke every session of this user">logout everywhere</button>`}
          ${isSelf ? '' : `<button data-role="${u.id}" data-to="${u.role === 'admin' ? 'user' : 'admin'}">make ${u.role === 'admin' ? 'user' : 'admin'}</button>`}
          ${isSelf ? '' : `<button class="danger" data-delu="${u.id}">delete</button>`}
        </span></div>
      <div class="kv">API key: ${esc(u.api_key)}</div>
      <div class="kv">daily limit: ${Number(u.quota_override) === -1 ? 'unlimited' : Number(u.quota_override) > 0 ? u.quota_override + '/day' : 'global default'}
        <button data-quota="${u.id}" title="-2 = global, -1 = unlimited, or a number">edit</button></div>
      <div class="kv">${activity ? `${activity.messages} messages` : 'no messages'}${u.last_activity ? ` · last seen ${timeLabel(u.last_activity)}` : ''}${Number(u.documents) ? ` · 🗂 ${u.documents}` : ''}${Number(u.mcp_servers) ? ` · 🔌 ${u.mcp_servers}` : ''}${Number(u.providers) ? ` · 🧩 ${u.providers}` : ''}</div>`;
    el.appendChild(card);
  }
  if (!filtered.length) el.innerHTML = '<div class="card"><p class="muted small">No users match.</p></div>';

  el.querySelectorAll('[data-copy]').forEach((b) => b.onclick = async () => {
    const u = users.find((x) => x.id == b.dataset.copy);
    try { await navigator.clipboard.writeText(u.api_key); toast('API key copied'); }
    catch { prompt('API key:', u.api_key); }
  });
  el.querySelectorAll('[data-rot]').forEach((b) => b.onclick = async () => {
    if (!confirm('Rotate this API key? The old key stops working immediately.')) return;
    await api('POST', '/api/admin/users', { action: 'rotate_key', id: Number(b.dataset.rot) });
    await reloadAdminData(); renderUsersSection();
    toast('API key rotated');
  });
  el.querySelectorAll('[data-mem]').forEach((b) => b.onclick = async () => {
    const u = users.find((x) => x.id == b.dataset.mem);
    if (!Number(u.memory_allowed) && !confirm(`Re-allow memory for "${u.username}"?`)) return;
    await api('POST', '/api/admin/users', { action: 'set_memory', id: u.id, allowed: !Number(u.memory_allowed) });
    await reloadAdminData(); renderUsersSection();
    toast(Number(u.memory_allowed) ? 'Memory blocked for ' + u.username : 'Memory allowed for ' + u.username);
  });
  el.querySelectorAll('[data-pw]').forEach((b) => b.onclick = () => {
    const u = users.find((x) => x.id == b.dataset.pw);
    const pw = prompt(`New password for ${u.username}:`);
    if (pw === null) return;
    if (pw.length < 4) { toast('Password must be at least 4 chars', 'bad'); return; }
    api('POST', '/api/admin/users', { action: 'set_password', id: u.id, password: pw })
      .then(() => toast(`Password set for ${u.username}`))
      .catch((e) => toast(e.message, 'bad'));
  });
  el.querySelectorAll('[data-quota]').forEach((b) => b.onclick = async () => {
    const u = users.find((x) => x.id == b.dataset.quota);
    const v = prompt(`Daily message limit for "${u.username}":\n-2 = follow the global default\n-1 = unlimited\n0 = blocked\nn = n messages per day`, u.quota_override ?? -2);
    if (v === null) return;
    const q = Number(v);
    if (![-2, -1].includes(q) && !(q >= 0)) { toast('Use -2, -1 or a number ≥ 0', 'bad'); return; }
    await api('POST', '/api/admin/users', { action: 'set_quota', id: u.id, quota: q });
    await reloadAdminData(); renderUsersSection();
    toast('Quota updated');
  });
  el.querySelectorAll('[data-flo]').forEach((b) => b.onclick = async () => {
    const u = users.find((x) => x.id == b.dataset.flo);
    if (!confirm(`Revoke every session of "${u.username}"? All their logged-in devices are signed out.`)) return;
    await api('POST', '/api/admin/users', { action: 'logout_everywhere', id: u.id });
    toast(`All sessions of ${u.username} revoked`);
  });
  el.querySelectorAll('[data-role]').forEach((b) => b.onclick = async () => {
    await api('POST', '/api/admin/users', { action: 'set_role', id: Number(b.dataset.role), role: b.dataset.to });
    await reloadAdminData(); renderUsersSection();
    toast('Role updated');
  });
  el.querySelectorAll('[data-imp]').forEach((b) => b.onclick = async () => {
    const u = users.find((x) => x.id == b.dataset.imp);
    if (!confirm(`Sign this browser in as "${u.username}"? You will need to log in again with your own password to return. This is recorded in the audit log.`)) return;
    try {
      await api('POST', '/api/admin/users', { action: 'impersonate', id: u.id });
      toast(`Now viewing as ${u.username}`);
      location.reload();
    } catch (e) { toast(e.message, 'bad'); }
  });
  el.querySelectorAll('[data-delu]').forEach((b) => b.onclick = async () => {
    const u = users.find((x) => x.id == b.dataset.delu);
    if (!confirm(`Delete user "${u.username}" and all their chats/memories?`)) return;
    await api('POST', '/api/admin/users', { action: 'delete', id: Number(b.dataset.delu) });
    await reloadAdminData(); renderUsersSection(); updateStats();
    toast('User deleted');
  });
}

function wireAdminForms() {
  $('user-search').oninput = (e) => { userFilter = e.target.value; renderUsersSection(); };

  $('prov-cancel').onclick = () => {
    editingProviderId = null;
    $('prov-form-title').textContent = 'Add provider';
    $('prov-cancel').classList.add('hidden');
    $('add-prov').textContent = 'Add provider';
    $('p-name').value = ''; $('p-url').value = ''; $('p-model').value = ''; $('p-key').value = '';
    $('p-price-in').value = ''; $('p-price-out').value = '';
    $('preset-sel').onchange({ target: $('preset-sel') });
  };

  $('add-prov').onclick = async () => {
    const btn = $('add-prov');
    const body = {
      name: $('p-name').value.trim(), kind: $('p-kind').value,
      base_url: $('p-url').value.trim(), model: $('p-model').value.trim(), api_key: $('p-key').value,
      price_in: $('p-price-in').value === '' ? null : Number($('p-price-in').value),
      price_out: $('p-price-out').value === '' ? null : Number($('p-price-out').value),
    };
    if (!body.name || !body.base_url || !body.model) { $('prov-msg').textContent = 'Name, base URL and model are required'; return; }
    try {
      btn.disabled = true;
      const wasEditing = !!editingProviderId;
      if (wasEditing) { body.id = editingProviderId; body.enabled = adminData.providers.find((p) => p.id === editingProviderId).enabled; }
      await api('POST', '/api/admin/providers', body);
      $('prov-msg').textContent = '';
      $('prov-cancel').click();
      await reloadAdminData(); renderProvSection(); refreshProviderSelect();
      toast(wasEditing ? 'Provider saved' : 'Provider added');
    } catch (e) { $('prov-msg').textContent = e.message; }
    btn.disabled = false;
  };

  $('test-prov').onclick = async () => {
    const line = $('test-prov-result');
    line.textContent = 'testing…'; line.className = 'small';
    try {
      const body = editingProviderId
        ? { id: editingProviderId }
        : { name: $('p-name').value.trim(), kind: $('p-kind').value, base_url: $('p-url').value.trim(), model: $('p-model').value.trim(), api_key: $('p-key').value };
      const r = await api('POST', '/api/admin/provider_test', body);
      line.textContent = r.ok ? `✓ responded in ${r.ms}ms` : `✗ ${r.error}`;
      line.className = `small ${r.ok ? 'ok' : 'bad'}`;
    } catch (e) { line.textContent = `✗ ${e.message}`; line.className = 'small bad'; }
  };

  $('m-kind').onchange = () => {
    const http = $('m-kind').value === 'http';
    $('m-stdio-fields').classList.toggle('hidden', http);
    $('m-http-fields').classList.toggle('hidden', !http);
  };

  $('test-mcp').onclick = async () => {
    const line = $('test-mcp-result');
    line.textContent = 'connecting…'; line.className = 'small';
    try {
      const body = $('m-kind').value === 'http'
        ? { kind: 'http', name: $('m-name').value.trim() || 'test', url: $('m-url').value.trim(), headers: $('m-headers').value }
        : { kind: 'stdio', name: $('m-name').value.trim() || 'test', command: $('m-command').value.trim(), args: $('m-args').value.trim(), env: $('m-env').value };
      const r = await api('POST', '/api/admin/mcp_test', body);
      line.textContent = r.ok
        ? `✓ connected · ${r.tools.length} tool${r.tools.length === 1 ? '' : 's'}: ${r.tools.map((t) => t.name).join(', ') || '(none)'}`
        : `✗ ${r.error}`;
      line.className = `small ${r.ok ? 'ok' : 'bad'}`;
    } catch (e) { line.textContent = `✗ ${e.message}`; line.className = 'small bad'; }
  };

  $('add-mcp').onclick = async () => {
    const btn = $('add-mcp');
    try {
      btn.disabled = true;
      await api('POST', '/api/admin/mcp_servers', {
        name: $('m-name').value.trim(), kind: $('m-kind').value,
        command: $('m-command').value.trim(), args: $('m-args').value.trim(),
        env: $('m-env').value, url: $('m-url').value.trim(), headers: $('m-headers').value,
      });
      $('mcp-msg').textContent = '';
      $('m-name').value = ''; $('m-command').value = ''; $('m-args').value = ''; $('m-env').value = '';
      $('m-url').value = ''; $('m-headers').value = '';
      $('test-mcp-result').textContent = '';
      await reloadAdminData(); renderMcpSection(); loadToolsBadge();
      toast('MCP server added');
    } catch (e) { $('mcp-msg').textContent = e.message; }
    btn.disabled = false;
  };

  $('nu-create').onclick = async () => {
    const uname = $('nu-name').value.trim();
    try {
      await api('POST', '/api/admin/users', {
        action: 'create', username: uname, password: $('nu-pass').value, role: $('nu-role').value,
      });
      $('nu-name').value = ''; $('nu-pass').value = ''; $('nu-msg').textContent = '';
      await reloadAdminData(); renderUsersSection(); updateStats();
      toast(`User "${uname}" created`);
    } catch (e) { $('nu-msg').textContent = e.message; }
  };

  $('pe-add').onclick = async () => {
    try {
      await api('POST', '/api/admin/personas', { title: $('pe-title').value, prompt: $('pe-prompt').value });
      $('pe-title').value = ''; $('pe-prompt').value = ''; $('pe-msg').textContent = '';
      renderPersonaSection();
      toast('Persona published');
    } catch (e) { $('pe-msg').textContent = e.message; }
  };

  $('backup-create').onclick = async () => {
    try {
      $('backup-create').disabled = true;
      const r = await api('POST', '/api/admin/backup');
      toast(`Backup created (${r.file})`);
      renderBackupList();
    } catch (e) { toast(e.message, 'bad'); }
    $('backup-create').disabled = false;
  };
  $('backup-refresh').onclick = renderBackupList;
  renderBackupList();
  const loadAuditFn = async () => {
    const box = $('audit-list');
    const action = $('audit-filter').value.trim();
    box.innerHTML = '<p class="muted small">loading…</p>';
    try {
      const rows = await api('GET', `/api/admin/audit?limit=150${action ? `&action=${encodeURIComponent(action)}` : ''}`);
      box.innerHTML = rows.length ? `
        <table class="audit-table">
          <thead><tr><th>when</th><th>user</th><th>action</th><th>detail</th></tr></thead>
          <tbody>
            ${rows.map((r) => `<tr>
              <td class="muted small">${esc(r.created_at)}</td>
              <td>${esc(r.username || '—')}</td>
              <td><span class="tool-tag">${esc(r.action)}</span></td>
              <td class="muted small">${esc(r.detail || '')}</td>
            </tr>`).join('')}
          </tbody>
        </table>`
        : '<p class="muted small">No entries match.</p>';
    } catch (e) { box.innerHTML = `<p class="muted small">✗ ${esc(e.message)}</p>`; }
  };
  $('audit-load').onclick = loadAuditFn;
  $('audit-filter').addEventListener('keydown', (e) => e.key === 'Enter' && loadAuditFn());
}

async function reloadAdminData() {
  adminData = await api('GET', '/api/admin/overview');
}

// persona library (admin-curated; users pick these in 🎛 chat settings)
async function renderPersonaSection() {
  const el = $('persona-list');
  if (!el) return;
  const personas = await api('GET', '/api/personas').catch(() => []);
  el.innerHTML = '';
  for (const p of personas) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<div class="row"><b>${esc(p.title)}</b>
        <span><button class="danger" data-pedel="${p.id}">delete</button></span></div>
      <div class="muted small">${esc(p.prompt.slice(0, 160))}${p.prompt.length > 160 ? '…' : ''}</div>`;
    card.querySelector('[data-pedel]').onclick = async () => {
      if (!confirm(`Remove persona "${p.title}" from the library?`)) return;
      await api('DELETE', `/api/admin/personas?id=${p.id}`);
      renderPersonaSection();
      toast('Persona removed');
    };
    el.appendChild(card);
  }
  if (!personas.length) el.innerHTML = '<div class="card"><p class="muted small">Library is empty — publish one below.</p></div>';
}

// live server vitals for ops
async function loadSystemSection() {
  const el = $('system-list');
  if (!el) return;
  try {
    const s = await api('GET', '/api/admin/system');
    const row = (k, v) => `<div class="stat-row"><span>${k}</span><b>${v}</b></div>`;
    const mcp = s.mcp_connections?.length
      ? s.mcp_connections.map((c) => `<span class="tool-tag ${c.ok ? '' : 'tag-off'}" title="${esc(c.error || '')}">${esc(c.id)}${c.ok ? ` · ${c.tools}` : ' · ✗'}</span>`).join(' ')
      : '<span class="muted small">none</span>';
    el.innerHTML = `
      <div class="card">
        ${row('version', esc(s.version))}
        ${row('node', esc(s.node) + ' · ' + esc(s.platform))}
        ${row('uptime', Math.floor(s.uptime_s / 3600) + 'h ' + Math.floor((s.uptime_s % 3600) / 60) + 'm')}
        ${row('memory (rss / heap)', s.rss_mb + ' MB / ' + s.heap_mb + ' MB')}
        ${row('database size', s.db_size_mb + ' MB')}
        ${row('active sessions', s.sessions_active)}
        ${row('pending reminders', s.tasks_pending)}
        ${row('documents stored', s.documents)}
        ${row('enabled providers', s.providers_enabled)}
        ${row('active share links', s.shares_active)}
        <div class="kv" style="margin-top:6px">MCP connections: ${mcp}</div>
      </div>`;
  } catch (e) { el.innerHTML = `<p class="muted small">✗ ${esc(e.message)}</p>`; }
}

// server-side JSON backups (stored under data/backups)
async function renderBackupList() {
  const el = $('backup-list');
  if (!el) return;
  const files = await api('GET', '/api/admin/backup').catch(() => []);
  el.innerHTML = files.length ? files.map((f) => `
    <div class="card"><div class="row"><b>${esc(f.name)}</b>
      <span><span class="muted small">${(f.bytes / 1024).toFixed(1)} KB · ${timeLabel(f.created_at)}</span>
      <button data-bdl="${esc(f.name)}">download</button>
      <button class="danger" data-bdel="${esc(f.name)}">delete</button></span></div></div>`).join('')
    : '<div class="card"><p class="muted small">No backups yet.</p></div>';
  el.querySelectorAll('[data-bdl]').forEach((b) => b.onclick = () => {
    const a = document.createElement('a');
    a.href = `/api/admin/backup/download?name=${encodeURIComponent(b.dataset.bdl)}`;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  });
  el.querySelectorAll('[data-bdel]').forEach((b) => b.onclick = async () => {
    if (!confirm(`Delete backup "${b.dataset.bdel}"?`)) return;
    await api('DELETE', `/api/admin/backup?name=${encodeURIComponent(b.dataset.bdel)}`);
    renderBackupList();
    toast('Backup deleted');
  });
}

function openModal(html) {
  setDrawer(false); // never let the drawer sit under a modal sheet on phones
  $('modal-body').innerHTML = html;
  modal.classList.remove('hidden');
}

// ---------- in-chat message filter (long conversations) ----------
$('filter-btn').onclick = () => {
  const bar = $('filter-bar');
  bar.classList.toggle('hidden');
  if (!bar.classList.contains('hidden')) $('filter-input').focus();
  else { applyChatFilter(''); $('filter-role').value = 'all'; }
};
let filterRole = 'all';
function applyChatFilter(q) {
  const needle = q.trim().toLowerCase();
  document.querySelectorAll('#messages .msg-row').forEach((row) => {
    const roleOk = filterRole === 'all' || row.classList.contains(filterRole === 'user' ? 'user' : 'assistant');
    const textOk = !needle || row.textContent.toLowerCase().includes(needle);
    row.classList.toggle('filtered-out', !textOk || !roleOk);
  });
}
$('filter-input').addEventListener('input', (e) => applyChatFilter(e.target.value));
$('filter-role').addEventListener('change', (e) => { filterRole = e.target.value; applyChatFilter($('filter-input').value); });
$('filter-clear').onclick = () => { $('filter-input').value = ''; $('filter-role').value = 'all'; filterRole = 'all'; applyChatFilter(''); $('filter-bar').classList.add('hidden'); };

// warn before leaving while the model is still writing
window.addEventListener('beforeunload', (e) => {
  if (sending) { e.preventDefault(); e.returnValue = ''; }
});

// ---------- outline: jump between your own turns in long chats ----------
function renderOutline(msgs) {
  const sel = $('outline-select');
  if (!sel) return;
  const userMsgs = msgs.filter((m) => m.role === 'user' && m.id);
  if (userMsgs.length < 6) { sel.classList.add('hidden'); return; }
  sel.innerHTML = `<option value="">⤵ Jump to question…</option>` +
    userMsgs.map((m, i) => `<option value="${m.id}">#${i + 1} · ${esc(String(m.content).slice(0, 60))}</option>`).join('');
  sel.classList.remove('hidden');
  sel.onchange = () => {
    if (!sel.value) return;
    const el = document.querySelector(`.msg-row[data-mid="${sel.value}"]`);
    if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    sel.value = '';
  };
}

// ---------- live char/token estimate in the composer ----------
inputEl.addEventListener('input', () => {
  const n = inputEl.value.length;
  $('char-estimate').textContent = n > 40 ? `≈ ${n} chars · ~${Math.ceil(n / 4)} tokens · ` : '';
});

// ---------- scroll-to-bottom (and don't yank the reader away mid-scroll) ----------
const scrollBtn = $('scroll-btn');
const messagesEl = $('messages');
let userScrolledUp = false;
messagesEl.addEventListener('scroll', () => {
  const far = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight > 240;
  userScrolledUp = far;
  scrollBtn.classList.toggle('hidden', !far || !messagesEl.children.length);
});
function scrollToLatest(force = false) {
  if (force || !userScrolledUp) messagesEl.scrollTop = messagesEl.scrollHeight;
}
scrollBtn.onclick = () => messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: 'smooth' });

// ---------- export conversation as Markdown / JSON (server-side) ----------
function updateExportVisibility() {
  const on = !!activeConv;
  $('export-btn').classList.toggle('hidden', !on);
  $('share-btn').classList.toggle('hidden', !on);
  $('copy-conv-btn').classList.toggle('hidden', !on);
  $('filter-btn').classList.toggle('hidden', !on);
  $('conv-settings-btn').classList.toggle('hidden', !on);
}
$('copy-conv-btn').onclick = async () => {
  try {
    const msgs = await api('GET', `/api/conversation/${activeConv}/messages`);
    const conv = convs.find((c) => c.id === activeConv);
    const text = msgs
      .filter((m) => ['user', 'assistant'].includes(m.role))
      .map((m) => `${m.role === 'user' ? 'You' : 'Assistant'}: ${m.content}`)
      .join('\n\n');
    await navigator.clipboard.writeText(`# ${conv?.title || 'Conversation'}\n\n${text}`);
    toast('Conversation copied as text');
  } catch (e) { toast(e.message, 'bad'); }
};
$('export-btn').onclick = () => {
  if (!activeConv) return;
  const a = document.createElement('a');
  a.href = `/api/conversation/${activeConv}/export`;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast('Chat exported');
};

// ---------- per-chat settings: persona + temperature + privacy + project ----------
$('conv-settings-btn').onclick = async () => {
  const conv = convs.find((c) => c.id === activeConv);
  let projects = [];
  let personas = [];
  let stats = null;
  try { projects = await api('GET', '/api/projects'); } catch {}
  try { personas = await api('GET', '/api/personas'); } catch {}
  try {
    const msgs = await api('GET', `/api/conversation/${activeConv}/messages`);
    const turns = msgs.filter((m) => m.role === 'user').length;
    const tok = msgs.reduce((s, m) => s + (Number(m.prompt_tokens) || 0) + (Number(m.completion_tokens) || 0), 0);
    const models = [...new Set(msgs.map((m) => m.model).filter(Boolean))];
    stats = { turns, msgs: msgs.length, tok, models };
  } catch {}
  openModal(`
    <h2>🎛 Chat settings</h2>
    <p class="muted small">These apply to <b>${esc(conv?.title || 'this chat')}</b> only.</p>
    ${stats ? `<div class="usage-grid">
      <div class="usage-card"><b>${stats.turns}</b><span>exchanges</span></div>
      <div class="usage-card"><b>${stats.msgs}</b><span>messages</span></div>
      <div class="usage-card"><b>${fmtTok(stats.tok)}</b><span>tokens</span></div>
      <div class="usage-card"><b style="font-size:12px">${stats.models.length ? esc(stats.models.join(', ')) : '—'}</b><span>models</span></div>
    </div>` : ''}
    <div class="card">
      <div class="row"><b>🕶 Private chat</b>
        <span><input type="checkbox" id="cs-private" ${conv?.private ? 'checked' : ''} style="width:18px"></span></div>
      <div class="muted small">The AI can't read your memories or save new ones in this chat. Memory stays on everywhere else.</div>
    </div>
    <label class="field"><span>Project</span>
      <select id="cs-project">
        <option value="">— none —</option>
        ${projects.map((p) => `<option value="${p.id}" ${conv?.project_id === p.id ? 'selected' : ''}>🗂 ${esc(p.name)}</option>`).join('')}
      </select></label>
    <div class="muted small" style="margin:-6px 0 10px">Projects can carry a shared persona — the chat's own persona below wins when both are set.</div>
    ${personas.length ? `
    <label class="field"><span>Persona from the library</span>
      <select id="cs-persona-pick">
        <option value="">— pick a saved persona —</option>
        ${personas.map((p) => `<option value="${esc(p.prompt)}">${esc(p.title)}</option>`).join('')}
      </select></label>` : ''}
    <label class="field"><span>Persona / system prompt (overrides the default)</span>
      <textarea id="cs-persona" rows="5" placeholder="e.g. You are a terse senior Rust reviewer. Always show diffs.">${esc(conv?.system_prompt || '')}</textarea></label>
    <label class="field"><span>Temperature: <b id="cs-temp-val">${conv?.temperature ?? 'default'}</b></span>
      <input type="range" id="cs-temp" min="0" max="2" step="0.1" value="${conv?.temperature ?? 0.7}">
    </label>
    <div class="grid2">
      <button id="cs-save" class="primary">Save</button>
      <button id="cs-clear">Reset to default</button>
    </div>
    <h3 style="margin-top:16px">Danger zone</h3>
    <div class="grid2">
      <button id="cs-wipe">🧹 Clear all messages (keep chat)</button>
      <button id="cs-delete" class="danger">🗑 Delete this chat</button>
    </div>
  `);
  const range = $('cs-temp');
  range.oninput = () => { $('cs-temp-val').textContent = range.value; };
  if ($('cs-persona-pick')) {
    $('cs-persona-pick').onchange = (e) => {
      if (e.target.value) $('cs-persona').value = e.target.value;
    };
  }
  $('cs-wipe').onclick = async () => {
    if (!confirm('Delete every message in this chat? The chat and its settings stay.')) return;
    await api('POST', '/api/conversations/clear', { id: activeConv });
    toast('Chat cleared');
    closeModal();
    renderMessages([]);
  };
  $('cs-delete').onclick = async () => {
    if (!confirm('Delete this chat permanently?')) return;
    const id = activeConv;
    activeConv = null;
    localStorage.removeItem('oc_conv');
    await api('DELETE', `/api/conversations?id=${id}`);
    toast('Chat deleted');
    closeModal();
    renderMessages([]);
    loadConvs();
  };
  $('cs-save').onclick = async () => {
    const projVal = $('cs-project').value;
    await api('PUT', '/api/conversation/settings', {
      id: activeConv,
      system_prompt: $('cs-persona').value,
      temperature: Number(range.value),
      private: $('cs-private').checked,
      project_id: projVal ? Number(projVal) : null,
    });
    toast('Chat settings saved');
    closeModal();
    loadConvs();
  };
  $('cs-clear').onclick = async () => {
    await api('PUT', '/api/conversation/settings', { id: activeConv, system_prompt: '', temperature: null });
    toast('Reset to defaults');
    closeModal();
    loadConvs();
  };
};

// ---------- share links ----------
$('share-btn').onclick = async () => {
  const r = await api('POST', '/api/conversations/share', { id: activeConv });
  const url = location.origin + r.url;
  openModal(`
    <h2>🔗 Share this chat</h2>
    <p class="muted small">Anyone with this link can read the transcript — no login needed. Revoking the link makes it inaccessible everywhere.</p>
    <div class="share-box"><code id="share-url">${esc(url)}</code></div>
    <div class="grid2">
      <button id="share-copy" class="primary">Copy link</button>
      <button id="share-open">Open</button>
    </div>
    <div class="grid2" style="margin-top:8px">
      <button id="share-revoke">Revoke link</button>
    </div>
  `);
  $('share-copy').onclick = async () => {
    try { await navigator.clipboard.writeText(url); toast('Link copied'); }
    catch { toast('Copy failed — select it manually', 'bad'); }
  };
  $('share-open').onclick = () => window.open(r.url, '_blank');
  $('share-revoke').onclick = async () => {
    await api('DELETE', `/api/conversations/share?id=${activeConv}`);
    toast('Share link revoked');
    closeModal();
  };
};

// ---------- announcements (admin broadcast) ----------
async function loadAnnouncement() {
  try {
    const row = await api('GET', '/api/announcements');
    if (!row) return;
    const key = `oc_ann_read_${row.id}`;
    if (localStorage.getItem(key)) return;
    $('announce-text').textContent = '📢 ' + row.text;
    $('announce-banner').dataset.severity = row.severity || 'info';
    $('announce-banner').classList.remove('hidden');
    $('announce-close').onclick = () => {
      localStorage.setItem(key, '1');
      $('announce-banner').classList.add('hidden');
    };
  } catch { /* non-fatal */ }
}

// ---------- my usage ----------
$('show-usage').onclick = async () => {
  const s = await api('GET', '/api/me/stats');
  const totalTok = Number(s.tokens?.prompt || 0) + Number(s.tokens?.completion || 0);
  const maxDaily = Math.max(1, ...s.daily.map((d) => d.count));
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const day = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const hit = s.daily.find((d) => d.day === day);
    days.push({ day, count: hit?.count || 0 });
  }
  const q = s.quota || {};
  const quotaBar = q.limit
    ? `<div class="usage-card quota ${q.used >= q.limit ? 'hit' : ''}"><b>${q.used}/${q.limit}</b><span>today's messages${q.used >= q.limit ? ' — limit reached' : ''}</span>
       <div class="quota-bar"><div class="quota-fill" style="width:${Math.min(100, Math.round((q.used / q.limit) * 100))}%"></div></div></div>`
    : `<div class="usage-card"><b>∞</b><span>no daily limit</span></div>`;
  openModal(`
    <h2>📊 Your usage</h2>
    <div class="usage-grid">
      <div class="usage-card"><b>${s.conversations}</b><span>chats</span></div>
      <div class="usage-card"><b>${s.messages}</b><span>messages</span></div>
      <div class="usage-card"><b>${fmtTok(totalTok)}</b><span>tokens</span></div>
      ${quotaBar}
      ${s.est_cost_usd ? `<div class="usage-card"><b>$${Number(s.est_cost_usd).toFixed(2)}</b><span>estimated spend</span></div>` : ''}
      ${s.starred ? `<div class="usage-card"><b>${s.starred}</b><span>starred</span></div>` : ''}
    </div>
    <div class="side-label" style="padding-left:0">Last 14 days</div>
    <div class="bar-chart">${days.map((d) => `
      <div class="bar-col" title="${d.day}: ${d.count} messages">
        <div class="bar" style="height:${Math.round((d.count / maxDaily) * 72)}px"></div>
        <div class="bar-label">${d.day.slice(8)}</div>
      </div>`).join('')}
    </div>
    ${s.tool_uses.length ? `<div class="side-label" style="padding-left:0;margin-top:14px">Tool calls</div>
      ${s.tool_uses.map((t) => `<div class="stat-row"><span>🔧 ${esc(t.tool)}</span><span class="muted">${t.count}×</span></div>`).join('')}`
      : '<p class="muted small" style="margin-top:12px">No tool calls yet.</p>'}
  `);
};

// ---------- attachments (text files ride in the prompt; images become vision input) ----------
async function loadAttachments() {
  const box = $('attach-chips');
  box.innerHTML = '';
  if (!activeConv) return;
  try {
    const files = await api('GET', `/api/conversations/attachments?conv_id=${activeConv}`);
    for (const f of files) {
      const isImg = (f.mime || '').startsWith('image/');
      const chip = document.createElement('span');
      chip.className = 'attach-chip';
      chip.innerHTML = `${isImg ? '🖼' : '📄'} <b></b> <i class="muted"></i><button title="Remove">✕</button>`;
      chip.querySelector('b').textContent = f.name;
      chip.querySelector('i').textContent = isImg ? ' vision' : ` ${f.bytes}B`;
      chip.title = isImg ? 'Image attached — vision-capable models will see it' : f.name;
      chip.querySelector('button').onclick = async () => {
        await api('DELETE', `/api/conversations/attachments?id=${f.id}`);
        loadAttachments();
      };
      box.appendChild(chip);
    }
  } catch { /* non-fatal */ }
}
$('attach-btn').onclick = () => $('attach-input').click();

// one path for file-picker, drag-and-drop and clipboard-paste uploads
async function uploadFiles(files) {
  for (const file of files) {
    try {
      if ((file.type || '').startsWith('image/')) {
        if (file.size > 2_500_000) { toast(`${file.name} is over the 2.5 MB image limit`, 'bad'); continue; }
        const dataUrl = await new Promise((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(r.result);
          r.onerror = rej;
          r.readAsDataURL(file);
        });
        const r = await api('POST', '/api/conversations/attachments', {
          conversation_id: activeConv, name: file.name || 'pasted-image.png', content: dataUrl, mime: file.type,
        });
        if (!activeConv && r.conversation_id) {
          activeConv = r.conversation_id;
          localStorage.setItem('oc_conv', String(activeConv));
          updateExportVisibility();
        }
        toast(`Attached ${file.name || 'image'} (vision)`);
      } else {
        if (file.size > 200000) { toast(`${file.name} is over the 200 KB text limit`, 'bad'); continue; }
        const content = await file.text();
        const r = await api('POST', '/api/conversations/attachments', {
          conversation_id: activeConv, name: file.name, content,
        });
        if (!activeConv && r.conversation_id) {
          activeConv = r.conversation_id;
          localStorage.setItem('oc_conv', String(activeConv));
          updateExportVisibility();
        }
        toast(`Attached ${file.name}`);
      }
    } catch (err) { toast(err.message, 'bad'); }
  }
  loadAttachments();
}
$('attach-input').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  await uploadFiles(files);
});
// paste screenshots straight into the composer
inputEl.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) {
    e.preventDefault();
    uploadFiles(files);
  }
});
// drop files anywhere on the chat pane
const chatPane = document.querySelector('.chat');
chatPane.addEventListener('dragover', (e) => { e.preventDefault(); chatPane.classList.add('dragging'); });
chatPane.addEventListener('dragleave', () => chatPane.classList.remove('dragging'));
chatPane.addEventListener('drop', (e) => {
  e.preventDefault();
  chatPane.classList.remove('dragging');
  const files = [...(e.dataTransfer?.files || [])];
  if (files.length) uploadFiles(files);
});

// ---------- knowledge base: my documents ----------
$('show-documents').onclick = async () => {
  let data;
  try { data = await api('GET', '/api/documents'); }
  catch (e) { openModal(`<h2>🗂 Documents</h2><p class="muted">${esc(e.message)}</p>`); return; }
  openModal(`
    <h2>🗂 My documents</h2>
    <p class="muted small">Your personal knowledge base. The AI searches these automatically (via the <b>knowledge_search</b> tool) whenever a question touches their content. Plain text, Markdown, code, notes…</p>
    <div class="admin-section">
      ${data.documents.length ? data.documents.map((d) => `
        <div class="card">
          <div class="row"><b>${esc(d.name)}</b>
            <span><span class="muted small">${d.bytes} B</span>
            <button data-docview="${d.id}" title="preview the text">👁</button>
            <button data-docdl="${d.id}" title="download the original text">⬇</button>
            <button class="danger" data-docdel="${d.id}">delete</button></span></div>
          <div class="kv">added ${esc(d.created_at)}</div>
          <pre class="doc-preview hidden" data-docprev="${d.id}" style="margin:6px 0 0"></pre>
        </div>`).join('')
      : '<div class="card"><p class="muted small">No documents yet — add your first one below.</p></div>'}
    </div>
    ${data.documents.length ? `
    <div class="card">
      <div class="row"><b>Try a search</b><span class="muted small">exactly what the AI sees</span></div>
      <div class="grid2"><input id="doc-q" placeholder="search terms…"><button id="doc-go" class="primary">search</button></div>
      <div id="doc-results" class="small" style="margin-top:8px"></div>
    </div>` : ''}
    <div class="card">
      <div class="row"><b>Add document</b><span class="muted small">${data.documents.length}/${data.max}</span></div>
      <div class="grid2">
        <input id="doc-name" placeholder="name, e.g. team-handbook">
        <button id="doc-file-btn">open file…</button>
      </div>
      <input type="file" id="doc-file" class="hidden" accept=".txt,.md,.markdown,.json,.csv,.log,.xml,.html,.css,.js,.py,.sql,.yml,.yaml">
      <textarea id="doc-content" rows="6" placeholder="…or paste text here"></textarea>
      <p id="doc-msg" class="msg"></p>
      <div class="grid2"><button id="doc-add" class="primary">Add document</button></div>
    </div>
  `);
  modal.querySelectorAll('[data-docdel]').forEach((b) => b.onclick = async () => {
    await api('DELETE', `/api/documents?id=${b.dataset.docdel}`);
    $('show-documents').click();
  });
  modal.querySelectorAll('[data-docview]').forEach((b) => b.onclick = async () => {
    const pre = modal.querySelector(`[data-docprev="${b.dataset.docview}"]`);
    if (!pre.classList.contains('hidden')) { pre.classList.add('hidden'); return; }
    if (!pre.textContent) {
      try {
        const doc = await api('GET', `/api/documents?id=${b.dataset.docview}`);
        pre.textContent = doc.content.slice(0, 2000) + (doc.content.length > 2000 ? '\n…' : '');
      } catch (e) { pre.textContent = '✗ ' + e.message; }
    }
    pre.classList.remove('hidden');
  });
  modal.querySelectorAll('[data-docdl]').forEach((b) => b.onclick = async () => {
    try {
      const doc = await api('GET', `/api/documents?id=${b.dataset.docdl}`);
      const blob = new Blob([doc.content], { type: 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = doc.name.replace(/[^\w .-]/g, '_') + '.txt';
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) { toast(e.message, 'bad'); }
  });
  const go = async () => {
    const q = $('doc-q').value.trim();
    if (!q) return;
    const hits = await api('GET', `/api/documents/search?q=${encodeURIComponent(q)}`);
    $('doc-results').innerHTML = hits.length
      ? hits.map((h) => `<div class="card"><b>${esc(h.doc)}</b><div class="muted small" style="margin-top:4px">${esc(h.text.slice(0, 260))}…</div></div>`).join('')
      : '<p class="muted">No matching passages.</p>';
  };
  if ($('doc-go')) $('doc-go').onclick = go;
  if ($('doc-q')) $('doc-q').addEventListener('keydown', (e) => e.key === 'Enter' && go());
  $('doc-file-btn').onclick = () => $('doc-file').click();
  $('doc-file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    $('doc-name').value = f.name.replace(/\.[^.]+$/, '');
    $('doc-content').value = (await f.text()).slice(0, 400000);
  });
  $('doc-add').onclick = async () => {
    try {
      const r = await api('POST', '/api/documents', { name: $('doc-name').value, content: $('doc-content').value });
      toast(`Document added (${r.chunks} searchable chunks)`);
      $('show-documents').click();
    } catch (e) { $('doc-msg').textContent = e.message; }
  };
};

// ---------- personal providers (BYOK) ----------
$('show-myproviders').onclick = async () => {
  const data = await api('GET', '/api/my/providers');
  openModal(`
    <h2>🧩 My providers</h2>
    <p class="muted small">Bring your own API — OpenAI-compatible endpoints or Anthropic. Personal providers appear in the model picker marked 🧩 and only you can use them or see them.</p>
    ${data.allowed ? '' : '<div class="card"><p class="muted">⚠️ Admins have disabled personal providers.</p></div>'}
    <div class="admin-section">
      ${data.providers.length ? data.providers.map((p) => `
        <div class="card">
          <div class="row"><b>${esc(p.name)}</b> <span class="muted small">· ${esc(p.model)}</span>
            <span><span class="pill ${p.enabled ? 'on' : 'off'}">${p.enabled ? 'enabled' : 'disabled'}</span>
            <button data-mpen="${p.id}">${p.enabled ? 'disable' : 'enable'}</button>
            <button class="danger" data-mpdel="${p.id}">remove</button></span></div>
          <div class="kv">${esc(p.kind)} · ${esc(p.base_url)}</div>
        </div>`).join('')
      : '<div class="card"><p class="muted small">No personal providers yet.</p></div>'}
    </div>
    ${data.allowed ? `
    <div class="card">
      <div class="row"><b>Add provider</b>
        <select id="mp-kind"><option value="openai">openai-compatible</option><option value="anthropic">anthropic</option></select></div>
      <div class="grid2">
        <input id="mp-name" placeholder="name, e.g. my-openai">
        <input id="mp-model" placeholder="model, e.g. gpt-4o">
        <input id="mp-url" placeholder="base URL, e.g. https://api.openai.com/v1" style="grid-column: 1 / -1;">
        <input id="mp-key" placeholder="API key" type="password" style="grid-column: 1 / -1;">
      </div>
      <p id="mp-msg" class="msg"></p>
      <div class="row">
        <button id="mp-test">test connection</button>
        <span id="mp-test-result" class="small"></span>
        <button class="primary" id="mp-add" style="margin-left:auto">Add provider</button>
      </div>
      <div class="muted small" style="margin-top:6px">Personal providers: ${data.providers.length}/${data.max}</div>
    </div>` : ''}
  `);
  modal.querySelectorAll('[data-mpen]').forEach((b) => b.onclick = async () => {
    const p = data.providers.find((x) => x.id == b.dataset.mpen);
    await api('PUT', '/api/my/providers', { id: p.id, enabled: !p.enabled });
    refreshProviderSelect();
    $('show-myproviders').click();
  });
  modal.querySelectorAll('[data-mpdel]').forEach((b) => b.onclick = async () => {
    const p = data.providers.find((x) => x.id == b.dataset.mpdel);
    if (!confirm(`Remove "${p.name}"? Chats using it fall back to the shared providers.`)) return;
    await api('DELETE', `/api/my/providers?id=${p.id}`);
    refreshProviderSelect();
    toast('Provider removed');
    $('show-myproviders').click();
  });
  if (data.allowed) {
    $('mp-test').onclick = async () => {
      const line = $('mp-test-result');
      line.textContent = 'testing…'; line.className = 'small';
      try {
        const r = await api('POST', '/api/my/providers/test', {
          kind: $('mp-kind').value, name: $('mp-name').value.trim() || 'test',
          base_url: $('mp-url').value.trim(), model: $('mp-model').value.trim(), api_key: $('mp-key').value,
        });
        line.textContent = r.ok ? `✓ responded in ${r.ms}ms` : `✗ ${r.error}`;
        line.className = `small ${r.ok ? 'ok' : 'bad'}`;
      } catch (e) { line.textContent = `✗ ${e.message}`; line.className = 'small bad'; }
    };
    $('mp-add').onclick = async () => {
      try {
        await api('POST', '/api/my/providers', {
          kind: $('mp-kind').value, name: $('mp-name').value.trim(),
          base_url: $('mp-url').value.trim(), model: $('mp-model').value.trim(), api_key: $('mp-key').value,
        });
        toast('Provider added');
        refreshProviderSelect();
        $('show-myproviders').click();
      } catch (e) { $('mp-msg').textContent = e.message; }
    };
  }
};

// ---------- reminders: scheduled prompts that run later ----------
$('show-tasks').onclick = async () => {
  const tasks = await api('GET', '/api/tasks');
  const fmt = (iso) => { const d = new Date(iso); return isNaN(d) ? iso : d.toLocaleString(); };
  openModal(`
    <h2>⏰ Reminders</h2>
    <p class="muted small">Schedule a prompt for later. When it's time, OrionChatV3 runs it with your default provider and drops the answer into a new chat.</p>
    <div class="admin-section">
      ${tasks.length ? tasks.map((t) => `
        <div class="card">
          <div class="row">
            <span class="pill ${t.status === 'pending' ? 'on' : t.status === 'done' ? 'ok' : 'off'}">${esc(t.status)}</span>
            <b style="flex:1;margin-left:8px">${esc(t.prompt.slice(0, 90))}${t.prompt.length > 90 ? '…' : ''}</b>
            ${t.status === 'pending' ? `<button data-taskcancel="${t.id}">cancel</button>` : ''}
            ${t.status === 'done' && t.result_conv_id ? `<button data-taskopen="${t.result_conv_id}">open result</button>` : ''}
          </div>
          <div class="kv">runs ${esc(fmt(t.run_at))}${t.status === 'failed' ? ` · ✗ ${esc(t.result_note || 'failed')}` : ''}</div>
        </div>`).join('')
      : '<div class="card"><p class="muted small">Nothing scheduled yet.</p></div>'}
    </div>
    <div class="card">
      <div class="row"><b>New reminder</b></div>
      <textarea id="task-prompt" rows="3" placeholder="Prompt to run, e.g. “Summarize my notes for tomorrow”"></textarea>
      <div class="grid2" style="margin-top:8px">
        <label class="field" style="margin:0"><span>Run at</span><input type="datetime-local" id="task-at"></label>
        <button id="task-add" class="primary" style="align-self:end">Schedule</button>
      </div>
      <label class="field" style="margin-top:8px"><span>Provider (optional — defaults to the shared pool)</span>
        <select id="task-provider"><option value="">default</option>${buildProviderOptions()}</select></label>
      <p id="task-msg" class="msg"></p>
    </div>
  `);
  modal.querySelectorAll('[data-taskcancel]').forEach((b) => b.onclick = async () => {
    await api('DELETE', `/api/tasks?id=${b.dataset.taskcancel}`);
    toast('Reminder cancelled');
    $('show-tasks').click();
  });
  modal.querySelectorAll('[data-taskopen]').forEach((b) => b.onclick = async () => {
    closeModal();
    await openConv(Number(b.dataset.taskopen));
  });
  $('task-add').onclick = async () => {
    const at = $('task-at').value;
    if (!at) { $('task-msg').textContent = 'Pick a date and time'; return; }
    try {
      await api('POST', '/api/tasks', {
        prompt: $('task-prompt').value,
        run_at: new Date(at).toISOString(),
        provider_id: $('task-provider').value && !$('task-provider').value.startsWith('u') ? Number($('task-provider').value) : null,
      });
      toast('Reminder scheduled');
      if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
      $('show-tasks').click();
    } catch (e) { $('task-msg').textContent = e.message; }
  };
};

// ---------- starred messages ----------
$('show-starred').onclick = async () => {
  const stars = await api('GET', '/api/me/starred');
  openModal(`
    <h2>⭐ Starred messages</h2>
    <p class="muted small">Messages you starred across all chats. Click one to jump back to it.</p>
    <div class="admin-section">
      ${stars.length ? stars.map((s) => `
        <div class="card" style="cursor:pointer" data-conv="${s.conv_id}" data-mid="${s.id}">
          <div class="row"><b>${s.role === 'user' ? 'You' : '✦ Assistant'} · ${esc(s.title || 'chat')}</b>
            <span class="muted small">${timeLabel(s.created_at)}</span></div>
          <div class="muted small" style="margin-top:4px">${esc(String(s.content).slice(0, 220))}${String(s.content).length > 220 ? '…' : ''}</div>
        </div>`).join('')
      : '<div class="card"><p class="muted small">Nothing starred yet — hit the ☆ on any message.</p></div>'}
    </div>
    ${stars.length ? '<button id="star-export">⬇ Export starred as Markdown</button>' : ''}
  `);
  if ($('star-export')) $('star-export').onclick = async () => {
    const mdText = `# Starred messages\n\n` + stars.map((s) =>
      `## ${s.role === 'user' ? 'You' : 'Assistant'} — ${s.title || 'chat'} (${s.created_at})\n\n${s.content}\n`).join('\n');
    const blob = new Blob([mdText], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'starred-messages.md';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('Starred messages exported');
  };
  modal.querySelectorAll('[data-conv]').forEach((card) => card.onclick = async () => {
    closeModal();
    await openConvByIdThenScroll(Number(card.dataset.conv), Number(card.dataset.mid));
  });
};
async function openConvByIdThenScroll(convId, msgId) {
  const msgs = await api('GET', `/api/conversation/${convId}/messages`);
  activeConv = convId;
  localStorage.setItem('oc_conv', String(convId));
  renderMessages(msgs);
  loadAttachments();
  loadConvs();
  setDrawer(false);
  requestAnimationFrame(() => {
    const el = document.querySelector(`.msg-row[data-mid="${msgId}"]`);
    if (el) {
      el.scrollIntoView({ block: 'center' });
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 1600);
    }
  });
}

// ---------- account: profile, sessions, 2FA, import/export, API playground ----------
$('show-account').onclick = async () => {
  me = await api('GET', '/api/me'); // fresh 2FA + profile state
  const sessions = await api('GET', '/api/me/sessions');
  openModal(`
    <h2>👤 Account &amp; data</h2>
    <p class="muted small">Signed in as <b>${esc(me.username)}</b> (${esc(me.role)}).</p>

    <h3>Profile</h3>
    <div class="grid2">
      <label class="field" style="margin:0"><span>Display name</span>
        <input id="prof-name" placeholder="shown instead of your username" value="${esc(me.display_name || '')}"></label>
      <label class="field" style="margin:0"><span>Avatar color</span>
        <input id="prof-color" type="color" value="${esc(me.avatar_color || '#7c5cff')}" style="height:38px;padding:4px"></label>
    </div>
    <div class="grid2" style="margin-top:8px"><button id="prof-save" class="primary">Save profile</button></div>

    <h3>Comfort</h3>
    <div class="grid2">
      <div class="row" style="margin:0"><span>🔊 Sound on reply</span>
        <button id="opt-sound">${localStorage.getItem('oc_sound') === '1' ? 'On — turn off' : 'Off — turn on'}</button></div>
      <button id="opt-autoread">🗣 Auto-read replies: ${localStorage.getItem('oc_autoread') === '1' ? 'On — turn off' : 'Off'}</button>
      <button id="opt-notify">🔔 Enable desktop notifications</button>
      <button id="opt-autotitle">✏️ Auto-rename chats: ${me.auto_title ? 'On — turn off' : 'Off — turn on'}</button>
    </div>

    <h3>Two-factor authentication</h3>
    <div class="card">
      ${me.totp_enabled
        ? `<div class="row"><b>✅ 2FA is on</b><span class="muted small">A code from your authenticator app is required at login.</span></div>
           <div class="grid2" style="margin-top:8px">
             <input id="tfa-off-code" placeholder="current 6-digit code" inputmode="numeric" maxlength="6">
             <button id="tfa-disable" class="danger">Disable 2FA</button>
           </div>`
        : `<div class="muted small">Add a second factor with any TOTP app (Aegis, Google Authenticator, 1Password…).</div>
           <div class="grid2" style="margin-top:8px"><button id="tfa-setup">Set up 2FA</button></div>
           <div id="tfa-setup-area" class="hidden" style="margin-top:10px">
             <p class="small">1. Add this secret to your authenticator app (manual entry):</p>
             <div class="share-box"><code id="tfa-secret"></code></div>
             <p class="small muted" style="margin-top:6px" id="tfa-uri"></p>
             <p class="small">2. Enter the 6-digit code it shows:</p>
             <div class="grid2">
               <input id="tfa-code" placeholder="123456" inputmode="numeric" maxlength="6">
               <button id="tfa-enable" class="primary">Enable 2FA</button>
             </div>
           </div>`}
      <p id="tfa-msg" class="msg"></p>
    </div>

    <h3>Active sessions</h3>
    <div class="admin-section">
      ${sessions.map((s) => `
        <div class="card"><div class="row"><span>${s.current ? '<b>this session</b>' : `<code>${esc(s.id)}…</code>`}</span>
          <span><span class="muted small">since ${esc(s.created_at)}</span>
          ${s.current ? '' : `<button data-sessdel="${esc(s.id)}">revoke</button>`}</span></div></div>`).join('')}
    </div>
    ${sessions.length > 1 ? '<button id="acc-revoke-all">Revoke all other sessions</button>' : ''}

    <h3>Your data</h3>
    <div class="grid2">
      <button id="acc-export">⬇ Export my data (JSON)</button>
      <button id="acc-import-btn">📥 Import a chat (JSON)</button>
    </div>
    <input type="file" id="acc-import-file" class="hidden" accept=".json">
    <div class="grid2" style="margin-top:8px">
      <button id="acc-import-md-btn">📝 Import a Markdown transcript</button>
    </div>
    <input type="file" id="acc-import-md" class="hidden" accept=".md,.markdown,.txt">
    <p class="muted small" style="margin:4px 0 0">Markdown lines starting with <code>**You:**</code> / <code>**Assistant:**</code> (or <code>You:</code> / <code>Assistant:</code>) become chat turns.</p>
    <p id="acc-msg" class="msg"></p>

    <h3>Danger zone</h3>
    <div class="card">
      <div class="muted small">Permanently deletes your account with <b>all</b> chats, memories, documents, prompts and personal providers. This cannot be undone.</div>
      <div class="grid2" style="margin-top:8px">
        <input id="del-pass" type="password" placeholder="confirm with your password">
        <button id="del-account" class="danger">Delete my account</button>
      </div>
      <p id="del-msg" class="msg"></p>
    </div>

    <h3>API access</h3>
    <div class="card">
      <div class="row"><b>Your API key</b><code class="apikey">${esc(me.api_key)}</code>
        <button id="acc-copykey" title="copy API key">⧉</button></div>
      <p class="muted small" style="margin:6px 0">Call OrionChatV3 from any OpenAI SDK or script:</p>
      <div class="share-box"><code id="acc-curl"></code></div>
      <div class="grid2" style="margin-top:8px">
        <button id="acc-try">Try GET /v1/models</button>
        <button id="acc-copycurl">Copy curl command</button>
      </div>
      <pre id="acc-out" class="small" style="margin-top:8px;white-space:pre-wrap"></pre>
    </div>

    <h3>Change password</h3>
    <label class="field"><span>Current password</span><input id="acc-pw-cur" type="password" autocomplete="current-password"></label>
    <label class="field"><span>New password</span><input id="acc-pw-new" type="password" autocomplete="new-password"></label>
    <p id="acc-pw-msg" class="msg"></p>
    <button id="acc-pw-save" class="primary wide">Save new password</button>
  `);
  $('acc-curl').textContent = `curl ${location.origin}/v1/chat/completions \\\n  -H "Authorization: Bearer ${me.api_key.slice(0, 12)}…" \\\n  -d '{"model":"orion-1","messages":[{"role":"user","content":"hi"}]}'`;
  // profile
  $('prof-save').onclick = async () => {
    try {
      await api('PUT', '/api/settings', { display_name: $('prof-name').value, avatar_color: $('prof-color').value });
      me.display_name = $('prof-name').value.trim();
      me.avatar_color = $('prof-color').value;
      $('whoami-name').textContent = me.display_name || me.username;
      $('whoami-avatar').textContent = (me.display_name || me.username)[0].toUpperCase();
      if (me.avatar_color) $('whoami-avatar').style.background = me.avatar_color;
      toast('Profile saved');
    } catch (e) { toast(e.message, 'bad'); }
  };
  // comfort toggles
  $('opt-sound').onclick = () => {
    const on = localStorage.getItem('oc_sound') !== '1';
    localStorage.setItem('oc_sound', on ? '1' : '0');
    $('opt-sound').textContent = on ? 'On — turn off' : 'Off — turn on';
    if (on) playChime();
  };
  $('opt-autoread').onclick = () => {
    const on = localStorage.getItem('oc_autoread') !== '1';
    localStorage.setItem('oc_autoread', on ? '1' : '0');
    $('opt-autoread').textContent = `🗣 Auto-read replies: ${on ? 'On — turn off' : 'Off'}`;
  };
  $('opt-autotitle').onclick = async () => {
    const on = !me.auto_title;
    await api('PUT', '/api/settings', { auto_title: on });
    me.auto_title = on;
    $('opt-autotitle').textContent = `✏️ Auto-rename chats: ${on ? 'On — turn off' : 'Off — turn on'}`;
    toast(on ? 'Chats auto-rename after the first reply' : 'Chats keep their first title');
  };
  $('opt-notify').onclick = async () => {
    if (!('Notification' in window)) { toast('Notifications are not supported here', 'bad'); return; }
    const r = await Notification.requestPermission();
    toast(r === 'granted' ? 'Notifications enabled' : 'Permission not granted', r === 'granted' ? 'ok' : 'bad');
  };
  // 2FA
  if (me.totp_enabled) {
    $('tfa-disable').onclick = async () => {
      try {
        await api('POST', '/api/2fa/disable', { token: $('tfa-off-code').value.trim() });
        toast('2FA disabled');
        $('show-account').click();
      } catch (e) { $('tfa-msg').textContent = e.message; }
    };
  } else {
    $('tfa-setup').onclick = async () => {
      try {
        const r = await api('POST', '/api/2fa/setup');
        $('tfa-setup-area').classList.remove('hidden');
        $('tfa-secret').textContent = r.secret;
        $('tfa-uri').textContent = r.otpauth;
        $('tfa-setup').disabled = true;
      } catch (e) { $('tfa-msg').textContent = e.message; }
    };
    $('tfa-enable').onclick = async () => {
      try {
        await api('POST', '/api/2fa/enable', { token: $('tfa-code').value.trim() });
        toast('2FA enabled — you will need your authenticator at next login');
        $('show-account').click();
      } catch (e) { $('tfa-msg').textContent = e.message; }
    };
  }
  $('acc-copykey').onclick = async () => {
    try { await navigator.clipboard.writeText(me.api_key); toast('API key copied'); }
    catch { toast('Copy failed', 'bad'); }
  };
  modal.querySelectorAll('[data-sessdel]').forEach((b) => b.onclick = async () => {
    await api('DELETE', `/api/me/sessions?id=${encodeURIComponent(b.dataset.sessdel)}`);
    toast('Session revoked');
    $('show-account').click();
  });
  if ($('acc-revoke-all')) $('acc-revoke-all').onclick = async () => {
    if (!confirm('Revoke every other session? Other logged-in devices will be signed out.')) return;
    await api('DELETE', '/api/me/sessions?all=1');
    toast('Other sessions revoked');
    $('show-account').click();
  };
  $('acc-export').onclick = async () => {
    try {
      const data = await api('GET', '/api/me/export');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `orionchatv3-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast('Export downloaded');
    } catch (e) { $('acc-msg').textContent = e.message; }
  };
  $('acc-import-btn').onclick = () => $('acc-import-file').click();
  $('acc-import-file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const parsed = JSON.parse(await f.text());
      const msgs = Array.isArray(parsed) ? parsed : (parsed.messages || []);
      if (!Array.isArray(msgs) || !msgs.length) throw new Error('No messages found in that file');
      const r = await api('POST', '/api/conversations/import', { title: parsed.title || 'Imported chat', messages: msgs });
      toast(`Imported ${r.imported} messages`);
      closeModal();
      await loadConvs();
      await openConv(r.conversation_id);
    } catch (err) { $('acc-msg').textContent = `Import failed: ${err.message}`; }
  });
  // Markdown transcript import: split on "You:" / "Assistant:" style speaker lines
  $('acc-import-md-btn').onclick = () => $('acc-import-md').click();
  $('acc-import-md').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const text = await f.text();
      const lines = text.split('\n');
      const msgs = [];
      let speaker = null;
      for (const line of lines) {
        const m = line.match(/^\s*(?:\*\*)?\s*(You|User|Human|Assistant|AI|Bot)\s*(?:\*\*)?\s*[:：]\s*(.*)$/i);
        if (m) {
          speaker = /^(you|user|human)$/i.test(m[1]) ? 'user' : 'assistant';
          if (m[2]) msgs.push({ role: speaker, content: m[2] });
        } else if (speaker && line.trim()) {
          msgs[msgs.length - 1].content += '\n' + line;
        }
      }
      if (!msgs.length) throw new Error('No "You:" / "Assistant:" turns found in that file');
      const r = await api('POST', '/api/conversations/import', {
        title: f.name.replace(/\.(md|markdown|txt)$/i, '') || 'Imported markdown',
        messages: msgs,
      });
      toast(`Imported ${r.imported} turns from Markdown`);
      closeModal();
      await loadConvs();
      await openConv(r.conversation_id);
    } catch (err) { $('acc-msg').textContent = `Import failed: ${err.message}`; }
  });
  // self-service deletion
  $('del-account').onclick = async () => {
    if (!confirm('Really delete your account and ALL of your data? This cannot be undone.')) return;
    try {
      await api('POST', '/api/account/delete', { password: $('del-pass').value });
      toast('Account deleted. Goodbye 👋');
      setTimeout(() => location.reload(), 800);
    } catch (e) { $('del-msg').textContent = e.message; }
  };
  $('acc-copycurl').onclick = async () => {
    const cmd = `curl ${location.origin}/v1/chat/completions -H "Authorization: Bearer ${me.api_key}" -H "Content-Type: application/json" -d '{"model":"orion-1","messages":[{"role":"user","content":"hi"}]}'`;
    try { await navigator.clipboard.writeText(cmd); toast('curl command copied'); }
    catch { toast('Copy failed', 'bad'); }
  };
  $('acc-try').onclick = async () => {
    $('acc-out').textContent = 'calling…';
    try {
      const res = await fetch('/v1/models', { headers: { Authorization: `Bearer ${me.api_key}` } });
      const body = await res.json();
      $('acc-out').textContent = `HTTP ${res.status}\n` + JSON.stringify(body, null, 2).slice(0, 1200);
    } catch (e) { $('acc-out').textContent = '✗ ' + e.message; }
  };
  $('acc-pw-save').onclick = async () => {
    if (!$('acc-pw-new').value) { $('acc-pw-msg').textContent = 'Enter a new password'; return; }
    try {
      await api('POST', '/api/password', { current: $('acc-pw-cur').value, password: $('acc-pw-new').value });
      modal.classList.add('hidden');
      toast('Password updated');
    } catch (e) { $('acc-pw-msg').textContent = e.message; }
  };
};

// ---------- projects: organize chats into groups with a shared persona ----------
let activeProject = Number(localStorage.getItem('oc_project')) || null;
let projectsCache = [];
async function loadProjects() {
  try { projectsCache = await api('GET', '/api/projects'); }
  catch { projectsCache = []; }
  renderProjectsStrip();
}
function renderProjectsStrip() {
  const strip = $('projects-strip');
  const proj = projectsCache.find((p) => p.id === activeProject);
  inputEl.placeholder = proj
    ? `Message 🗂 ${proj.name}…  (Enter to send, Shift+Enter for newline)`
    : 'Message…  / for prompts  (Enter to send, Shift+Enter for newline)';
  if (!projectsCache.length) { strip.innerHTML = ''; return; }
  strip.innerHTML = `<button class="proj-chip ${!activeProject ? 'active' : ''}" data-p="">All</button>` +
    projectsCache.map((p) =>
      `<button class="proj-chip ${activeProject === p.id ? 'active' : ''}" data-p="${p.id}" title="${esc(p.system_prompt ? 'has persona' : '')}">🗂 ${esc(p.name)} <span class="muted">${p.chats}</span></button>`
    ).join('') + `<button class="proj-chip new" data-manage="1" title="Manage projects">＋</button>`;
  strip.querySelectorAll('[data-p]').forEach((b) => b.onclick = () => {
    activeProject = b.dataset.p ? Number(b.dataset.p) : null;
    if (activeProject) localStorage.setItem('oc_project', String(activeProject));
    else localStorage.removeItem('oc_project');
    renderProjectsStrip();
    loadConvs();
  });
  strip.querySelector('[data-manage]').onclick = () => {
    openModal(`
      <h2>🗂 Projects</h2>
      <p class="muted small">Group related chats. A project can carry its own persona — chats in it use that system prompt unless they define their own.</p>
      <div class="admin-section">
        ${projectsCache.map((p) => `
          <div class="card">
            <div class="row"><b>${esc(p.name)}</b> <span class="muted small">· ${p.chats} chats</span>
              <span><button data-pedit="${p.id}">edit</button><button class="danger" data-pdel="${p.id}">delete</button></span></div>
            ${p.system_prompt ? `<div class="muted small">${esc(p.system_prompt.slice(0, 140))}${p.system_prompt.length > 140 ? '…' : ''}</div>` : ''}
          </div>`).join('') || '<div class="card"><p class="muted small">No projects yet.</p></div>'}
      </div>
      <div class="card">
        <div class="row"><b>New project</b></div>
        <div class="grid2"><input id="proj-name" placeholder="name, e.g. Work"><button id="proj-add" class="primary">Create</button></div>
        <textarea id="proj-persona" rows="3" placeholder="Optional persona for chats in this project" style="margin-top:8px"></textarea>
        <p id="proj-msg" class="msg"></p>
      </div>
    `);
    modal.querySelectorAll('[data-pdel]').forEach((b) => b.onclick = async () => {
      const p = projectsCache.find((x) => x.id == b.dataset.pdel);
      if (!confirm(`Delete project "${p.name}"? Its chats are kept, just ungrouped.`)) return;
      await api('DELETE', `/api/projects?id=${p.id}`);
      if (activeProject === p.id) { activeProject = null; localStorage.removeItem('oc_project'); }
      await loadProjects();
      loadConvs();
      $('show-starred') && document.querySelector('[data-manage]')?.click();
    });
    modal.querySelectorAll('[data-pedit]').forEach((b) => b.onclick = async () => {
      const p = projectsCache.find((x) => x.id == b.dataset.pedit);
      const name = prompt('Project name:', p.name);
      if (name === null) return;
      const persona = prompt('Persona / system prompt for this project (empty to clear):', p.system_prompt || '');
      if (persona === null) return;
      await api('PUT', '/api/projects', { id: p.id, name: name.trim() || p.name, system_prompt: persona });
      await loadProjects();
      loadConvs();
      toast('Project saved');
    });
    $('proj-add').onclick = async () => {
      try {
        await api('POST', '/api/projects', { name: $('proj-name').value, system_prompt: $('proj-persona').value });
        await loadProjects();
        loadConvs();
        toast('Project created');
        document.querySelector('[data-manage]')?.click();
      } catch (e) { $('proj-msg').textContent = e.message; }
    };
  };
}

// ---------- prompt library (/commands) ----------
let promptsCache = null;
async function getPrompts(force = false) {
  if (force || !promptsCache) promptsCache = await api('GET', '/api/prompts');
  return promptsCache;
}
$('show-prompts').onclick = async () => renderPromptsModal();

async function renderPromptsModal(msg = null) {
  const prompts = await getPrompts(true);
  openModal(`
    <h2>📚 Prompt library</h2>
    <p class="muted small">Reusable prompts. Type <b>/name</b> in the composer to insert one.</p>
    <div class="prompt-list" id="prompt-list"></div>
    <h3>New prompt</h3>
    <div class="grid2">
      <input id="pr-name" placeholder="name, e.g. review">
      <button id="pr-add" class="primary">Add prompt</button>
    </div>
    <textarea id="pr-content" rows="4" placeholder="Prompt text — ${esc('$INPUT')} marks where your typed message goes (optional)"></textarea>
    <p id="pr-msg" class="msg"></p>
  `);
  const list = $('prompt-list');
  if (!prompts.length) list.innerHTML = '<p class="muted small">No prompts yet — add your first one below.</p>';
  for (const p of prompts) {
    const div = document.createElement('div');
    div.className = 'prompt-row';
    div.innerHTML = `<div class="prompt-info"><b>/${esc(p.name)}</b><span class="muted small">${esc(p.content.slice(0, 110))}${p.content.length > 110 ? '…' : ''}</span></div>
      <span class="prompt-actions">
        <button data-use title="Insert into composer">➤ Use</button>
        <button data-del title="Delete">🗑</button>
      </span>`;
    div.querySelector('[data-use]').onclick = () => {
      closeModal();
      inputEl.value = p.content;
      inputEl.focus();
      inputEl.dispatchEvent(new Event('input'));
    };
    div.querySelector('[data-del]').onclick = async () => {
      await api('DELETE', `/api/prompts?id=${p.id}`);
      promptsCache = null;
      renderPromptsModal();
    };
    list.appendChild(div);
  }
  $('pr-add').onclick = async () => {
    try {
      await api('POST', '/api/prompts', { name: $('pr-name').value, content: $('pr-content').value });
      promptsCache = null;
      renderPromptsModal();
      toast('Prompt saved');
    } catch (e) { $('pr-msg').textContent = e.message; }
  };
}

// ---------- slash autocomplete in the composer ----------
const slashPop = $('slash-pop');
let slashItems = [];
let slashIdx = 0;
inputEl.addEventListener('input', () => {
  const m = inputEl.value.match(/^\/([a-z0-9_]*)$/i);
  if (!m) return hideSlashPop();
  updateSlashPop(m[1].toLowerCase());
});
async function updateSlashPop(q) {
  const prompts = await getPrompts();
  // built-in commands first, then the user's own library
  const builtins = [
    { name: 'summarize', content: 'Summarize this conversation so far in 5 concise bullet points.', builtin: true },
    { name: 'continue', content: 'Continue from where you left off.', builtin: true },
  ].filter((p) => p.name.startsWith(q));
  slashItems = [...builtins, ...prompts.filter((p) => p.name.toLowerCase().startsWith(q))];
  if (!slashItems.length) return hideSlashPop();
  slashIdx = 0;
  slashPop.innerHTML = '';
  slashItems.forEach((p, i) => {
    const div = document.createElement('div');
    div.className = 'slash-item' + (i === 0 ? ' sel' : '');
    div.innerHTML = `<b>/${esc(p.name)}</b>${p.builtin ? '<span class="pill kind">built-in</span>' : ''}<span class="muted small">${esc(p.content.slice(0, 70))}</span>`;
    div.onmousedown = (e) => { e.preventDefault(); applySlash(p); };
    slashPop.appendChild(div);
  });
  slashPop.classList.remove('hidden');
}
function applySlash(p) {
  inputEl.value = p.content;
  hideSlashPop();
  inputEl.focus();
  inputEl.dispatchEvent(new Event('input'));
}
function hideSlashPop() { slashPop.classList.add('hidden'); }
inputEl.addEventListener('keydown', (e) => {
  if (slashPop.classList.contains('hidden')) return;
  const items = slashPop.querySelectorAll('.slash-item');
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    slashIdx = (slashIdx + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
    items.forEach((el, i) => el.classList.toggle('sel', i === slashIdx));
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    applySlash(slashItems[slashIdx]);
  } else if (e.key === 'Escape') {
    hideSlashPop();
  }
});
document.addEventListener('click', (e) => {
  if (!slashPop.contains(e.target) && e.target !== inputEl) hideSlashPop();
});

// ---------- themes ----------
const THEMES = [
  { id: 'orion',    name: 'Orion',    dark: true,  meta: '#0a0714', sw: ['#a78bfa', '#e879f9'] },
  { id: 'prime',    name: 'Prime',    dark: true,  meta: '#0d0f1c', sw: ['#e5394b', '#2f6df6'], note: 'Peter Cullen · 1941–2026' },
  { id: 'nebula',   name: 'Nebula',   dark: true,  meta: '#050b1a', sw: ['#38bdf8', '#6366f1'] },
  { id: 'aurora',   name: 'Aurora',   dark: true,  meta: '#04120d', sw: ['#34d399', '#2dd4bf'] },
  { id: 'ember',    name: 'Ember',    dark: true,  meta: '#170a07', sw: ['#fb923c', '#f43f5e'] },
  { id: 'ocean',    name: 'Ocean',    dark: true,  meta: '#03101c', sw: ['#22d3ee', '#3b82f6'] },
  { id: 'midnight', name: 'Midnight', dark: true,  meta: '#01030a', sw: ['#64748b', '#94a3b8'] },
  { id: 'bloom',    name: 'Bloom',    dark: true,  meta: '#160812', sw: ['#f472b6', '#c084fc'] },
  { id: 'graphite', name: 'Graphite', dark: true,  meta: '#0d0f13', sw: ['#cbd5e1', '#64748b'] },
  { id: 'daybreak', name: 'Daybreak', dark: false, meta: '#f3f0fb', sw: ['#8b5cf6', '#d946ef'] },
  { id: 'meadow',   name: 'Meadow',   dark: false, meta: '#f0f7ee', sw: ['#16a34a', '#84cc16'] },
  { id: 'solar',    name: 'Solar',    dark: false, meta: '#faf4e8', sw: ['#f59e0b', '#ef4444'] },
];
// the Prime theme greets you with the voice of Optimus Prime, in memory of
// Peter Cullen (1941–2026)
const PRIME_QUOTES = [
  'The future is built on dreams.',
  'Autobots, roll out!',
  'Be strong enough to be gentle.',
  'Freedom is the right of all sentient beings.',
  'Until all are one.',
];
const EMPTY_DEFAULTS = { heading: 'How can I help you today?', sub: null };
// pre-picker saves used 'dark' / 'light'
const LEGACY_THEMES = { dark: 'orion', light: 'daybreak' };
const themeMeta = document.querySelector('meta[name="theme-color"]');
const themePop = $('theme-pop');
let chosenTheme = false; // false = follow the system preference

function currentTheme() {
  const saved = localStorage.getItem('oc_theme');
  return (saved && (LEGACY_THEMES[saved] || saved))
    || (matchMedia('(prefers-color-scheme: light)').matches ? 'daybreak' : 'orion');
}

function applyTheme(t) {
  const theme = THEMES.find((x) => x.id === t) || THEMES[0];
  document.body.dataset.theme = theme.id;
  if (themeMeta) themeMeta.content = theme.meta;
  for (const item of themePop.children) {
    item.setAttribute('aria-current', String(item.dataset.theme === theme.id));
  }
  dressEmptyState(theme);
}

// the Prime theme carries Optimus' words on the welcome screen
function dressEmptyState(theme) {
  const empty = $('empty-state');
  if (!empty) return;
  const h2 = empty.querySelector('h2');
  const p = empty.querySelector('p');
  if (!EMPTY_DEFAULTS.sub) EMPTY_DEFAULTS.sub = p?.textContent;
  if (theme.id === 'prime') {
    h2.textContent = PRIME_QUOTES[Math.floor(Math.random() * PRIME_QUOTES.length)];
    if (p) p.textContent = '— Optimus Prime · honoring Peter Cullen, 1941–2026';
  } else {
    h2.textContent = EMPTY_DEFAULTS.heading;
    if (p) p.textContent = EMPTY_DEFAULTS.sub;
  }
}

function setTheme(t) {
  chosenTheme = true;
  localStorage.setItem('oc_theme', t);
  applyTheme(t);
  if (t === 'prime') toast('In memory of Peter Cullen (1941–2026), the voice of Optimus Prime');
}

function buildThemePop() {
  for (const t of THEMES) {
    const b = document.createElement('button');
    b.className = 'theme-item';
    b.dataset.theme = t.id;
    b.setAttribute('role', 'menuitem');
    b.style.setProperty('--sw1', t.sw[0]);
    b.style.setProperty('--sw2', t.sw[1]);
    b.innerHTML = `<span class="sw"></span><span class="tl">${t.name}${t.note ? `<span class="note">${esc(t.note)}</span>` : ''}</span><span class="check">✓</span>`;
    b.onclick = () => { setTheme(t.id); hideThemePop(); };
    themePop.appendChild(b);
  }
}
function hideThemePop() { themePop.classList.add('hidden'); }
$('theme-btn').onclick = (e) => {
  e.stopPropagation();
  themePop.classList.toggle('hidden');
  $('theme-btn').setAttribute('aria-expanded', String(!themePop.classList.contains('hidden')));
  applyTheme(currentTheme());
};
document.addEventListener('click', (e) => {
  if (!themePop.classList.contains('hidden') && !themePop.contains(e.target)) hideThemePop();
});
// follow the OS setting until the visitor picks a theme of their own
matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (!chosenTheme) applyTheme(currentTheme());
});

buildThemePop();
// escape hatch: go back to following the system preference
(() => {
  const sysBtn = document.createElement('button');
  sysBtn.className = 'theme-item theme-system';
  sysBtn.innerHTML = `<span class="sw"></span><span class="tl">⟳ Follow system</span>`;
  sysBtn.onclick = () => {
    chosenTheme = false;
    localStorage.removeItem('oc_theme');
    applyTheme(currentTheme());
    hideThemePop();
    toast('Following your system preference');
  };
  themePop.appendChild(sysBtn);
})();
applyTheme(currentTheme());

// ---------- keyboard shortcuts help ----------
const SHORTCUTS = [
  ['Ctrl / ⌘ + Shift + O', 'Start a new chat'],
  ['Ctrl / ⌘ + K', 'Focus the search box'],
  ['Alt + K', 'Command palette (jump to chats, panels, actions)'],
  ['/', 'Insert a prompt (when composer is empty)'],
  ['Ctrl / ⌘ + Enter', 'Send a message'],
  ['?', 'Show this shortcuts help'],
  ['Esc', 'Close dialogs'],
];
function showShortcuts() {
  openModal(`
    <h2>⌨️ Keyboard shortcuts</h2>
    <div class="shortcut-list">
      ${SHORTCUTS.map(([k, d]) => `<div class="shortcut-row"><kbd>${k}</kbd><span>${d}</span></div>`).join('')}
    </div>`);
}

function closeModal() {
  modal.classList.add('hidden');
}

// ---------- first-visit onboarding tour ----------
const TOUR_STEPS = [
  { sel: '#conv-search', title: '🔎 Find anything', body: 'Search chat titles and the full text of every message you\'ve ever sent.' },
  { sel: '#provider-select', title: '🧠 Pick a brain', body: 'Switch between the admin\'s shared models and your own personal providers (🧩).' },
  { sel: '#attach-btn', title: '📎 Feed it context', body: 'Attach text files — or drop, paste and pick images for vision-capable models.' },
  { sel: '#theme-btn', title: '🎨 Make it yours', body: 'Twelve themes, from galaxy dark to daylight. The Prime theme honors Peter Cullen (1941–2026).' },
  { sel: '#show-settings', title: '🗂 Teach it your world', body: 'Everything lives in Settings: documents the AI searches automatically, reminders, stars, memories, your own providers and more.' },
];
function showTour(i = 0) {
  document.querySelectorAll('.tour-spot').forEach((el) => el.classList.remove('tour-spot'));
  if (i >= TOUR_STEPS.length) {
    localStorage.setItem('oc_tour_done', '1');
    return;
  }
  const step = TOUR_STEPS[i];
  const target = document.querySelector(step.sel);
  if (target) {
    target.classList.add('tour-spot');
    target.scrollIntoView?.({ block: 'nearest' });
  }
  const card = document.createElement('div');
  card.className = 'tour-card';
  card.innerHTML = `
    <b>${step.title}</b>
    <p class="muted small">${step.body}</p>
    <div class="row">
      <span class="muted small">${i + 1}/${TOUR_STEPS.length}</span>
      <span style="margin-left:auto;display:flex;gap:6px">
        <button id="tour-skip">skip</button>
        <button id="tour-next" class="primary">${i === TOUR_STEPS.length - 1 ? 'Done' : 'Next'}</button>
      </span>
    </div>`;
  document.body.appendChild(card);
  $('tour-skip').onclick = () => { card.remove(); showTour(TOUR_STEPS.length); };
  $('tour-next').onclick = () => { card.remove(); showTour(i + 1); };
}
// only in the app view, only the first time, never during auth
const tourWatch = setInterval(() => {
  if (!$('app-view').classList.contains('hidden') && me) {
    clearInterval(tourWatch);
    if (!localStorage.getItem('oc_tour_done')) setTimeout(() => showTour(0), 800);
  }
}, 500);
setTimeout(() => clearInterval(tourWatch), 30000);

// ---------- live tail: keep the open chat fresh across devices ----------
let lastMsgId = 0;
let tailTimer = null;
function noteLastMsgId(msgs) {
  for (const m of msgs) if (m.id > lastMsgId) lastMsgId = m.id;
}
async function tailPoll() {
  if (!activeConv || sending || document.hidden) return;
  try {
    const fresh = await api('GET', `/api/conversation/${activeConv}/messages?after=${lastMsgId}`);
    if (fresh.length && activeConv) {
      noteLastMsgId(fresh);
      const box = $('messages');
      const empty = $('empty-state');
      if (empty) empty.remove();
      for (const m of fresh) {
        if (m.role === 'tool_event') box.appendChild(toolEventRow(m.tool_name, m.content));
        else box.appendChild(messageRow(m.role, m.role === 'assistant' ? md(m.content) : esc(m.content), m.created_at, m.role === 'assistant', m.content, m));
      }
      scrollToLatest(true);
      if (fresh.some((m) => m.role === 'assistant')) playChime();
    }
  } catch { /* polling is best-effort */ }
}
document.addEventListener('visibilitychange', () => {
  clearInterval(tailTimer);
  if (!document.hidden && me) {
    tailTimer = setInterval(tailPoll, 4000);
    // after a background gap, also refresh the full list
    if (activeConv) api('GET', `/api/conversation/${activeConv}/messages`).then(renderTailCheck).catch(() => {});
  }
});
function renderTailCheck(msgs) {
  const box = $('messages');
  if (!box || !msgs.length) return;
  const known = new Set([...box.querySelectorAll('.msg-row')].map((r) => Number(r.dataset.mid || 0)));
  const missing = msgs.filter((m) => m.id && !known.has(m.id) && m.id > lastMsgId);
  if (missing.length) tailPoll();
}

// ---------- draft persistence per conversation ----------
const DRAFT_PREFIX = 'oc_draft_';
function saveDraft() {
  if (activeConv) localStorage.setItem(DRAFT_PREFIX + activeConv, inputEl.value);
}
function restoreDraft() {
  inputEl.value = activeConv ? (localStorage.getItem(DRAFT_PREFIX + activeConv) || '') : '';
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + 'px';
}
inputEl.addEventListener('input', saveDraft);
const _openConv = openConv;
openConv = async function (id) {
  await _openConv(id);
  restoreDraft();
};

// ---------- completion chime (opt-in) + desktop notification ----------
function playChime() {
  if (localStorage.getItem('oc_sound') !== '1') return;
  try {
    const ctx = playChime.ctx || (playChime.ctx = new AudioContext());
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.06, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.35);
  } catch {}
}
function notifyReply() {
  if (!('Notification' in window) || document.hidden !== true) return;
  if (Notification.permission === 'granted') {
    try { new Notification('OrionChatV3', { body: 'Your reply is ready ✦', icon: '/logo.png' }); } catch {}
  }
}

// ---------- "what can the AI use?" — the user-facing tool list ----------
$('tools-badge').onclick = async () => {
  const ov = await api('GET', '/api/tools');
  const section = (title, items, emptyHint) => `
    <h3>${title}</h3>
    <div class="admin-section">
      ${items.length ? items.map((t) => `
        <div class="card">
          <div class="row"><b>${esc(t.name)}</b></div>
          <div class="muted small">${esc(t.description || '')}</div>
        </div>`).join('')
      : `<div class="card"><p class="muted small">${emptyHint}</p></div>`}
    </div>`;
  openModal(`
    <h2>🔧 Tools the AI can use right now</h2>
    <p class="muted small">These are offered to the model in every chat. Admins can toggle each one; you can add more via personal MCP servers.</p>
    ${section('Built-in tools', ov.builtin || [], 'No built-in tools enabled.')}
    ${section('Shared MCP servers', ov.mcp || [], 'No admin MCP servers connected.')}
    ${section('Your personal MCP servers', ov.user_mcp || [], 'You have no personal MCP servers — add one under 🔌 My tools.')}
  `);
};

// ---------- settings menu (single sidebar entry → grouped launcher) ----------
const SETTINGS_GROUPS = [
  { key: 'chat', label: 'Chat', items: [
    { id: 'show-instructions', icon: '📝', label: 'Instructions', desc: 'Standing prompts the AI follows in every reply' },
    { id: 'show-prompts', icon: '💡', label: 'Prompt library', desc: 'Reusable prompts, insert with /' },
    { id: 'show-memories', icon: '🧠', label: 'Memories', desc: 'What the AI remembers about you' },
  ]},
  { key: 'data', label: 'Data & activity', items: [
    { id: 'show-documents', icon: '🗂', label: 'Documents', desc: 'Your knowledge base the AI can search' },
    { id: 'show-tasks', icon: '⏰', label: 'Reminders', desc: 'Prompts scheduled to run later' },
    { id: 'show-starred', icon: '⭐', label: 'Starred', desc: 'Messages you bookmarked' },
    { id: 'show-usage', icon: '📊', label: 'My usage', desc: 'Messages, tokens, quota and spend' },
  ]},
  { key: 'connect', label: 'Connect', items: [
    { id: 'show-myproviders', icon: '🧩', label: 'My providers', desc: 'Bring your own API keys (BYOK)' },
    { id: 'show-usermcp', icon: '🔌', label: 'My tools', desc: 'Your personal MCP servers' },
  ]},
  { key: 'account', label: 'Account', items: [
    { id: 'show-account', icon: '👤', label: 'Account & data', desc: 'Profile, 2FA, sessions, import/export, API' },
  ]},
  { key: 'admin', label: 'Administration', adminOnly: true, items: [
    { id: 'show-admin', icon: '⚙️', label: 'Admin panel', desc: 'Providers, MCP, users, platform settings' },
  ]},
];
$('show-settings').onclick = () => openSettings();
function openSettings() {
  openModal(`
    <h2>⚙️ Settings</h2>
    <div class="settings-grid">
      ${SETTINGS_GROUPS
        .filter((g) => !g.adminOnly || me?.role === 'admin')
        .map((g) => `
        <div class="settings-group">
          <div class="side-label" style="padding-left:0">${g.label}</div>
          ${g.items.map((it) => `
            <button class="settings-item" data-open="${it.id}">
              <span class="si-icon">${it.icon}</span>
              <span class="si-text"><b>${it.label}</b><span class="muted small">${it.desc}</span></span>
              <span class="si-arrow">›</span>
            </button>`).join('')}
        </div>`).join('')}
    </div>
  `);
  modal.querySelectorAll('[data-open]').forEach((b) => {
    b.onclick = () => $(b.dataset.open)?.click();
  });
}

// ---------- PWA: installable + offline shell ----------
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('/sw.js').catch(() => { /* offline shell is optional */ });
}

boot();
