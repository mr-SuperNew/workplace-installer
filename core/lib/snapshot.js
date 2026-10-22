'use strict';
// Снимок файлов вне главной папки до и после установки и классификация записей на три класса (К19, К20).
// Заменяет «жандарма» v3 (global check: любая строка вне корня = СТОП). Теперь установка программ есть, поэтому записи делятся так:
//   A  тревога: запись, которую никто не объявлял (профили оболочки, ~/.claude/settings.json, ~/.codex/config.toml и т.п.), VS Code с подозрительными ключами
//   B  штатно: журналы, кэш, файл входа и отметки самих программ (~/.codex/auth.json меняется при каждом использовании Codex, ~/.claude/projects, ~/.claude.json, ~/.npm)
//   C  вопрос «это вы меняли?»: настройки VS Code, которые он пишет сам (Trust, перезапуск); по названиям ключей, значения не печатаются
//   D  объявлено: запись официального установщика, о которой человеку сказали заранее (PATH в профиле, ~/.local/bin)
// Объявление: пути вида ~/файл (весь файл) или ~/файл#ключ (один ключ верхнего уровня файла настроек VS Code; значения не сверяются, только название ключа).
// Секретные по природе файлы (auth.json, .npmrc, .netrc, ...) копируются НЕ ВСЕ: только хеш и размер. Значения нигде не печатаются.
const fs = require('fs');
const path = require('path');
const u = require('./util');
const rootLib = require('./root');
const secrets = require('./secrets-scan');

const CLAUDE_LOG_CACHE = [/^projects$/, /^sessions$/, /^session-env$/, /^shell-snapshots$/, /^todos$/, /^tasks$/, /^file-history$/, /^statsig$/, /^telemetry$/, /^ide$/, /^plans$/,
  /^cache$/, /^debug$/, /^logs?$/, /^history\.jsonl$/, /^backups$/, /^paste-cache$/, /^image-cache$/, /^downloads$/, /^stats-cache\.json$/, /^\.?tmp$/, /^\.credentials\.json$/, /^cockpit$/, /^usage-data$/];
const CODEX_LOG_CACHE = [/^sessions$/, /^archived_sessions$/, /^log$/, /^logs$/, /^cache$/, /^\.?tmp$/, /^shell_snapshots$/, /^session-handoff-state$/, /^memories$/, /^history\.jsonl$/,
  /^version\.json$/, /^installation_id$/, /^models_cache\.json$/, /\.sqlite(-wal|-shm)?$/, /^skills$/, /^plugins$/, /^packages$/, /^auth\.json$/];
const ALLOWED_INSIDE = { skills: ['.system'], plugins: ['cache'] };

// ~/.codex/config.toml: Codex сам записывает в него доверие папкам ([projects.'путь'] trust_level) и хукам ([hooks.state.'путь'] trusted_hash), когда человек подтверждает папку
// и вводит /hooks (основной Codex, разовый шаг). Это не тревога, а вопрос «это вы подтверждали?» (класс C). Остальные разделы и ключи по-прежнему тревога (класс A).
// Проверено по настоящему файлу на машине разработчика (разделы projects.* и hooks.state.*); TODO: verify на обкатке основного Codex, что других записей в config.toml при подтверждении нет.
const TOML_TRUST = /^(projects|hooks\.state)\./;
// Ключи, которые Codex пишет внутри этих разделов (сверено по настоящему файлу: projects.* это trust_level, hooks.state.* это trusted_hash). Другой ключ внутри доверия это тревога A,
// а не вопрос C (N7 этапа Ж): неизвестный ключ нельзя прятать за ожидаемыми. Значения не показываются, только имена ключей.
const TOML_TRUST_KEYS = { projects: ['trust_level'], 'hooks.state': ['trusted_hash'] };
function trustKind(sec) { return /^projects\./.test(sec) ? 'projects' : 'hooks.state'; }
function tomlSections(text, keysOut) {
  const out = {};
  let cur = '', body = [];
  const flush = () => { out[cur] = u.sha256(body.join('\n')).slice(0, 12); if (keysOut && TOML_TRUST.test(cur)) keysOut[cur] = [...new Set(body.map((l) => (/^\s*([A-Za-z0-9_."'-]+)\s*=/.exec(l) || [])[1]).filter(Boolean))].sort(); body = []; };
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^\[\[?\s*(.+?)\s*\]\]?$/.exec(line);
    if (m && !/=/.test(line.replace(/'[^']*'|"[^"]*"/g, ''))) { flush(); cur = m[1]; continue; }
    body.push(line);
  }
  flush();
  return out;
}

const VSCODE_USER_FILE = /(^|\/)Code\/User\/settings\.json$/;
const VSCODE_KEYBINDINGS = /(^|\/)Code\/User\/keybindings\.json$/;
const VSCODE_SUSPICIOUS_KEY = /claude|anthropic|codex|chatgpt|openai|mcp|hook|permission|shell|executable|terminal\.integrated\.(env|profiles|defaultProfile|automationProfile)|\.path$|command/i;

const CLASS_TITLE = {
  A: 'ТРЕВОГА: запись не объявлена',
  B: 'штатно: запись самой программы',
  C: 'вопрос: это вы меняли? (человек или VS Code)',
  D: 'объявлено: сделал установщик программы',
};

// ---------- что отслеживаем ----------
function watchList() {
  const h = u.homeDir();
  const cx = u.codexHome();
  const files = [];
  const add = (abs, o) => files.push(Object.assign({ id: u.tilde(abs), abs }, o || {}));
  for (const n of ['.zshrc', '.zprofile', '.zshenv', '.zlogin', '.bash_profile', '.bashrc', '.profile', '.gitconfig']) add(path.join(h, n));
  for (const n of ['.npmrc', '.pypirc', '.netrc', '_netrc', '.git-credentials']) add(path.join(h, n), { secret: true });
  add(path.join(h, '.config', 'git', 'credentials'), { secret: true });
  add(path.join(h, '.config', 'git', 'config'));
  add(path.join(h, '.config', 'git', 'ignore'));
  add(path.join(h, '.claude', 'settings.json'));
  add(path.join(h, '.claude', 'CLAUDE.md'));
  add(path.join(h, '.claude.json'), { secret: true, staticClass: 'B', why: 'отметки доверия и состояние Claude Code' });
  add(path.join(h, '.claude', '.credentials.json'), { secret: true, staticClass: 'B', why: 'вход в Claude' });
  add(path.join(cx, 'config.toml'), { toml: true });
  add(path.join(cx, 'AGENTS.md'));
  add(path.join(cx, 'hooks.json'));
  add(path.join(cx, 'auth.json'), { secret: true, staticClass: 'B', why: 'файл входа Codex меняется при каждом использовании' });
  if (u.IS_MAC) for (const n of ['settings.json', 'keybindings.json']) add(path.join(h, 'Library', 'Application Support', 'Code', 'User', n));
  else if (u.IS_WIN) {
    for (const n of ['PowerShell', 'WindowsPowerShell']) add(path.join(h, 'Documents', n, 'Microsoft.PowerShell_profile.ps1'));
    for (const n of ['settings.json', 'keybindings.json']) add(path.join(u.appData(), 'Code', 'User', n));
  } else for (const n of ['settings.json', 'keybindings.json']) add(path.join(h, '.config', 'Code', 'User', n));
  const dirs = ['skills', 'agents', 'hooks'].map((n) => ({ id: u.tilde(path.join(h, '.claude', n)) + '/', abs: path.join(h, '.claude', n) }));
  dirs.push({ id: u.tilde(path.join(h, '.agents', 'skills')) + '/', abs: path.join(h, '.agents', 'skills') });
  // Верхний уровень: имена. policy: logcache (журналы и кэш допустимы по списку), cache (любое новое = кэш), installdir (место, куда пишут установщики программ)
  const homes = [
    { id: u.tilde(path.join(h, '.claude')), abs: path.join(h, '.claude'), policy: 'logcache', allow: CLAUDE_LOG_CACHE, inside: {} },
    { id: u.tilde(cx), abs: cx, policy: 'logcache', allow: CODEX_LOG_CACHE, inside: ALLOWED_INSIDE },
    { id: u.tilde(path.join(h, '.npm')), abs: path.join(h, '.npm'), policy: 'cache', allow: [], inside: {} },
    { id: u.tilde(path.join(h, '.local', 'bin')), abs: path.join(h, '.local', 'bin'), policy: 'installdir', allow: [], inside: {} },
    { id: u.tilde(path.join(h, '.local', 'share')), abs: path.join(h, '.local', 'share'), policy: 'installdir', allow: [], inside: {} },
    { id: u.tilde(path.join(h, '.npm-global')), abs: path.join(h, '.npm-global'), policy: 'installdir', allow: [], inside: {} },
  ];
  if (u.IS_WIN) homes.push({ id: u.tilde(path.join(u.localAppData(), 'Programs', 'OpenAI')), abs: path.join(u.localAppData(), 'Programs', 'OpenAI'), policy: 'installdir', allow: [], inside: {} });
  return { files, dirs, homes };
}

// ---------- JSON с комментариями (настройки VS Code) ----------
function parseJsonc(text) {
  const t = String(text).replace(/^﻿/, '');
  let out = '', i = 0, str = false;
  while (i < t.length) {
    const c = t[i];
    if (str) { out += c; if (c === '\\') { out += t[i + 1] || ''; i += 2; continue; } if (c === '"') str = false; i++; continue; }
    if (c === '"') { str = true; out += c; i++; continue; }
    if (c === '/' && t[i + 1] === '/') { while (i < t.length && t[i] !== '\n') i++; continue; }
    if (c === '/' && t[i + 1] === '*') { const e = t.indexOf('*/', i + 2); i = e < 0 ? t.length : e + 2; continue; }
    out += c; i++;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}
// Хеши значений по ключам верхнего уровня: сами значения в снимок не попадают.
function keyHashes(text) {
  try {
    const j = parseJsonc(text);
    if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
    const out = {};
    for (const k of Object.keys(j)) out[k] = u.sha256(JSON.stringify(j[k])).slice(0, 12);
    return out;
  } catch (_) { return null; }
}

// ---------- снимок ----------
function readSafe(p) { try { return fs.readFileSync(p); } catch (_) { return null; } }
function topSnapshot(h) {
  const names = u.listDir(h.abs);
  if (!names) return { exists: false, names: [], kids: {} };
  const kids = {};
  for (const n of Object.keys(h.inside || {})) if (names.includes(n)) kids[n] = u.listDir(path.join(h.abs, n)) || [];
  return { exists: true, names, kids };
}

// Снимок живого состояния. backupDir: куда копировать несекретные файлы (null: без копий).
function scan(backupDir) {
  const w = watchList();
  const snap = { schema: 1, taken: new Date().toISOString(), platform: process.platform, files: {}, dirs: {}, tops: {} };
  for (const it of w.files) {
    const buf = readSafe(it.abs);
    if (!buf) { snap.files[it.id] = { exists: false }; continue; }
    const rec = { exists: true, sha: u.sha256(buf), size: buf.length, backup: null };
    const text = buf.toString('utf8');
    if (it.secret || secrets.looksSecret(text)) rec.secret = true;
    else {
      if (VSCODE_USER_FILE.test(it.id)) rec.keys = keyHashes(text);
      if (it.toml) { rec.section_keys = {}; rec.sections = tomlSections(text, rec.section_keys); }
      if (backupDir) {
        const dst = path.join(backupDir, it.id.replace(/^~\//, ''));
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.writeFileSync(dst, buf, { mode: 0o600 });
        rec.backup = u.toPosix(path.relative(path.dirname(backupDir), dst));
      }
    }
    snap.files[it.id] = rec;
  }
  for (const d of w.dirs) { const names = u.listDir(d.abs); snap.dirs[d.id] = names ? { exists: true, names } : { exists: false }; }
  for (const h of w.homes) snap.tops[h.id] = topSnapshot(h);
  return snap;
}

function dirs(root) {
  const p = rootLib.paths(root);
  return { dir: p.snapshots, file: (name) => path.join(p.snapshots, name + '.json'), files: (name) => path.join(p.snapshots, name + '-files') };
}
function take(root, name) {
  const d = dirs(root);
  fs.mkdirSync(d.dir, { recursive: true });
  const filesDir = d.files(name);
  fs.rmSync(filesDir, { recursive: true, force: true });
  const snap = scan(name === 'before' ? filesDir : null);
  snap.name = name;
  u.writeAtomic(d.file(name), JSON.stringify(snap, null, 2) + '\n');
  return snap;
}
function load(root, name) { return u.readJson(dirs(root).file(name)); }

// ---------- сравнение ----------
const logCacheAllowed = (h, name) => h.allow.some((re) => re.test(name));

// Класс записи по файлу и ключам. declared: пути вне корня, о записи в которые сказали заранее (state.declared).
function classifyFile(id, w, ctx) {
  const it = w.files.find((x) => x.id === id) || {};
  if (it.staticClass) return { cls: it.staticClass, why: it.why };
  if (ctx.declared.has(id)) return { cls: 'D' };
  return { cls: 'A' };
}

// ctx: { declared:[...], installs:number }
function diff(before, after, ctx) {
  ctx = ctx || {};
  const declared = new Set(ctx.declared || []);
  const hadInstalls = (ctx.installs || 0) > 0;
  const w = watchList();
  const items = [];   // {cls, id, kind, note}
  const push = (cls, id, kind, note) => items.push({ cls, id, kind, note: note || null });
  for (const it of w.files) {
    const b = before.files[it.id] || { exists: false };
    const a = after.files[it.id] || { exists: false };
    if (!b.exists && !a.exists) continue;
    if (b.exists && a.exists && b.sha === a.sha) continue;
    const kind = !b.exists ? 'создан' : !a.exists ? 'удалён' : 'изменён';
    // настройки VS Code: по названиям ключей
    if (VSCODE_USER_FILE.test(it.id) && a.exists && !a.secret && !b.secret) {
      const bk = b.exists ? b.keys : {};
      const ak = a.keys;
      if (bk && ak) {
        const changed = [...new Set([...Object.keys(bk), ...Object.keys(ak)])].filter((k) => bk[k] !== ak[k]).sort();
        // Ключи, о записи которых сказали заранее (модуль vscode по «да» человека: claudeCode.focusView), не тревога: это объявленная запись установщика.
        const fileDeclared = declared.has(it.id);
        const keys = changed.filter((k) => !(fileDeclared || declared.has(it.id + '#' + k)));
        const own = changed.filter((k) => !keys.includes(k));
        const ownNote = own.length ? 'объявлено заранее: ' + own.join(', ') : null;
        if (!keys.length) { push('D', it.id, kind, ownNote); continue; }
        const odd = keys.filter((k) => VSCODE_SUSPICIOUS_KEY.test(k));
        const note = 'ключи: ' + keys.slice(0, 12).join(', ') + (keys.length > 12 ? ' и ещё ' + (keys.length - 12) : '') + (ownNote ? '; ' + ownNote : '');
        if (odd.length) push('A', it.id, kind, note + '; похожие на наши (Claude, Codex, MCP, хуки, оболочка, пути запуска): ' + odd.join(', '));
        else push('C', it.id, kind, note + '; изменено не установщиком, проверь');
        continue;
      }
      if (declared.has(it.id)) push('D', it.id, kind, 'объявлено заранее (файл не разобран: названия ключей назвать нельзя)');
      else push('A', it.id, kind, 'файл настроек VS Code не разобран: названия ключей назвать нельзя');
      continue;
    }
    if (VSCODE_KEYBINDINGS.test(it.id)) { if (declared.has(it.id)) push('D', it.id, kind, 'объявлено заранее'); else push('A', it.id, kind, 'сочетание клавиш может запускать команды'); continue; }
    // config.toml Codex: по разделам (доверие папкам и хукам = вопрос человеку, остальное = тревога)
    if (it.toml && !declared.has(it.id) && !a.secret && !b.secret && a.exists && (b.sections || !b.exists) && a.sections) {
      const bs = b.exists ? b.sections : {};
      const changed = [...new Set([...Object.keys(bs), ...Object.keys(a.sections)])].filter((k) => bs[k] !== a.sections[k]).sort();
      const sk = a.section_keys || {};
      const oddKeys = (k) => (sk[k] || []).filter((x) => !TOML_TRUST_KEYS[trustKind(k)].includes(x));
      const trust = changed.filter((k) => TOML_TRUST.test(k) && !oddKeys(k).length), odd = changed.filter((k) => TOML_TRUST.test(k) && oddKeys(k).length);
      const other = changed.filter((k) => !TOML_TRUST.test(k) || odd.includes(k));
      if (trust.length) push('C', it.id, kind, 'доверие папкам и хукам Codex: разделов ' + trust.length + ' (projects.*: ' + trust.filter((k) => /^projects\./.test(k)).length + ', hooks.state.*: ' + trust.filter((k) => /^hooks\.state\./.test(k)).length + '); Codex записывает их, когда человек доверяет папке и вводит /hooks; значения не показываются');
      if (other.length) push('A', it.id, kind, 'изменены разделы: ' + other.slice(0, 12).map((k) => (odd.includes(k) ? 'в доверии ' + trustKind(k) + '.* неожиданные ключи: ' + oddKeys(k).join('/') : (k || '(верхний уровень)'))).join(', ') + (other.length > 12 ? ' и ещё ' + (other.length - 12) : '') + (b.exists && b.backup ? '; копия до изменения: ' + b.backup : ''));
      continue;
    }
    const c = classifyFile(it.id, w, { declared });
    let note = c.why || null;
    if (c.cls === 'A' || c.cls === 'D') {
      if (it.secret || a.secret || b.secret) note = (note ? note + '; ' : '') + 'содержимое не показывается: секретный или похожий на секрет файл';
      if (b.exists && b.backup) note = (note ? note + '; ' : '') + 'копия до изменения: ' + b.backup;
    }
    push(c.cls, it.id, kind, note);
  }
  for (const d of w.dirs) {
    const b = before.dirs[d.id] || { exists: false }, a = after.dirs[d.id] || { exists: false };
    if (!b.exists && !a.exists) continue;
    const bs = new Set(b.names || []), as = new Set(a.names || []);
    const added = [...as].filter((x) => !bs.has(x)), removed = [...bs].filter((x) => !as.has(x));
    const cls = declared.has(d.id) ? 'D' : 'A';
    if (added.length) push(cls, d.id, 'добавлено', added.join(', ') + ' (навыки, агенты и хуки человека установщик не создаёт)');
    if (removed.length) push(cls, d.id, 'убрано', removed.join(', '));
  }
  for (const h of w.homes) {
    const b = (before.tops || {})[h.id], a = (after.tops || {})[h.id];
    if (!b || !a) continue;
    const bs = new Set(b.names), as = new Set(a.names);
    const trackedHere = (n) => w.files.some((f) => f.abs.toLowerCase() === path.join(h.abs, n).toLowerCase()) || w.dirs.some((f) => f.abs.toLowerCase() === path.join(h.abs, n).toLowerCase());
    const okAdded = [], instAdded = [];
    for (const n of a.names) {
      if (bs.has(n) || trackedHere(n)) continue;
      if (h.policy === 'cache') { okAdded.push(n); continue; }
      if (h.policy === 'logcache' && logCacheAllowed(h, n)) { okAdded.push(n); continue; }
      if (h.policy === 'installdir') { instAdded.push(n); continue; }
      push(declared.has(h.id + '/' + n) ? 'D' : 'A', h.id + '/' + n, 'создано вне списка журналов и кэша', 'это может быть конфиг, хук, инструкция или настройка');
    }
    for (const n of b.names) {
      if (as.has(n) || trackedHere(n) || (h.policy === 'logcache' && logCacheAllowed(h, n)) || h.policy === 'cache') continue;
      push('A', h.id + '/' + n, 'удалено', null);
    }
    for (const [dn, okKids] of Object.entries(h.inside || {})) {
      if (!a.kids[dn]) continue;
      const bk = new Set((b.kids || {})[dn] || []);
      const extra = a.kids[dn].filter((x) => !bk.has(x) && !okKids.includes(x));
      if (extra.length) push('A', h.id + '/' + dn, 'создано вне списка', extra.join(', '));
    }
    if (okAdded.length) push('B', h.id, 'журналы и кэш программ', okAdded.join(', '));
    if (instAdded.length) push(hadInstalls || declared.has(h.id) ? 'D' : 'A', h.id, 'появилось', instAdded.join(', ') + (hadInstalls ? ' (установщик программы, объявлено)' : ' (установок не было: запись не объявлена)'));
  }
  const byCls = { A: [], B: [], C: [], D: [] };
  for (const x of items) byCls[x.cls].push(x);
  return { classes: byCls, alarm: byCls.A.length > 0, total: items.length };
}

function renderDiff(d, stampBefore) {
  const L = [];
  L.push('Сверка файлов вне главной папки' + (stampBefore ? ' (снимок «до» от ' + stampBefore + ')' : '') + ':');
  if (!d.total) { L.push('  ни один отслеживаемый файл не изменён и нового, кроме журналов и кэша, не появилось.'); return L.join('\n'); }
  for (const cls of ['A', 'D', 'C', 'B']) {
    if (!d.classes[cls].length) continue;
    L.push('  [' + cls + '] ' + CLASS_TITLE[cls]);
    for (const x of d.classes[cls]) L.push('    - ' + x.id + ': ' + x.kind + (x.note ? ' (' + x.note + ')' : ''));
  }
  if (d.alarm) L.push('  ТРЕВОГА: найдены записи, которые никто не объявлял. Покажи их человеку дословно, ничего не откатывай сам; откат возможен копированием файла из .workplace/snapshots/before-files/ только по «да» человека.');
  else if (d.classes.C.length) L.push('  Вопрос человеку по классу [C]: «это вы меняли?» (VS Code пишет свои настройки сам; значения ключей не показываются).');
  return L.join('\n');
}

module.exports = { CLASS_TITLE, TOML_TRUST, tomlSections, watchList, parseJsonc, keyHashes, scan, take, load, diff, renderDiff, dirs, VSCODE_SUSPICIOUS_KEY };
