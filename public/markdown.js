// OrionChatV3 — markdown renderer (classic script; exposes window.OrionMD)
// Pure string-in/string-out so it can run while stream deltas are still
// arriving. Code blocks carry data attributes; app.js wires copy/preview
// buttons through event delegation.
(() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- tiny syntax highlighter (tokenize-then-escape, no double escaping) ----------
  const HL_KEYWORDS = new Set(('const let var function return if else for while do class import from export default new try catch finally ' +
    'async await yield typeof instanceof delete switch case break continue extends super this static get set ' +
    'def lambda pass raise with as in is not and or None True False elif global nonlocal print ' +
    'null undefined true false function end then fi esac do done echo exit local readonly declare ' +
    'struct enum typedef public private protected virtual override namespace using template typename const_cast ' +
    'int float double char void long short unsigned signed bool string vector map set iferr go defer chan func package ' +
    'SELECT FROM WHERE INSERT UPDATE DELETE CREATE TABLE JOIN LEFT INNER GROUP ORDER BY LIMIT VALUES INTO SET ' +
    'html head body div span script style link meta title').split(' '));
  const HL_RE = /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/|--[^\n]*)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b0x[0-9a-fA-F]+\b|\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$-]*)/g;

  function hl(code) {
    let out = '';
    let last = 0;
    let m;
    HL_RE.lastIndex = 0;
    while ((m = HL_RE.exec(code))) {
      out += esc(code.slice(last, m.index));
      const [full, comment, str, num, word] = m;
      if (comment) out += `<span class="tok-c">${esc(full)}</span>`;
      else if (str) out += `<span class="tok-s">${esc(full)}</span>`;
      else if (num) out += `<span class="tok-n">${esc(full)}</span>`;
      else if (word && HL_KEYWORDS.has(word)) out += `<span class="tok-k">${esc(full)}</span>`;
      else out += esc(full);
      last = m.index + full.length;
    }
    return out + esc(code.slice(last));
  }

  // inline formatting — runs on already-escaped text, so it only ever emits tags
  function inline(t) {
    t = t.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    t = t.replace(/\*\*\*([^*\n]+)\*\*\*/g, '<b><i>$1</i></b>');
    t = t.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
    t = t.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<i>$2</i>');
    t = t.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    t = t.replace(/==([^=\n]+)==/g, '<mark>$1</mark>');
    // [label](url) before bare autolinking
    t = t.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    t = t.replace(/(^|[\s(])(https?:\/\/[^\s<)"']+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
    return t;
  }

  function codeBlockHtml(lang, code) {
    const l = esc(lang || 'text');
    const previewable = /^(html|svg|xml|markup)$/.test((lang || '').toLowerCase());
    return `<div class="codeblock" data-code-enc placeholder>` +
      `<div class="codebar"><span class="code-lang">${l}</span><span class="code-actions">` +
      (previewable ? `<button class="code-preview" data-preview="1">▶ preview</button>` : '') +
      `<button class="code-copy" data-copy="1">⧉ copy</button>` +
      `</span></div>` +
      `<pre><code data-lang="${l}">${hl(code)}</code></pre></div>`;
  }

  // keep code text intact through the escape phase by parking it base64 in a data attr
  function md(text) {
    const blocks = [];
    let t = String(text ?? '').replace(/```([\w+-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
      blocks.push(codeBlockHtml(lang, code.replace(/\n$/, '')).replace('data-code-enc placeholder',
        `data-raw="${btoa(unescape(encodeURIComponent(code.replace(/\n$/, ''))))}"`));
      return `\u0000${blocks.length - 1}\u0000`;
    });
    t = esc(t);
    t = inline(t);

    // tables: | a | b |\n|---|---|\n| 1 | 2 |
    t = t.replace(/(?:^|\n)((?:[ \t]*\|[^\n]+\|[ \t]*\n)[ \t]*\|[-| :]+\|[ \t]*\n(?:[ \t]*\|[^\n]+\|[ \t]*\n?)*)/g, (full) => {
      const lines = full.trim().split('\n').filter((l) => l.trim());
      const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
      const head = cells(lines[0]);
      const bodyRows = lines.slice(2).map(cells);
      const th = head.map((h) => `<th>${h}</th>`).join('');
      const tb = bodyRows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('');
      return `\n<table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table>\n`;
    });

    // task lists before plain bullets: - [ ] and - [x]
    t = t.replace(/(?:^|\n)((?:[ \t]*[-*][ \t]+\[[ xX]\][ \t]+[^\n]+\n?)+)/g, (_, block) => {
      const items = block.trim().split('\n').map((l) => {
        const done = /\[[xX]\]/.test(l);
        return `<li class="task${done ? ' done' : ''}"><span class="tick">${done ? '☑' : '☐'}</span><span>${inline(l.replace(/^[ \t]*[-*][ \t]+\[[ xX]\][ \t]*/, ''))}</span></li>`;
      });
      return `\n<ul class="tasks">${items.join('')}</ul>\n`;
    });

    // bullet lists
    t = t.replace(/(?:^|\n)((?:[ \t]*[-*][ \t]+[^\n]+\n?)+)/g, (_, block) => {
      const items = block.trim().split('\n').map((l) => `<li>${inline(l.replace(/^[ \t]*[-*][ \t]+/, ''))}</li>`);
      return `\n<ul>${items.join('')}</ul>\n`;
    });
    // ordered lists
    t = t.replace(/(?:^|\n)((?:[ \t]*\d+\.[ \t]+[^\n]+\n?)+)/g, (_, block) => {
      const items = block.trim().split('\n').map((l) => `<li>${inline(l.replace(/^[ \t]*\d+\.[ \t]+/, ''))}</li>`);
      return `\n<ol>${items.join('')}</ol>\n`;
    });

    // blockquotes (>, >> …) — allow the run to break naturally at <br>
    t = t.replace(/(?:^|\n)((?:[ \t]*&gt;[^\n]*\n?)+)/g, (_, block) => {
      const inner = block.trim().split('\n')
        .map((l) => l.replace(/^[ \t]*&gt;[ \t]?/, ''))
        .map((l) => (l ? inline(l) : ''))
        .join('<br>');
      return `\n<blockquote>${inner}</blockquote>\n`;
    });

    // headings (# … ####) and horizontal rules
    t = t.replace(/^### ([^\n]+)$/gm, '<h5>$1</h5>');
    t = t.replace(/^## ([^\n]+)$/gm, '<h4>$1</h4>');
    t = t.replace(/^# ([^\n]+)$/gm, '<h3 class="md-h3">$1</h3>');
    t = t.replace(/^(?:---|\*\*\*)[ \t]*$/gm, '<hr>');

    t = t.replace(/\n/g, '<br>');
    t = t.replace(/<br>\s*(<ul>|<ol>|<table>|<blockquote>|<h[3-5]>|<hr>)/g, '$1');
    t = t.replace(/(<\/ul>|<\/ol>|<\/table>|<\/blockquote>|<\/h[3-5]>|<hr>)\s*<br>/g, '$1');
    t = t.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[i] ?? '');
    return t;
  }

  // decode the parked raw code for copy/preview actions
  function rawCode(blockEl) {
    const enc = blockEl?.dataset?.raw || '';
    try { return decodeURIComponent(escape(atob(enc))); } catch { return blockEl?.textContent || ''; }
  }

  window.OrionMD = { md, hl, rawCode, inline };
})();
