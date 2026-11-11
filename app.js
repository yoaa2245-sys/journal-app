'use strict';

/* ---------- basics ---------- */
const $ = (s) => document.querySelector(s);
const te = new TextEncoder();
const td = new TextDecoder();
const MOODS = ['\u{1F61E}', '\u{1F615}', '\u{1F610}', '\u{1F642}', '\u{1F604}'];
const VOCAB_PATH = 'journal/vocabulary.txt';
const HABITS_PATH = 'journal/habits.json';
const ENTRY_RE = /^journal\/\d{4}\/\d{2}\/(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})(?:-([^/]*))?\.md$/;
const AUTO_LOCK_MS = 5 * 60 * 1000;
const DEF = {
  sttModel: 'whisper-large-v3', language: 'en', cleanup: 'groq',
  groqChatModel: 'openai/gpt-oss-120b', claudeModel: 'claude-opus-5-5', branch: 'main',
};
const SETTING_KEYS = ['groqKey', 'sttModel', 'language', 'cleanup', 'groqChatModel', 'anthropicKey', 'claudeModel', 'repo', 'branch', 'ghToken'];

let vault = { settings: {}, meta: {} };
let entries = [];            // [{path, sha, date, day, slug}]
let vocab = { text: '', sha: null };
let habits = { data: { habits: [], log: {} }, sha: null, ops: [], timer: null };
let loading = false;

const cfg = (k) => (vault.settings[k] ?? '') !== '' ? vault.settings[k] : (DEF[k] || '');
const configured = () => !!(cfg('groqKey') && cfg('ghToken') && cfg('repo'));

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, ms);
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function localISO(d) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${dayKey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}
const fmtDur = (s) => `${Math.floor(s / 60)}:${pad(Math.floor(s % 60))}`;
const fmtDate = (d) => d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
const fmtTime = (d) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const b64encode = (str) => {
  const u8 = te.encode(str); let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
};
const b64decode = (b) => td.decode(Uint8Array.from(atob(b.replace(/\s/g, '')), (c) => c.charCodeAt(0)));
const slugify = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 48).replace(/-$/, '');
const unslug = (s) => s ? s.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()) : 'Untitled';
const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const vocabList = () => vocab.text.split('\n').map((s) => s.trim()).filter(Boolean);

let vaultSaveTimer = null;
function saveVaultSoon() {
  clearTimeout(vaultSaveTimer);
  vaultSaveTimer = setTimeout(() => Vault.save(vault).catch(() => {}), 400);
}

async function pool(items, n, fn) {
  const queue = items.slice();
  const workers = Array.from({ length: Math.min(n, queue.length) }, async () => {
    while (queue.length) { const it = queue.shift(); try { await fn(it); } catch {} }
  });
  await Promise.all(workers);
}

/* ---------- GitHub storage ---------- */
async function gh(path, opts = {}) {
  if (!cfg('repo') || !cfg('ghToken')) throw new Error('Add your repo and GitHub token in More.');
  const url = path.startsWith('http') ? path : `https://api.github.com/repos/${cfg('repo')}${path}`;
  const res = await fetch(url, {
    cache: 'no-store',
    ...opts,
    headers: {
      Authorization: `Bearer ${cfg('ghToken')}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    let msg = ''; try { msg = (await res.json()).message || ''; } catch {}
    const e = new Error(res.status === 401 ? 'GitHub token was rejected. Check it in More.'
      : res.status === 404 ? `Not found on GitHub (${msg || path}). Check the repo name and token access.`
      : `GitHub ${res.status}: ${msg}`);
    e.status = res.status; throw e;
  }
  return res.status === 204 ? null : res.json();
}
const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');
async function getFile(path) {
  try {
    const r = await gh(`/contents/${encPath(path)}?ref=${encodeURIComponent(cfg('branch'))}`);
    return { text: b64decode(r.content), sha: r.sha };
  } catch (e) { if (e.status === 404) return null; throw e; }
}
async function putFile(path, text, message, sha) {
  const body = { message, content: b64encode(text), branch: cfg('branch') };
  if (sha) body.sha = sha;
  const r = await gh(`/contents/${encPath(path)}`, { method: 'PUT', body: JSON.stringify(body) });
  return r.content.sha;
}
async function getBlob(sha) {
  const r = await gh(`/git/blobs/${sha}`);
  return b64decode(r.content);
}
// Write many files in a single commit (used for big imports).
async function commitFiles(list, message, attempt = 0) {
  const branch = encodeURIComponent(cfg('branch'));
  try {
    const ref = await gh(`/git/ref/heads/${branch}`);
    const base = ref.object.sha;
    const parent = await gh(`/git/commits/${base}`);
    const tree = await gh('/git/trees', { method: 'POST', body: JSON.stringify({
      base_tree: parent.tree.sha,
      tree: list.map((f) => ({ path: f.path, mode: '100644', type: 'blob', content: f.text })),
    }) });
    const c = await gh('/git/commits', { method: 'POST', body: JSON.stringify({ message, tree: tree.sha, parents: [base] }) });
    await gh(`/git/refs/heads/${branch}`, { method: 'PATCH', body: JSON.stringify({ sha: c.sha }) });
  } catch (e) {
    if (attempt < 2 && (e.status === 409 || e.status === 422)) return commitFiles(list, message, attempt + 1);
    throw e;
  }
}

/* ---------- entry format ---------- */
function parseEntry(md) {
  md = md.replace(/\r\n/g, '\n');
  const fm = {}; let body = md;
  const m = md.match(/^---\n([\s\S]*?)\n---\n?/);
  if (m) {
    body = md.slice(m[0].length);
    for (const line of m[1].split('\n')) {
      const i = line.indexOf(':'); if (i < 1) continue;
      const k = line.slice(0, i).trim(); const v = line.slice(i + 1).trim();
      try { fm[k] = JSON.parse(v); } catch { fm[k] = v.replace(/^["']|["']$/g, ''); }
    }
  }
  let raw = '';
  const d = body.match(/<details>\s*<summary>[^<]*<\/summary>([\s\S]*?)<\/details>/);
  if (d) { raw = d[1].trim(); body = body.replace(d[0], ''); }
  body = body.trim();
  let title = fm.title || '';
  const h = body.match(/^# (.+)\n?/);
  if (h) { title = title || h[1].trim(); body = body.slice(h[0].length).trim(); }
  return { fm, title, body, raw };
}
function metaFrom(md) {
  const p = parseEntry(md);
  const mood = Number(p.fm.mood);
  return {
    title: p.title || '',
    mood: mood >= 1 && mood <= 5 ? Math.round(mood) : null,
    tags: Array.isArray(p.fm.tags) ? p.fm.tags.map(String) : [],
    words: p.body.split(/\s+/).filter(Boolean).length,
  };
}
function buildEntry({ date, title, text, raw, mood, tags, duration, source }) {
  const words = text.split(/\s+/).filter(Boolean).length;
  const lines = ['---', `date: ${localISO(date)}`, `title: ${JSON.stringify(title)}`];
  if (mood) lines.push(`mood: ${mood}`);
  if (tags && tags.length) lines.push(`tags: ${JSON.stringify(tags)}`);
  if (duration) lines.push(`duration: ${JSON.stringify(fmtDur(duration))}`);
  lines.push(`words: ${words}`, `source: ${source || 'voice'}`, '---', '', `# ${title}`, '', text.trim(), '');
  if (raw && raw.trim() !== text.trim()) {
    lines.push('<details>', '<summary>Raw transcript</summary>', '', raw.trim(), '', '</details>', '');
  }
  return lines.join('\n');
}
function entryPath(date, title) {
  const y = date.getFullYear(); const m = pad(date.getMonth() + 1);
  const stamp = `${dayKey(date)}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  const slug = slugify(title);
  return `journal/${y}/${m}/${stamp}${slug ? '-' + slug : ''}.md`;
}

/* ---------- encrypted pending store (IndexedDB) ---------- */
const IDB = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((res, rej) => {
      const r = indexedDB.open('voice-journal', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('pending', { keyPath: 'id' });
      r.onsuccess = () => { this.db = r.result; res(this.db); };
      r.onerror = () => rej(r.error);
    });
  },
  async tx(mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const t = db.transaction('pending', mode); const st = t.objectStore('pending');
      const req = fn(st);
      t.oncomplete = () => res(req && req.result); t.onerror = () => rej(t.error);
    });
  },
  put(v) { return this.tx('readwrite', (s) => s.put(v)); },
  get(id) { return this.tx('readonly', (s) => s.get(id)); },
  all() { return this.tx('readonly', (s) => s.getAll()); },
  del(id) { return this.tx('readwrite', (s) => s.delete(id)); },
  clear() { return this.tx('readwrite', (s) => s.clear()); },
};
async function putPending(rec) {
  const { audio, ...meta } = rec;
  const audioBytes = audio ? new Uint8Array(await audio.arrayBuffer()) : new Uint8Array(0);
  const header = te.encode(JSON.stringify({ ...meta, audioType: audio ? audio.type : '' }));
  const packed = new Uint8Array(4 + header.length + audioBytes.length);
  new DataView(packed.buffer).setUint32(0, header.length);
  packed.set(header, 4); packed.set(audioBytes, 4 + header.length);
  await IDB.put({ id: rec.id, data: await Vault.encrypt(packed) });
}
async function getPending(id) {
  const r = await IDB.get(id); if (!r) return null;
  return unpack(await Vault.decrypt(r.data));
}
function unpack(u8) {
  const len = new DataView(u8.buffer, u8.byteOffset).getUint32(0);
  const meta = JSON.parse(td.decode(u8.subarray(4, 4 + len)));
  const rest = u8.subarray(4 + len);
  if (rest.length) meta.audio = new Blob([rest], { type: meta.audioType || 'audio/mp4' });
  return meta;
}
async function allPending() {
  const rows = await IDB.all(); const out = [];
  for (const r of rows) { try { out.push(unpack(await Vault.decrypt(r.data))); } catch {} }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/* ---------- transcription + cleanup ---------- */
function extFor(type, name) {
  const fromName = name && name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  if (fromName) return fromName;
  if (/mp4|m4a|aac/.test(type)) return 'm4a';
  if (/mpeg|mp3/.test(type)) return 'mp3';
  if (/webm/.test(type)) return 'webm';
  if (/ogg/.test(type)) return 'ogg';
  if (/wav/.test(type)) return 'wav';
  return 'm4a';
}
// Retry politely when a free tier says "slow down".
// Free tiers cap how much text goes through per minute. When we hit the cap,
// wait as long as the service asks (its error says "try again in 7.9s") and retry.
async function fetchRetry(url, opts, tries = 8) {
  for (let i = 0; ; i++) {
    const res = await fetch(url, opts);
    if (res.status !== 429 || i >= tries - 1) return res;
    let wait = Number(res.headers.get('retry-after')) || 0;
    if (!wait) {
      try {
        const m = (await res.clone().text()).match(/try again in (?:(\d+)m)?([\d.]+)(ms|s)/i);
        if (m) wait = (Number(m[1] || 0) * 60) + (m[3] === 'ms' ? Number(m[2]) / 1000 : Number(m[2]));
      } catch {}
    }
    wait = Math.min(90, (wait || 2 ** (i + 2)) + 1);
    if (i === 0) toast(`Free limit reached. Waiting ${Math.ceil(wait)}s and trying again...`, 4000);
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
}
async function errText(res) {
  try { const j = await res.json(); return (j.error && (j.error.message || j.error)) || JSON.stringify(j); } catch { return res.statusText; }
}
async function transcribe(blob, name) {
  if (blob.size > 25 * 1024 * 1024) throw new Error('Audio is over 25 MB, the free tier limit. Try a shorter recording.');
  const fd = new FormData();
  fd.append('file', blob, `audio.${extFor(blob.type, name)}`);
  fd.append('model', cfg('sttModel'));
  if (cfg('language')) fd.append('language', cfg('language'));
  const words = vocabList();
  if (words.length) fd.append('prompt', `Journal entry. Names and words that may come up: ${words.join(', ')}.`.slice(0, 800));
  fd.append('response_format', 'json');
  fd.append('temperature', '0');
  const res = await fetchRetry('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST', headers: { Authorization: `Bearer ${cfg('groqKey')}` }, body: fd,
  });
  if (!res.ok) throw new Error(`Transcription failed (${res.status}): ${await errText(res)}`);
  return String((await res.json()).text || '').trim();
}

const CLEAN_SYSTEM = `You clean up voice journal transcripts so they read well, without changing what the person said.

Rules:
- Remove filler words and verbal tics that carry no meaning: um, uh, like, you know, I mean, kind of, sort of, basically, literally, so yeah, right.
- Remove false starts, stutters and accidentally repeated words. Fix punctuation, capitalization and run-on sentences. Break the text into paragraphs where the topic shifts.
- Keep the person's own words, voice, tone, slang and swearing. Do not summarize, shorten ideas, add anything, reorder, or make it sound more formal. Keep it in first person exactly as spoken.
- Keep every sentence and every detail, including side comments, asides in parentheses, names, numbers and repeated thoughts. Never merge two thoughts into one or drop anything that has meaning. When in doubt, keep it.
- Never censor or soften anything. Keep swear words, sexual content and slang exactly as said, with no asterisks.
- Speech to text often mishears names. Use the vocabulary list: when a word or phrase in the transcript sounds like an item on the list, replace it with the list's exact spelling. Leave other names alone unless the mistake is obvious.

Reply with only a JSON object, no other text:
{"text": "the cleaned text, paragraphs separated by \\n\\n"}`;

function cleanUserMsg(raw, typed) {
  const words = vocabList();
  return `Vocabulary list:\n${words.length ? words.join('\n') : '(empty)'}\n\n${typed ? 'Note: this text was typed or transcribed by another app, not straight from speech. Make only light fixes.\n\n' : ''}Transcript:\n<<<\n${raw}\n>>>`;
}
function parseJsonLoose(t) {
  const a = t.indexOf('{'); const b = t.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('Cleanup did not return JSON');
  return JSON.parse(t.slice(a, b + 1));
}
function normClean(j, raw) {
  const mood = Math.round(Number(j.mood));
  return {
    title: String(j.title || '').trim().slice(0, 90) || defaultTitle(raw),
    text: String(j.text || '').trim() || raw,
    mood: mood >= 1 && mood <= 5 ? mood : null,
    tags: Array.isArray(j.tags) ? j.tags.map((t) => String(t).toLowerCase().trim()).filter(Boolean).slice(0, 4) : [],
  };
}
// Sends one prompt to the chosen cleanup provider and returns the reply text.
async function askAI(system, user) {
  if (cfg('cleanup') === 'claude') {
    if (!cfg('anthropicKey')) throw new Error('Add an Anthropic API key in More, or switch cleanup to Groq.');
    const model = cfg('claudeModel');
    const headers = {
      'x-api-key': cfg('anthropicKey'), 'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true', 'content-type': 'application/json',
    };
    const body = { model, max_tokens: 16000, system, messages: [{ role: 'user', content: user }], output_config: { effort: 'low' } };
    if (model !== 'claude-haiku-5-5') { headers['anthropic-beta'] = 'server-side-fallback-2026-07-01'; body.fallbacks = 'default'; }
    const res = await fetchRetry('https://api.anthropic.com/v1/messages', { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`Claude failed (${res.status}): ${await errText(res)}`);
    const data = await res.json();
    if (data.stop_reason === 'refusal') throw new Error('Claude declined this entry. You can still save it as is.');
    return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  }
  const call = async (json) => {
    const body = { model: cfg('groqChatModel'), temperature: 0.2, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
    if (json) body.response_format = { type: 'json_object' };
    return fetchRetry('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST', headers: { Authorization: `Bearer ${cfg('groqKey')}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
  };
  let res = await call(true);
  if (res.status === 400) res = await call(false);
  if (!res.ok) throw new Error(`Cleanup failed (${res.status}): ${await errText(res)}`);
  const data = await res.json();
  return data.choices[0].message.content || '';
}
// Models tend to summarize long input, so long entries are cleaned in small pieces,
// and every piece is checked against the original. A piece that lost words (or got
// censored) is retried once and otherwise kept exactly as originally said.
const FILLER = new Set('um uh uhh umm like you know i mean kind of sort basically literally so yeah right okay ok oh ah hmm mm'.split(' '));
const contentWords = (t) => (String(t).toLowerCase().match(/[a-z0-9']+/g) || []).filter((w) => !FILLER.has(w));
function keptEnough(orig, cleaned) {
  if (/\*{2,}/.test(cleaned) && !/\*{2,}/.test(orig)) return false;
  const left = new Map();
  for (const w of contentWords(cleaned)) left.set(w, (left.get(w) || 0) + 1);
  const want = contentWords(orig); let hit = 0;
  for (const w of want) { const n = left.get(w) || 0; if (n) { hit++; left.set(w, n - 1); } }
  return !want.length || hit / want.length >= 0.88;
}
function splitChunks(text, max = 220) {
  const out = []; let cur = [];
  const flush = () => { if (cur.length) { out.push(cur.join(' ')); cur = []; } };
  for (const para of text.split(/\n\s*\n/)) {
    for (const sent of para.match(/[^.!?\n]+[.!?]*["')\]]*\s*|\n/g) || []) {
      const words = sent.trim().split(/\s+/).filter(Boolean);
      for (let i = 0; i < words.length; i += max) {
        const piece = words.slice(i, i + max);
        if (cur.length + piece.length > max) flush();
        cur.push(...piece);
      }
    }
    flush();
  }
  return out.length ? out : [text];
}
async function cleanChunk(piece, typed) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const t = String(parseJsonLoose(await askAI(CLEAN_SYSTEM, cleanUserMsg(piece, typed))).text || '').trim();
      if (t && keptEnough(piece, t)) return { text: t, kept: true };
    } catch (e) { if (attempt) throw e; }
  }
  return { text: piece.trim(), kept: false };
}
async function cleanup(raw, typed) {
  if (cfg('cleanup') === 'none' || !raw.trim()) return { title: defaultTitle(raw), text: raw, mood: null, tags: [] };
  const parts = []; let untouched = 0;
  for (const piece of splitChunks(raw)) {
    const r = await cleanChunk(piece, typed);
    if (!r.kept) untouched++;
    parts.push(r.text);
  }
  const text = parts.join('\n\n');
  let meta = { title: defaultTitle(text), tags: [], mood: null };
  try { meta = await autoMeta(text); } catch {}
  return { ...meta, text, untouched };
}
const META_SYSTEM = `You label journal entries. Read the entry and reply with only a JSON object, no other text:
{"title": "a short 3 to 7 word title in the person's own terms", "mood": 1-5 integer for the person's overall mood (1 very low, 3 neutral, 5 great), "tags": ["1 to 4 short lowercase topic tags"]}`;
// Picks a title, tags and mood without touching the text.
async function autoMeta(text) {
  const j = parseJsonLoose(await askAI(META_SYSTEM, `Entry:\n<<<\n${text}\n>>>`));
  const n = normClean({ ...j, text }, text);
  return { title: n.title, tags: n.tags, mood: n.mood };
}
function defaultTitle(text) {
  const w = String(text || '').replace(/\s+/g, ' ').trim().split(' ').slice(0, 6).join(' ');
  return w ? w.replace(/[.,;:!?]+$/, '') : 'Journal entry';
}

async function processRecord(id) {
  const rec = await getPending(id);
  if (!rec) return null;
  try {
    if (!rec.raw && rec.audio) {
      setReviewStatus('Transcribing...');
      rec.raw = await transcribe(rec.audio, rec.fileName);
      rec.error = ''; await putPending(rec);
    }
    if (!rec.cleaned) {
      setReviewStatus(cfg('cleanup') === 'none' ? '' : 'Cleaning up...');
      const c = await cleanup(rec.raw || '', rec.source !== 'voice' && rec.source !== 'import-audio');
      Object.assign(rec, c, { cleaned: true, error: '' });
      if (c.untouched) rec.note = `${c.untouched} part${c.untouched === 1 ? ' was' : 's were'} left exactly as you said ${c.untouched === 1 ? 'it' : 'them'}, because the cleanup tried to cut words.`;
      await putPending(rec);
    }
  } catch (e) {
    rec.error = e.message; await putPending(rec);
    throw e;
  }
  return rec;
}
function setReviewStatus(msg, isErr) {
  const s = $('#reviewStatus'); s.textContent = msg || ''; s.classList.toggle('error', !!isErr);
}

async function saveRecordAsEntry(rec) {
  const date = new Date(rec.createdAt);
  const title = (rec.title || '').trim() || defaultTitle(rec.text || rec.raw);
  const text = (rec.text || rec.raw || '').trim();
  if (!text) throw new Error('Nothing to save: the entry is empty.');
  const md = buildEntry({ date, title, text, raw: rec.raw, mood: rec.mood, tags: rec.tags, duration: rec.duration, source: rec.source });
  const path = entryPath(date, title);
  const sha = await putFile(path, md, `Journal: ${title}`);
  vault.meta[sha] = metaFrom(md); saveVaultSoon();
  const m = path.match(ENTRY_RE);
  entries = entries.filter((e) => e.path !== path);
  entries.push({ path, sha, date, day: dayKey(date), slug: m ? m[7] || '' : '' });
  entries.sort((a, b) => b.date - a.date);
  await IDB.del(rec.id);
  return path;
}

/* ---------- recorder ---------- */
let rec = null;
function pickMime() {
  if (!window.MediaRecorder) return null;
  for (const m of ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg']) if (MediaRecorder.isTypeSupported(m)) return m;
  return '';
}
const recElapsed = () => rec ? (rec.before + (rec.paused ? 0 : (Date.now() - rec.segStart))) / 1000 : 0;
function recBlob() { return new Blob(rec.chunks, { type: (rec.mr.mimeType || 'audio/mp4').split(';')[0] }); }

async function startRec() {
  if (!configured()) { toast('Finish setup in More first'); location.hash = '#more'; return; }
  const mime = pickMime();
  if (mime === null || !navigator.mediaDevices) { toast('This browser cannot record audio'); return; }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
  catch { toast('Microphone access was blocked. Allow it in Settings for this site.'); return; }
  const mr = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 64000 } : { audioBitsPerSecond: 64000 });
  rec = { mr, stream, chunks: [], before: 0, segStart: Date.now(), paused: false, id: newId(), createdAt: localISO(new Date()) };
  mr.ondataavailable = (e) => { if (e.data && e.data.size) rec && rec.chunks.push(e.data); };
  mr.start(1000);
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    rec.ctx = new AC(); const src = rec.ctx.createMediaStreamSource(stream);
    rec.analyser = rec.ctx.createAnalyser(); rec.analyser.fftSize = 256; src.connect(rec.analyser);
  } catch {}
  try { rec.wake = await navigator.wakeLock.request('screen'); } catch {}
  rec.tick = setInterval(updateRecUI, 250);
  rec.backup = setInterval(() => {
    if (!rec) return;
    putPending({ id: rec.id, createdAt: rec.createdAt, source: 'voice', stage: 'recording', duration: recElapsed(), audio: recBlob() }).catch(() => {});
  }, 15000);
  drawMeter();
  updateRecUI();
}
function teardownRec() {
  if (!rec) return;
  clearInterval(rec.tick); clearInterval(rec.backup); cancelAnimationFrame(rec.raf);
  rec.stream.getTracks().forEach((t) => t.stop());
  try { rec.ctx && rec.ctx.close(); } catch {}
  try { rec.wake && rec.wake.release(); } catch {}
}
async function stopRec() {
  if (!rec) return;
  const r = rec;
  const duration = recElapsed();
  await new Promise((res) => { r.mr.onstop = res; r.mr.stop(); });
  teardownRec();
  const audio = recBlob();
  rec = null; updateRecUI(); drawIdle();
  if (duration < 1.5 || !audio.size) { await IDB.del(r.id); toast('Too short, nothing saved'); return; }
  await putPending({ id: r.id, createdAt: r.createdAt, source: 'voice', stage: 'recorded', duration, audio });
  location.hash = `#review/${r.id}`;
}
function togglePause() {
  if (!rec) return;
  if (rec.paused) { rec.mr.resume(); rec.segStart = Date.now(); rec.paused = false; }
  else { rec.mr.pause(); rec.before += Date.now() - rec.segStart; rec.paused = true; }
  updateRecUI();
}
async function cancelRec() {
  if (!rec || !confirm('Discard this recording?')) return;
  const id = rec.id;
  rec.mr.stop(); teardownRec(); rec = null;
  await IDB.del(id); updateRecUI(); drawIdle(); renderPending();
}
function updateRecUI() {
  const on = !!rec;
  $('#recBtn').classList.toggle('on', on);
  $('#recBtn').classList.toggle('paused', on && rec.paused);
  $('#recBtn').setAttribute('aria-label', on ? 'Stop and save' : 'Start recording');
  $('#pauseBtn').hidden = !on; $('#cancelBtn').hidden = !on;
  $('#pauseBtn').textContent = on && rec.paused ? 'Resume' : 'Pause';
  $('#timer').textContent = fmtDur(recElapsed());
  $('#recHint').textContent = on ? (rec.paused ? 'Paused' : 'Listening. Tap the square when you are done.') : "Tap to talk. Say whatever's on your mind.";
}
function drawMeter() {
  const c = $('#meter'); const g = c.getContext('2d');
  const bars = 48; const data = new Uint8Array(rec && rec.analyser ? rec.analyser.frequencyBinCount : 0);
  const loop = () => {
    if (!rec) return;
    g.clearRect(0, 0, c.width, c.height);
    if (rec.analyser) rec.analyser.getByteFrequencyData(data);
    const w = c.width / bars;
    for (let i = 0; i < bars; i++) {
      const v = rec.paused || !data.length ? 0 : data[Math.floor((i / bars) * data.length * 0.7)] / 255;
      const h = Math.max(4, v * c.height * 0.95);
      g.fillStyle = 'rgba(255,255,255,0.85)';
      g.beginPath(); g.roundRect ? g.roundRect(i * w + w * 0.2, (c.height - h) / 2, w * 0.6, h, 3) : g.rect(i * w + w * 0.2, (c.height - h) / 2, w * 0.6, h); g.fill();
    }
    rec.raf = requestAnimationFrame(loop);
  };
  loop();
}
function drawIdle() {
  const c = $('#meter'); const g = c.getContext('2d'); const bars = 48; const w = c.width / bars;
  g.clearRect(0, 0, c.width, c.height);
  for (let i = 0; i < bars; i++) {
    const h = 4 + Math.abs(Math.sin(i * 0.55)) * 10;
    g.fillStyle = 'rgba(255,255,255,0.4)';
    g.fillRect(i * w + w * 0.2, (c.height - h) / 2, w * 0.6, h);
  }
}

/* ---------- habits ---------- */
async function loadHabits() {
  const f = await getFile(HABITS_PATH);
  if (f) {
    try { const d = JSON.parse(f.text); habits.data = { habits: d.habits || [], log: d.log || {} }; } catch {}
    habits.sha = f.sha;
  }
  applyHabitOps(habits.data, habits.ops);
}
function applyHabitOps(d, ops) {
  for (const op of ops) {
    if (op.t === 'add' && !d.habits.some((h) => h.id === op.habit.id)) d.habits.push(op.habit);
    if (op.t === 'del') d.habits = d.habits.filter((h) => h.id !== op.id);
    if (op.t === 'set') {
      const arr = new Set(d.log[op.day] || []);
      op.on ? arr.add(op.id) : arr.delete(op.id);
      if (arr.size) d.log[op.day] = [...arr]; else delete d.log[op.day];
    }
  }
}
function habitOp(op) {
  habits.ops.push(op);
  applyHabitOps(habits.data, [op]);
  renderHabits(); renderTodayHabits();
  clearTimeout(habits.timer);
  habits.timer = setTimeout(saveHabits, 1500);
}
async function saveHabits(attempt = 0) {
  if (!habits.ops.length) return;
  const ops = habits.ops.slice();
  try {
    const f = await getFile(HABITS_PATH);
    const d = f ? JSON.parse(f.text) : { habits: [], log: {} };
    d.habits = d.habits || []; d.log = d.log || {};
    applyHabitOps(d, ops);
    const sorted = {}; Object.keys(d.log).sort().forEach((k) => { sorted[k] = d.log[k]; });
    d.log = sorted;
    habits.sha = await putFile(HABITS_PATH, JSON.stringify(d, null, 2) + '\n', 'Update habits', f && f.sha);
    habits.ops = habits.ops.slice(ops.length);
    habits.data = d; applyHabitOps(habits.data, habits.ops);
  } catch (e) {
    if (attempt < 2 && (e.status === 409 || e.status === 422)) return saveHabits(attempt + 1);
    toast(`Habits not synced yet: ${e.message}`);
    habits.timer = setTimeout(saveHabits, 10000);
  }
}
function doneCount(id, days) {
  let n = 0; const d = new Date();
  for (let i = 0; i < days; i++) { if ((habits.data.log[dayKey(d)] || []).includes(id)) n++; d.setDate(d.getDate() - 1); }
  return n;
}
function renderTodayHabits() {
  const wrap = $('#todayHabits'); const today = dayKey(new Date());
  const done = new Set(habits.data.log[today] || []);
  if (!habits.data.habits.length) { wrap.innerHTML = '<span class="muted">No habits yet. <a href="#habits">Add one</a></span>'; return; }
  wrap.innerHTML = habits.data.habits.map((h) =>
    `<button class="chip ${done.has(h.id) ? 'on' : ''}" data-habit="${esc(h.id)}">${esc(h.emoji || '•')} ${esc(h.name)}</button>`).join('');
}
function renderHabits() {
  const list = $('#habitList');
  if (!habits.data.habits.length) { list.innerHTML = '<div class="card"><p class="muted" style="margin:0">Add something you want to keep track of. Tap it on the Today screen when you do it. Missed days are fine, nothing resets.</p></div>'; return; }
  list.innerHTML = habits.data.habits.map((h) => {
    const total = Object.values(habits.data.log).filter((a) => a.includes(h.id)).length;
    const counts = {}; Object.entries(habits.data.log).forEach(([d, a]) => { if (a.includes(h.id)) counts[d] = 3; });
    return `<div class="card habit-card">
      <div class="hc-top"><div class="emoji">${esc(h.emoji || '•')}</div>
        <div class="grow"><div class="name">${esc(h.name)}</div>
        <div class="sub">${doneCount(h.id, 7)} of the last 7 days · ${total} time${total === 1 ? '' : 's'} total</div></div>
        <button class="del" data-del-habit="${esc(h.id)}" aria-label="Delete ${esc(h.name)}">&times;</button></div>
      ${heatmapHTML(counts, 16)}</div>`;
  }).join('');
}

/* ---------- dashboard rendering ---------- */
function heatmapHTML(counts, weeks) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const start = new Date(today); start.setDate(start.getDate() - start.getDay() - (weeks - 1) * 7);
  let html = '<div class="heatmap">';
  const tk = dayKey(today);
  for (let i = 0; i < weeks * 7; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const k = dayKey(d); const n = counts[k] || 0;
    const cls = d > today ? 'future' : (k === tk ? 'today' : '');
    html += `<i data-l="${Math.min(n, 3)}" class="${cls}" title="${k}${n ? ': ' + n : ''}"></i>`;
  }
  return html + '</div>';
}
function metaOf(e) { return vault.meta[e.sha] || null; }
function titleOf(e) { const m = metaOf(e); return (m && m.title) || unslug(e.slug); }

function renderDashboard() {
  const now = new Date();
  $('#todayDate').textContent = now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const h = now.getHours();
  $('#greeting').textContent = h < 5 ? 'Up late?' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : h < 22 ? 'Good evening' : 'Winding down?';
  $('#setupNotice').hidden = configured();

  const counts = {}; entries.forEach((e) => { counts[e.day] = (counts[e.day] || 0) + 1; });
  const monthPrefix = dayKey(now).slice(0, 7);
  $('#statMonth').textContent = Object.keys(counts).filter((k) => k.startsWith(monthPrefix)).length;
  $('#statTotal').textContent = entries.length;
  const daysInRange = Object.keys(counts).filter((k) => (now - new Date(k)) / 864e5 < 16 * 7).length;
  $('#heatLegend').textContent = `${daysInRange} day${daysInRange === 1 ? '' : 's'} with an entry`;
  $('#heatmap').outerHTML = heatmapHTML(counts, 16).replace('<div class="heatmap">', '<div class="heatmap" id="heatmap">');

  const cutoff = Date.now() - 30 * 864e5;
  const recentMoods = entries.filter((e) => e.date >= cutoff && metaOf(e) && metaOf(e).mood).map((e) => metaOf(e).mood);
  if (recentMoods.length) {
    const avg = recentMoods.reduce((a, b) => a + b, 0) / recentMoods.length;
    $('#statMood').textContent = MOODS[Math.round(avg) - 1];
  } else $('#statMood').textContent = '-';

  renderMoodChart();
  renderTags();
  renderTodayHabits();
  const recent = entries.slice(0, 5);
  $('#recentList').innerHTML = recent.length ? recent.map(itemHTML).join('') : '<li class="empty">No entries yet. Tap the button above to record your first one.</li>';
}
function itemHTML(e) {
  const m = metaOf(e);
  const face = m && m.mood ? MOODS[m.mood - 1] : '\u{1F4DD}';
  const tags = m && m.tags && m.tags.length ? ' · ' + m.tags.map(esc).join(', ') : '';
  return `<li><button class="item" data-open="${esc(e.path)}"><span class="face">${face}</span><span class="body">
    <span class="t">${esc(titleOf(e))}</span><span class="d">${fmtDate(e.date)}, ${fmtTime(e.date)}${tags}</span></span></button></li>`;
}
function renderMoodChart() {
  const pts = entries.filter((e) => metaOf(e) && metaOf(e).mood).slice(0, 30).reverse();
  const wrap = $('#moodChart');
  if (pts.length < 2) { wrap.innerHTML = '<p class="muted" style="margin:0">Mood shows up after a few entries.</p>'; return; }
  const W = 300; const H = 100; const L = 26;
  const x = (i) => L + (i / (pts.length - 1)) * (W - L - 6);
  const y = (m) => 8 + (5 - m) / 4 * (H - 16);
  const xy = pts.map((e, i) => [x(i), y(metaOf(e).mood)]);
  let d = `M${xy[0][0]},${xy[0][1]}`;
  for (let i = 1; i < xy.length; i++) {
    const [px, py] = xy[i - 1]; const [cx, cy] = xy[i]; const mx = (px + cx) / 2;
    d += ` C${mx},${py} ${mx},${cy} ${cx},${cy}`;
  }
  const area = `${d} L${xy[xy.length - 1][0]},${H} L${xy[0][0]},${H} Z`;
  wrap.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Mood over the last ${pts.length} entries">
    <defs><linearGradient id="mg" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${W}" y2="0"><stop offset="0" stop-color="#ff8a3d"/><stop offset="1" stop-color="#e8458b"/></linearGradient>
    <linearGradient id="mf" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff6a3d" stop-opacity=".28"/><stop offset="1" stop-color="#ff6a3d" stop-opacity="0"/></linearGradient></defs>
    <text x="0" y="${y(5) + 5}" class="axis">${MOODS[4]}</text><text x="0" y="${y(3) + 5}" class="axis">${MOODS[2]}</text><text x="0" y="${y(1) + 5}" class="axis">${MOODS[0]}</text>
    <path d="${area}" fill="url(#mf)"/><path d="${d}" fill="none" stroke="url(#mg)" stroke-width="3" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
  </svg>`;
}
function renderTags() {
  const counts = {};
  entries.forEach((e) => { const m = metaOf(e); (m && m.tags || []).forEach((t) => { counts[t] = (counts[t] || 0) + 1; }); });
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 14);
  $('#tagCloud').innerHTML = top.length ? top.map(([t, n]) => `<span class="chip">${esc(t)}<b>${n}</b></span>`).join('') : '<span class="muted">Topics show up after a few entries.</span>';
}
function renderJournal() {
  const q = $('#searchBox').value.trim().toLowerCase();
  const list = entries.filter((e) => {
    if (!q) return true;
    const m = metaOf(e);
    return titleOf(e).toLowerCase().includes(q) || (m && m.tags.some((t) => t.includes(q))) || e.day.includes(q);
  });
  if (!list.length) { $('#allList').innerHTML = `<li class="empty">${q ? 'Nothing matches' : 'No entries yet'}</li>`; return; }
  let html = ''; let month = '';
  for (const e of list) {
    const mo = e.date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    if (mo !== month) { html += `<li class="month">${esc(mo)}</li>`; month = mo; }
    html += itemHTML(e);
  }
  $('#allList').innerHTML = html;
}
async function renderPending() {
  let list = [];
  try { list = await allPending(); } catch {}
  $('#pendingWrap').hidden = !list.length;
  $('#pendingList').innerHTML = list.map((r) => {
    const d = new Date(r.createdAt);
    const what = r.source === 'typed' ? 'Draft' : r.stage === 'recording' ? 'Recording was interrupted' : r.error ? r.error : r.cleaned ? 'Ready to save' : 'Needs processing';
    return `<li><button class="item" data-review="${esc(r.id)}"><span class="face">${r.audio ? '\u{1F399}' : r.source === 'typed' ? '\u270F\uFE0F' : '\u{1F4C4}'}</span><span class="body">
      <span class="t">${esc(r.title || (r.source === 'typed' ? defaultTitle(r.text) : 'Untitled recording'))}</span>
      <span class="d">${fmtDate(d)}, ${fmtTime(d)}${r.duration ? ' · ' + fmtDur(r.duration) : ''}</span>
      <span class="${r.error ? 'err' : 'd'}">${esc(what)}</span></span></button></li>`;
  }).join('');
}

/* ---------- loading from GitHub ---------- */
async function loadAll() {
  if (!configured() || loading) { renderDashboard(); return; }
  loading = true; $('#refreshBtn').style.opacity = '.4';
  try {
    let tree = [];
    try { tree = (await gh(`/git/trees/${encodeURIComponent(cfg('branch'))}?recursive=1`)).tree || []; }
    catch (e) { if (e.status !== 409 && e.status !== 404) throw e; }
    entries = [];
    for (const t of tree) {
      if (t.type !== 'blob') continue;
      const m = t.path.match(ENTRY_RE);
      if (!m) continue;
      const date = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
      entries.push({ path: t.path, sha: t.sha, date, day: dayKey(date), slug: m[7] || '' });
    }
    entries.sort((a, b) => b.date - a.date);
    renderDashboard(); renderJournal();
    const [v] = await Promise.all([getFile(VOCAB_PATH), loadHabits()]);
    if (v) { vocab = v; if (document.activeElement !== $('#vocabText')) $('#vocabText').value = v.text; }
    renderHabits(); renderTodayHabits();
    const missing = entries.filter((e) => !vault.meta[e.sha]).slice(0, 80);
    let n = 0;
    await pool(missing, 5, async (e) => {
      vault.meta[e.sha] = metaFrom(await getBlob(e.sha));
      if (++n % 10 === 0) { renderDashboard(); renderJournal(); }
    });
    if (missing.length) { saveVaultSoon(); renderDashboard(); renderJournal(); }
  } catch (e) {
    toast(e.message, 5000);
  } finally {
    loading = false; $('#refreshBtn').style.opacity = '';
  }
}

/* ---------- views ---------- */
const TITLES = { home: 'Today', journal: 'Journal', read: '', edit: 'Edit entry', review: 'New entry', import: 'Import', habits: 'Habits', more: 'More' };
const TAB_OF = { home: 'home', journal: 'journal', read: 'journal', edit: 'journal', import: 'journal', review: 'home', habits: 'habits', more: 'more' };
async function route() {
  if (!Vault.unlocked()) return;
  const [name, ...rest] = (location.hash.slice(1) || 'home').split('/');
  const view = TITLES[name] !== undefined ? name : 'home';
  const arg = decodeURIComponent(rest.join('/'));
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== `view-${view}`; });
  document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === TAB_OF[view]));
  $('#viewTitle').textContent = TITLES[view];
  $('#backBtn').hidden = !['read', 'edit', 'review', 'import'].includes(view);
  window.scrollTo(0, 0);
  if (view === 'home') { renderDashboard(); renderPending(); }
  if (view === 'journal') renderJournal();
  if (view === 'habits') renderHabits();
  if (view === 'read') openEntry(arg);
  if (view === 'edit') openEdit(arg);
  if (view === 'review') openReview(arg);
  if (view === 'import' && !$('#impDate').value) $('#impDate').value = localISO(new Date()).slice(0, 16);
}

async function openEntry(path) {
  const e = entries.find((x) => x.path === path);
  const box = $('#readBody');
  box.innerHTML = '<p class="muted">Loading...</p>';
  try {
    const md = e ? await getBlob(e.sha) : (await getFile(path)).text;
    const p = parseEntry(md);
    const date = e ? e.date : new Date(p.fm.date || Date.now());
    const mood = Number(p.fm.mood);
    const tags = Array.isArray(p.fm.tags) ? p.fm.tags : [];
    $('#viewTitle').textContent = '';
    box.innerHTML = `<h1>${esc(p.title || 'Untitled')}</h1>
      <div class="meta">${mood >= 1 && mood <= 5 ? `<span>${MOODS[Math.round(mood) - 1]}</span>` : ''}
        <span>${fmtDate(date)}, ${fmtTime(date)}</span>${p.fm.duration ? `<span>· ${esc(p.fm.duration)}</span>` : ''}
        ${tags.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}
        <a class="chip edit-link" href="#edit/${encodeURIComponent(path)}">Edit</a></div>
      ${renderMd(p.body)}
      ${p.raw ? `<details class="raw"><summary>Original text</summary><p>${esc(p.raw)}</p></details>` : ''}`;
  } catch (err) { box.innerHTML = `<p class="status error">${esc(err.message)}</p>`; }
}

function inlineMd(t) {
  return t
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/==([^=]+)==/g, '<mark>$1</mark>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}
function renderMd(md) {
  const out = []; let list = null; let para = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inlineMd).join('<br>')}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.join('')}</${list.tag}>`); list = null; } };
  for (const line of esc(md).split('\n')) {
    let m;
    if (!line.trim()) { flushPara(); flushList(); continue; }
    if ((m = line.match(/^#{1,6}\s+(.*)/))) { flushPara(); flushList(); out.push(`<h3>${inlineMd(m[1])}</h3>`); continue; }
    if ((m = line.match(/^&gt;\s?(.*)/))) { flushPara(); flushList(); out.push(`<blockquote>${inlineMd(m[1])}</blockquote>`); continue; }
    if ((m = line.match(/^\s*([-*+]|\d+[.)])\s+(.*)/))) {
      flushPara();
      const tag = /\d/.test(m[1]) ? 'ol' : 'ul';
      if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
      const task = m[2].match(/^\[([ xX])\]\s+(.*)/);
      list.items.push(task ? `<li class="task">${task[1] === ' ' ? '\u2610' : '\u2611'} ${inlineMd(task[2])}</li>` : `<li>${inlineMd(m[2])}</li>`);
      continue;
    }
    flushList(); para.push(line);
  }
  flushPara(); flushList();
  return out.join('');
}

let editState = { path: null, sha: null, md: '', mood: null };
async function openEdit(path) {
  const st = $('#editStatus'); st.textContent = 'Loading...'; st.classList.remove('error');
  $('#saveEditBtn').disabled = true;
  try {
    const e = entries.find((x) => x.path === path);
    const f = e ? { text: await getBlob(e.sha), sha: e.sha } : await getFile(path);
    if (!f) throw new Error('This entry no longer exists.');
    const p = parseEntry(f.text);
    const mood = Math.round(Number(p.fm.mood));
    editState = { path, sha: f.sha, md: f.text, mood: mood >= 1 && mood <= 5 ? mood : null };
    $('#editTitle').value = p.title || '';
    $('#editText').value = p.body;
    $('#editTags').value = (Array.isArray(p.fm.tags) ? p.fm.tags : []).join(', ');
    $('#editMood').innerHTML = moodButtons(editState.mood, 'edit');
    st.textContent = '';
    $('#saveEditBtn').disabled = false;
  } catch (err) { st.textContent = err.message; st.classList.add('error'); }
}
function rebuildEntry(md, { title, text, mood, tags }) {
  const p = parseEntry(md);
  const lines = ['---', `date: ${p.fm.date || localISO(new Date())}`, `title: ${JSON.stringify(title)}`];
  if (mood) lines.push(`mood: ${mood}`);
  if (tags.length) lines.push(`tags: ${JSON.stringify(tags)}`);
  const rest = { ...p.fm, words: text.split(/\s+/).filter(Boolean).length };
  for (const [k, v] of Object.entries(rest)) {
    if (['date', 'title', 'mood', 'tags'].includes(k)) continue;
    lines.push(`${k}: ${typeof v === 'string' && /^[\w.-]+$/.test(v) ? v : JSON.stringify(v)}`);
  }
  lines.push('---', '', `# ${title}`, '', text.trim(), '');
  if (p.raw && p.raw.trim() !== text.trim()) lines.push('<details>', '<summary>Raw transcript</summary>', '', p.raw.trim(), '', '</details>', '');
  return lines.join('\n');
}
async function saveEdit() {
  const st = $('#editStatus'); const btn = $('#saveEditBtn');
  const text = $('#editText').value;
  if (!text.trim()) { st.textContent = 'The entry is empty. Use Delete entry if you want to remove it.'; st.classList.add('error'); return; }
  btn.disabled = true; st.classList.remove('error'); st.textContent = 'Saving...';
  try {
    const title = $('#editTitle').value.trim() || defaultTitle(text);
    const tags = $('#editTags').value.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
    const md = rebuildEntry(editState.md, { title, text, mood: editState.mood, tags });
    const sha = await putFile(editState.path, md, 'Edit journal entry', editState.sha);
    vault.meta[sha] = metaFrom(md); saveVaultSoon();
    const e = entries.find((x) => x.path === editState.path); if (e) e.sha = sha;
    toast('Changes saved');
    location.replace(`#read/${encodeURIComponent(editState.path)}`);
  } catch (err) {
    st.textContent = err.status === 409 ? 'This entry was changed somewhere else. Go back, tap refresh, and edit again.' : err.message;
    st.classList.add('error');
  } finally { btn.disabled = false; }
}
async function deleteEntry() {
  if (!confirm('Delete this entry for good? This cannot be undone from the app.')) return;
  const st = $('#editStatus'); st.textContent = 'Deleting...'; st.classList.remove('error');
  try {
    await gh(`/contents/${encPath(editState.path)}`, { method: 'DELETE', body: JSON.stringify({ message: 'Delete journal entry', sha: editState.sha, branch: cfg('branch') }) });
    entries = entries.filter((x) => x.path !== editState.path);
    toast('Entry deleted');
    location.replace('#journal');
  } catch (err) { st.textContent = err.message; st.classList.add('error'); }
}

let reviewId = null; let reviewMood = null; let draftTimer = null;
function moodButtons(val, scope) {
  return MOODS.map((m, i) => `<button type="button" role="radio" aria-checked="${val === i + 1}" class="${val === i + 1 ? 'on' : ''}" data-mood="${i + 1}" data-scope="${scope}">${m}</button>`).join('');
}
function renderMoodPick() { $('#moodPick').innerHTML = moodButtons(reviewMood, 'review'); }
function fillReview(r) {
  $('#reviewTitle').value = r.title || '';
  $('#reviewText').value = r.text || r.raw || '';
  $('#reviewTags').value = (r.tags || []).join(', ');
  $('#reviewRaw').textContent = r.raw || '(not transcribed yet)';
  $('#reviewRawWrap').hidden = r.source === 'typed' && !r.raw;
  $('#recleanBtn').textContent = r.source === 'typed' ? 'Tidy up' : 'Re-clean';
  reviewMood = r.mood || null; renderMoodPick();
  const raw = (r.raw || '').length; const txt = (r.text || '').length;
  if (r.note) setReviewStatus(r.note);
  if (r.cleaned && raw > 200 && txt < raw * 0.55) setReviewStatus('Heads up: the cleanup came out a lot shorter than what you said. Compare it with the raw transcript below.', true);
}
async function openReview(id) {
  reviewId = id; setReviewStatus(''); $('#retryBtn').hidden = true;
  let r = await getPending(id);
  if (!r) { setReviewStatus('This entry was already saved or discarded.'); return; }
  fillReview(r);
  if (r.stage === 'recording') { r.stage = 'recorded'; await putPending(r); }
  if (r.source === 'typed' && r.cleaned) {
    $('#viewTitle').textContent = 'Write';
    setReviewStatus('Write whatever you want. Drafts save on this device as you type. A title, tags and mood are picked for you when you save (anything you fill in yourself is kept). "Tidy up" also fixes typos.');
    if (!r.text) setTimeout(() => $('#reviewText').focus(), 50);
    return;
  }
  if (!r.cleaned || !r.raw && r.audio) {
    $('#saveEntryBtn').disabled = true;
    try { r = await processRecord(id); if (reviewId === id) { fillReview(r); if (!r.note && !$('#reviewStatus').classList.contains('error')) setReviewStatus('Check it over, then save.'); } }
    catch (e) { if (reviewId === id) { setReviewStatus(e.message, true); $('#retryBtn').hidden = false; } }
    finally { $('#saveEntryBtn').disabled = false; }
  } else if (!$('#reviewStatus').textContent) setReviewStatus('Check it over, then save.');
}
async function reviewFormToRecord() {
  const r = await getPending(reviewId);
  if (!r) throw new Error('This entry is gone.');
  r.title = $('#reviewTitle').value.trim();
  r.text = $('#reviewText').value;
  r.tags = $('#reviewTags').value.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
  r.mood = reviewMood;
  return r;
}

/* ---------- import ---------- */
function dateFromName(name, fallback) {
  const m = name.match(/(\d{4})[-_.](\d{2})[-_.](\d{2})(?:[ T_-]?(\d{2})[.:-]?(\d{2})(?:[.:-]?(\d{2}))?)?/);
  if (m) { const d = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 12), +(m[5] || 0), +(m[6] || 0)); if (!isNaN(d)) return d; }
  return new Date(fallback || Date.now());
}
const isAudio = (f) => /^audio\//.test(f.type) || /\.(m4a|mp3|wav|aac|ogg|webm|mp4|flac)$/i.test(f.name);
function logImport(text, cls = '') {
  const li = document.createElement('li'); li.className = `log-item ${cls}`; li.textContent = text;
  $('#impLog').prepend(li); return li;
}
async function importFiles(files) {
  if (!configured()) { toast('Finish setup in More first'); return; }
  const cleanText = $('#impFilesClean').checked;
  for (const f of files) {
    const line = logImport(`${f.name}: working...`);
    try {
      const date = dateFromName(f.name, f.lastModified);
      const r = { id: newId(), createdAt: localISO(date), fileName: f.name };
      if (isAudio(f)) { r.source = 'import-audio'; r.audio = f.slice(0, f.size, f.type || 'audio/mp4'); }
      else {
        r.source = 'import-text';
        r.raw = (await f.text()).replace(/^---\n[\s\S]*?\n---\n/, '').trim();
        if (!cleanText) Object.assign(r, { text: r.raw, title: defaultTitle(r.raw), cleaned: true, mood: null, tags: [] });
      }
      await putPending(r);
      const done = await processRecord(r.id);
      await saveRecordAsEntry(done);
      line.textContent = `✓ ${f.name} saved as "${done.title}" (${fmtDate(date)})`;
    } catch (e) {
      line.textContent = `✗ ${f.name}: ${e.message}. It is waiting under "Not saved yet" on Today.`;
      line.classList.add('danger');
    }
  }
  renderDashboard(); renderPending();
}

/* ---------- Obsidian import ---------- */
function parseYamlLite(src) {
  const out = {}; let key = null;
  for (const line of src.split('\n')) {
    let m;
    if ((m = line.match(/^\s+-\s*(.*)$/)) && key) { (out[key] = Array.isArray(out[key]) ? out[key] : []).push(m[1].replace(/^["']|["']$/g, '')); continue; }
    if ((m = line.match(/^([^:#\s][^:]*):\s*(.*)$/))) {
      key = m[1].trim().toLowerCase(); let v = m[2].trim();
      if (/^\[.*\]$/.test(v)) v = v.slice(1, -1).split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
      else v = v.replace(/^["']|["']$/g, '');
      out[key] = v === '' ? [] : v;
    }
  }
  return out;
}
function dateFromText(str) {
  const m = String(str || '').match(/(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 12), +(m[5] || 0), +(m[6] || 0));
  return isNaN(d) ? null : d;
}
function parseObsidian(text, file) {
  let body = text.replace(/\r\n/g, '\n'); let fm = {};
  const m = body.match(/^---\n([\s\S]*?)\n---\n?/);
  if (m) { fm = parseYamlLite(m[1]); body = body.slice(m[0].length); }
  const rel = file.webkitRelativePath || file.name;
  const base = file.name.replace(/\.(md|markdown|txt)$/i, '');
  const fmDate = ['date', 'created', 'date created', 'created_at', 'creation date', 'day'].map((k) => fm[k]).find((v) => v && !Array.isArray(v));
  const date = dateFromText(fmDate) || dateFromText(base) || dateFromText(rel) || new Date(file.lastModified || Date.now());
  let tags = [].concat(fm.tags || fm.tag || []).flatMap((t) => String(t).split(/[,\s]+/));
  body.replace(/(^|\s)#([A-Za-z][\w/-]*)/g, (_, a, t) => { tags.push(t); return _; });
  tags = [...new Set(tags.map((t) => t.replace(/^#/, '').toLowerCase().trim()).filter(Boolean))].slice(0, 6);
  body = body
    .replace(/!\[\[([^\]]+)\]\]/g, (_, f) => `(attachment: ${f.split('|')[0]})`)
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]|#]+)(?:#[^\]]*)?\]\]/g, '$1')
    .replace(/%%[\s\S]*?%%/g, '')
    .trim();
  const dateLike = /^\d{4}-\d{2}-\d{2}/.test(base) || /^untitled/i.test(base);
  let title = fm.title && !Array.isArray(fm.title) ? fm.title : (dateLike ? '' : base);
  if (!title) { const h = body.match(/^#{1,3}\s+(.+)$/m); title = h ? h[1].trim() : defaultTitle(body.replace(/[#>*_`-]/g, ' ')); }
  const top = body.match(/^#\s+(.+)\n*/);
  if (top && top[1].trim().toLowerCase() === String(title).trim().toLowerCase()) body = body.slice(top[0].length).trim();
  return { date, title, tags, text: body, dateLike: !fm.title && dateLike };
}
const SKIP_DIR = /(^|\/)(\.[^/]*|templates?|_templates?|attachments?)\//i;
async function importObsidian(files) {
  if (!configured()) { toast('Finish setup in More first'); return; }
  const st = $('#obsStatus'); const log = $('#obsLog'); log.innerHTML = '';
  const notes = files.filter((f) => /\.(md|markdown|txt)$/i.test(f.name) && !SKIP_DIR.test(f.webkitRelativePath || ''));
  if (!notes.length) { st.textContent = 'No notes found. Pick .md files or your vault folder.'; return; }
  const useAI = $('#obsAI').checked && cfg('cleanup') !== 'none';
  const existing = new Set(entries.map((e) => e.path));
  const ready = []; let skipped = 0; let failed = 0;
  for (let i = 0; i < notes.length; i++) {
    const f = notes[i];
    st.textContent = `Reading ${i + 1} of ${notes.length}...`;
    try {
      const n = parseObsidian(await f.text(), f);
      if (!n.text.trim()) { skipped++; continue; }
      let mood = null;
      if (useAI) {
        st.textContent = `Adding mood and tags ${i + 1} of ${notes.length}...`;
        try {
          const c = await cleanup(n.text, true);
          mood = c.mood; n.tags = [...new Set([...n.tags, ...c.tags])].slice(0, 6);
          if (n.dateLike && c.title) n.title = c.title;
        } catch (e) { log.insertAdjacentHTML('beforeend', `<li class="log-item">${esc(f.name)}: imported without mood (${esc(e.message)})</li>`); }
      }
      const path = entryPath(n.date, n.title);
      if (existing.has(path)) { skipped++; continue; }
      existing.add(path);
      ready.push({ path, text: buildEntry({ date: n.date, title: n.title, text: n.text, raw: '', mood, tags: n.tags, source: 'obsidian' }) });
    } catch (e) { failed++; log.insertAdjacentHTML('beforeend', `<li class="log-item danger">\u2717 ${esc(f.name)}: ${esc(e.message)}</li>`); }
  }
  try {
    for (let i = 0; i < ready.length; i += 100) {
      st.textContent = `Saving ${Math.min(i + 100, ready.length)} of ${ready.length} to GitHub...`;
      await commitFiles(ready.slice(i, i + 100), `Import ${ready.slice(i, i + 100).length} notes from Obsidian`);
    }
    st.textContent = `Imported ${ready.length} note${ready.length === 1 ? '' : 's'}.${skipped ? ` Skipped ${skipped} (empty or already imported).` : ''}${failed ? ` ${failed} failed.` : ''}`;
    st.classList.remove('error');
    loadAll();
  } catch (e) { st.textContent = `Saving failed: ${e.message}`; st.classList.add('error'); }
}

/* ---------- settings ---------- */
function fillSettings() {
  for (const k of SETTING_KEYS) { const el = $(`#set-${k}`); if (el) el.value = vault.settings[k] || (el.tagName === 'SELECT' ? DEF[k] : ''); }
}
async function saveSettings() {
  for (const k of SETTING_KEYS) { const el = $(`#set-${k}`); if (el) vault.settings[k] = el.value.trim(); }
  vault.settings.repo = (vault.settings.repo || '').replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');
  $(`#set-repo`).value = vault.settings.repo;
  await Vault.save(vault);
}
async function testConnection() {
  const out = []; const st = $('#settingsStatus'); st.classList.remove('error'); st.textContent = 'Testing...';
  let bad = false;
  try {
    if (!/^[\w.-]+\/[\w.-]+$/.test(cfg('repo'))) throw new Error('type your repo as owner/name, for example yoaa2245-sys/fictional-dollop');
    if (!cfg('ghToken')) throw new Error('paste your GitHub token');
    const r = await gh(`https://api.github.com/repos/${cfg('repo')}`);
    out.push(r.permissions && r.permissions.push ? `GitHub: OK (${r.private ? 'private' : 'PUBLIC, your journals would be visible!'})` : 'GitHub: token can read but not write. Give it Contents: Read and write.');
    if (!r.private || !(r.permissions && r.permissions.push)) bad = true;
  } catch (e) { out.push(`GitHub: ${e.message}`); bad = true; }
  try {
    const res = await fetch('https://api.groq.com/openai/v1/models', { headers: { Authorization: `Bearer ${cfg('groqKey')}` } });
    if (!res.ok) throw new Error(await errText(res));
    const ids = ((await res.json()).data || []).map((m) => m.id);
    const miss = [cfg('sttModel'), cfg('cleanup') === 'groq' ? cfg('groqChatModel') : null].filter((m) => m && !ids.includes(m));
    out.push(miss.length ? `Groq: key works, but no model named ${miss.join(', ')}. Available: ${ids.filter((i) => !/guard|tts/.test(i)).slice(0, 12).join(', ')}` : 'Groq: OK');
    if (miss.length) bad = true;
  } catch (e) { out.push(`Groq: ${e.message}`); bad = true; }
  st.textContent = out.join('  ·  '); st.classList.toggle('error', bad);
}

/* ---------- lock screen ---------- */
let lockMode = 'unlock'; let setupPayload = null; let hiddenAt = 0;
function showLock() {
  const isCreate = lockMode === 'create';
  $('#lock').hidden = false;
  $('#lockTitle').textContent = isCreate ? 'Pick a password' : 'Journal';
  $('#lockHint').textContent = isCreate ? 'You will type this each time you open the app. It encrypts your keys on this device.'
    : lockMode === 'import' ? 'Type the password you use on your other device' : 'Enter your password';
  $('#lockPw2').hidden = !isCreate; $('#lockPw2').required = isCreate;
  $('#lockPw').autocomplete = isCreate ? 'new-password' : 'current-password';
  $('#lockSubmit').textContent = isCreate ? 'Create' : 'Unlock';
  $('#forgotBtn').hidden = lockMode !== 'unlock';
  $('#pasteSetup').hidden = lockMode !== 'create';
  setTimeout(() => $('#lockPw').focus(), 50);
}
async function onLockSubmit(ev) {
  ev.preventDefault();
  const pw = $('#lockPw').value; const err = $('#lockErr'); err.textContent = '';
  $('#lockSubmit').disabled = true;
  try {
    if (lockMode === 'create') {
      if (pw.length < 4) throw new Error('Use at least 4 characters');
      if (pw !== $('#lockPw2').value) throw new Error('The two passwords do not match');
      await Vault.create(pw, vault);
    } else if (lockMode === 'import') {
      const data = await Vault.importLink(pw, setupPayload);
      vault = { settings: data.settings || {}, meta: {} };
      await Vault.create(pw, vault);
      history.replaceState(null, '', location.pathname + '#home');
      setTimeout(() => toast('This device is set up'), 300);
    } else {
      const data = await Vault.unlock(pw);
      vault = { settings: data.settings || {}, meta: data.meta || {} };
    }
    $('#lockPw').value = ''; $('#lockPw2').value = '';
    $('#lock').hidden = true;
    startApp();
  } catch (e) {
    err.textContent = e.message;
  } finally { $('#lockSubmit').disabled = false; }
}
function lockNow() {
  if (rec) return;
  Vault.lock();
  location.hash = '#home';
  location.reload();
}

/* ---------- start ---------- */
let started = false;
function startApp() {
  fillSettings();
  drawIdle(); updateRecUI();
  if (!started) { started = true; window.addEventListener('hashchange', route); }
  route();
  loadAll();
}

function wire() {
  $('#lockForm').addEventListener('submit', onLockSubmit);
  $('#forgotBtn').addEventListener('click', async () => {
    if (!confirm('Reset this device? Your keys and any unsaved recordings on this device are erased. Saved journal entries stay safe in GitHub.')) return;
    Vault.wipe(); try { await IDB.clear(); } catch {}
    location.reload();
  });
  $('#lockBtn').addEventListener('click', lockNow);
  $('#useSetupBtn').addEventListener('click', () => {
    const m = $('#setupLinkInput').value.trim().match(/setup=([\w-]+)/);
    if (!m) { $('#lockErr').textContent = 'That does not look like a setup link'; return; }
    setupPayload = m[1]; lockMode = 'import'; $('#lockErr').textContent = ''; showLock();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) hiddenAt = Date.now();
    else if (Vault.unlocked() && hiddenAt && Date.now() - hiddenAt > AUTO_LOCK_MS) lockNow();
  });

  $('#recBtn').addEventListener('click', () => (rec ? stopRec() : startRec()));
  $('#pauseBtn').addEventListener('click', togglePause);
  $('#cancelBtn').addEventListener('click', cancelRec);
  $('#refreshBtn').addEventListener('click', () => { loadAll(); renderPending(); });
  $('#backBtn').addEventListener('click', () => { if (history.length > 1) history.back(); else location.hash = '#home'; });

  document.body.addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-open],[data-review],[data-habit],[data-del-habit],[data-mood]');
    if (!t) return;
    if (t.dataset.open) location.hash = `#read/${encodeURIComponent(t.dataset.open)}`;
    if (t.dataset.review) location.hash = `#review/${t.dataset.review}`;
    if (t.dataset.habit) {
      const day = dayKey(new Date()); const on = !(habits.data.log[day] || []).includes(t.dataset.habit);
      habitOp({ t: 'set', day, id: t.dataset.habit, on });
    }
    if (t.dataset.delHabit) {
      const h = habits.data.habits.find((x) => x.id === t.dataset.delHabit);
      if (h && confirm(`Delete "${h.name}"? Its history is removed from the list.`)) habitOp({ t: 'del', id: h.id });
    }
    if (t.dataset.mood) {
      const m = +t.dataset.mood;
      if (t.dataset.scope === 'edit') { editState.mood = editState.mood === m ? null : m; $('#editMood').innerHTML = moodButtons(editState.mood, 'edit'); }
      else { reviewMood = reviewMood === m ? null : m; renderMoodPick(); }
    }
  });

  $('#addHabitForm').addEventListener('submit', (ev) => {
    ev.preventDefault();
    if (!configured()) { toast('Finish setup in More first'); return; }
    const name = $('#habitName').value.trim(); if (!name) return;
    habitOp({ t: 'add', habit: { id: newId(), name, emoji: $('#habitEmoji').value.trim() || '✨', created: dayKey(new Date()) } });
    $('#habitName').value = ''; $('#habitEmoji').value = '';
  });

  $('#saveEntryBtn').addEventListener('click', async () => {
    const btn = $('#saveEntryBtn'); btn.disabled = true; setReviewStatus('Saving...'); clearTimeout(draftTimer);
    try {
      const r = await reviewFormToRecord();
      if (r.source === 'typed' && (r.text || '').trim() && cfg('cleanup') !== 'none' && (!r.title || !(r.tags || []).length || !r.mood)) {
        setReviewStatus('Picking a title and tags...');
        try {
          const m = await autoMeta(r.text);
          if (!r.title) r.title = m.title;
          if (!(r.tags || []).length) r.tags = m.tags;
          if (!r.mood) r.mood = m.mood;
        } catch { /* save anyway; the title falls back to the first few words */ }
      }
      await putPending(r);
      await saveRecordAsEntry(r);
      toast('Saved to your journal'); reviewId = null; location.hash = '#home';
    } catch (e) { setReviewStatus(e.message, true); }
    finally { btn.disabled = false; }
  });
  $('#recleanBtn').addEventListener('click', async () => {
    let r = await getPending(reviewId); if (!r) return;
    if (r.source === 'typed') {
      r = await reviewFormToRecord();
      if (!r.text.trim()) { toast('Write something first'); return; }
      r.raw = r.text;
    }
    if (!r.raw) return;
    r.cleaned = false; await putPending(r); openReview(reviewId);
  });
  const saveDraftSoon = () => {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(async () => { if (!reviewId) return; try { await putPending(await reviewFormToRecord()); } catch {} }, 700);
  };
  ['#reviewText', '#reviewTitle', '#reviewTags'].forEach((sel) => $(sel).addEventListener('input', saveDraftSoon));
  $('#writeBtn').addEventListener('click', async () => {
    if (!configured()) { toast('Finish setup in More first'); location.hash = '#more'; return; }
    const r = { id: newId(), createdAt: localISO(new Date()), source: 'typed', raw: '', text: '', title: '', tags: [], mood: null, cleaned: true };
    await putPending(r);
    location.hash = `#review/${r.id}`;
  });
  $('#retryBtn').addEventListener('click', () => openReview(reviewId));
  $('#discardBtn').addEventListener('click', async () => {
    if (!confirm('Discard this entry? It is deleted from this device.')) return;
    clearTimeout(draftTimer);
    await IDB.del(reviewId); reviewId = null; location.hash = '#home';
  });

  $('#searchBox').addEventListener('input', renderJournal);
  $('#saveEditBtn').addEventListener('click', saveEdit);
  $('#cancelEditBtn').addEventListener('click', () => history.back());
  $('#deleteEntryBtn').addEventListener('click', deleteEntry);
  $('#impPasteBtn').addEventListener('click', async () => {
    if (!configured()) { toast('Finish setup in More first'); return; }
    const text = $('#impText').value.trim(); if (!text) { toast('Paste some text first'); return; }
    const date = $('#impDate').value ? new Date($('#impDate').value) : new Date();
    const r = { id: newId(), createdAt: localISO(date), source: 'import-text', raw: text };
    if (!$('#impClean').checked) Object.assign(r, { text, title: defaultTitle(text), cleaned: true, mood: null, tags: [] });
    await putPending(r);
    $('#impText').value = '';
    location.hash = `#review/${r.id}`;
  });
  ['#obsFolder', '#obsFiles'].forEach((sel) => $(sel).addEventListener('change', (ev) => { const files = [...ev.target.files]; ev.target.value = ''; importObsidian(files); }));
  $('#impFiles').addEventListener('change', (ev) => { const files = [...ev.target.files]; ev.target.value = ''; importFiles(files); });

  $('#saveVocabBtn').addEventListener('click', async () => {
    const st = $('#vocabStatus'); st.classList.remove('error'); st.textContent = 'Saving...';
    try {
      const text = $('#vocabText').value.split('\n').map((s) => s.trim()).filter(Boolean).join('\n') + '\n';
      const fresh = await getFile(VOCAB_PATH);
      vocab = { text, sha: await putFile(VOCAB_PATH, text, 'Update vocabulary', fresh && fresh.sha) };
      st.textContent = `Saved ${vocabList().length} words.`;
    } catch (e) { st.textContent = e.message; st.classList.add('error'); }
  });
  $('#saveSettingsBtn').addEventListener('click', async () => {
    await saveSettings(); $('#settingsStatus').textContent = 'Saved.'; $('#settingsStatus').classList.remove('error');
    entries = []; loadAll();
  });
  $('#testBtn').addEventListener('click', async () => { await saveSettings(); testConnection(); });
  $('#shareSetupBtn').addEventListener('click', async () => {
    await saveSettings();
    const url = `${location.origin}${location.pathname}#setup=${await Vault.exportLink({ settings: vault.settings })}`;
    try { await navigator.clipboard.writeText(url); toast('Setup link copied. It only works with your password.'); }
    catch { prompt('Copy this setup link:', url); }
  });
  $('#changePwBtn').addEventListener('click', async () => {
    const pw = $('#newPw').value;
    if (pw.length < 4) { toast('Use at least 4 characters'); return; }
    const pending = await allPending();
    await Vault.rekey(pw, vault);
    for (const r of pending) await putPending(r);
    $('#newPw').value = ''; toast('Password changed');
  });
}

function boot() {
  wire();
  if (!Vault.supported()) { $('#lockHint').textContent = 'Open this page over https (GitHub Pages) so encryption works.'; $('#lockForm').querySelectorAll('input,button').forEach((e) => { e.disabled = true; }); return; }
  const m = location.hash.match(/^#setup=([\w-]+)/);
  if (m) { setupPayload = m[1]; lockMode = 'import'; }
  else lockMode = Vault.exists() ? 'unlock' : 'create';
  showLock();
}
boot();
