'use strict';
// Общие мелочи ядра. Только встроенные модули Node 18+. Работает на Mac и Windows.
// WP_HOME: если задана, ядро считает её домашней папкой (проверки на фейковом HOME). В обычной работе не задаётся.
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

class WpError extends Error {
  constructor(message, code) { super(message); this.name = 'WpError'; this.code = code || 1; }
}

// ---------- папки ----------
function homeDir() { return process.env.WP_HOME ? path.resolve(process.env.WP_HOME) : os.homedir(); }
function codexHome() { return process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(homeDir(), '.codex'); }
function claudeHome() { return path.join(homeDir(), '.claude'); }
function appData() { return process.env.WP_HOME ? path.join(homeDir(), 'AppData', 'Roaming') : (process.env.APPDATA || path.join(homeDir(), 'AppData', 'Roaming')); }
function localAppData() { return process.env.WP_HOME ? path.join(homeDir(), 'AppData', 'Local') : (process.env.LOCALAPPDATA || path.join(homeDir(), 'AppData', 'Local')); }

// Домашняя папка в текстах заменяется на ~: имя пользователя не попадает в отчёт.
function tilde(p) {
  if (!p) return p;
  const q = String(p).replace(/\\/g, '/');
  for (const h of [homeDir(), os.homedir(), real(homeDir()), real(os.homedir())]) {
    const hh = h.replace(/\\/g, '/');
    if (q.toLowerCase() === hh.toLowerCase()) return '~';
    if (q.toLowerCase().startsWith(hh.toLowerCase() + '/')) return '~' + q.slice(hh.length);
  }
  return q.replace(/^(?:[A-Za-z]:)?\/(?:Users|home)\/[^/]+/, '~');
}

// ---------- файлы ----------
function exists(p) { try { fs.accessSync(p); return true; } catch (_) { return false; } }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } }
function isFile(p) { try { return fs.statSync(p).isFile(); } catch (_) { return false; } }
function real(p) { try { return fs.realpathSync.native(p); } catch (_) { return p; } }
function readText(p) { try { return fs.readFileSync(p, 'utf8'); } catch (_) { return null; } }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); } catch (_) { return null; } }
function listDir(p) { try { return fs.readdirSync(p).filter((n) => n !== '.DS_Store' && n !== 'desktop.ini' && n !== 'Thumbs.db').sort(); } catch (_) { return null; } }
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function sha256File(p) { try { return sha256(fs.readFileSync(p)); } catch (_) { return null; } }
function toPosix(p) { return String(p).split(path.sep).join('/'); }
// Один и тот же путь: с учётом ссылок (на Mac /var это ссылка на /private/var, и git называет папку по настоящему пути).
function same(a, b) { const n = (x) => { const p = real(path.resolve(x)); return IS_WIN || IS_MAC ? p.toLowerCase() : p; }; return n(a) === n(b); }
// Путь с раскрытыми ссылками даже там, где самого файла ещё нет: настоящий путь ближайшей существующей папки плюс остаток (на Mac /var это ссылка на /private/var).
function realish(p) {
  let cur = path.resolve(p);
  const tail = [];
  for (;;) {
    try { const r = fs.realpathSync.native(cur); return tail.length ? path.join(r, ...tail.reverse()) : r; } catch (_) {
      const up = path.dirname(cur);
      if (up === cur) return path.resolve(p);
      tail.push(path.basename(cur)); cur = up;
    }
  }
}
function within(base, p) {
  const lex = (a, b) => {
    const n = (x) => (IS_WIN || IS_MAC ? path.resolve(x).toLowerCase() : path.resolve(x));
    const r = path.relative(n(a), n(b));
    return r === '' || (r.split(path.sep)[0] !== '..' && !path.isAbsolute(r));
  };
  return lex(base, p) || lex(realish(base), realish(p));
}
// Запись во временный файл рядом и переименование: прерванная запись не оставляет половину файла.
function writeAtomic(file, data, mode) {
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, data, mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

// ---------- время ----------
function pad(n) { return String(n).padStart(2, '0'); }
function today(d) { d = d || new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function stamp(d) { d = d || new Date(); return today(d).replace(/-/g, '') + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()); }
function hhmm(d) { d = d || new Date(); return today(d) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); }

// ---------- версии ----------
function ver(s) { const m = String(s || '').match(/(\d+)\.(\d+)(?:\.(\d+))?/); return m ? [+m[1], +m[2], +(m[3] || 0)] : null; }
function atLeast(v, min) { if (!v) return false; for (let i = 0; i < 3; i++) { if (v[i] > min[i]) return true; if (v[i] < min[i]) return false; } return true; }
function cmpVer(a, b) { const x = ver(a) || [0, 0, 0], y = ver(b) || [0, 0, 0]; for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; }

// ---------- запуск программ ----------
// Кавычки для cmd.exe: пустой аргумент тоже нужен (в v3 он пропадал: --setting-sources "" превращался в потерянный параметр).
function q(a) {
  a = String(a);
  if (a === '') return '""';
  return /[\s"&|<>^()%!]/.test(a) ? '"' + a.replace(/"/g, '\\"') + '"' : a;
}
// Окружение дочерних программ: без кэша компиляции Node во временной папке; при фейковом HOME дочерние программы видят его же.
function childEnv(extra) {
  const env = Object.assign({}, process.env, { NODE_DISABLE_COMPILE_CACHE: '1', GIT_OPTIONAL_LOCKS: '0' }, extra || {});
  if (process.env.WP_HOME) { env.HOME = homeDir(); env.USERPROFILE = homeDir(); }
  for (const k of Object.keys(env)) if (env[k] === undefined || env[k] === null) delete env[k];
  return env;
}
function needsShell(cmd) { return IS_WIN && !/\.exe$/i.test(cmd); }
// Запуск с ожиданием. На Windows .cmd-обёртки (npm) требуют оболочки; промпты и длинные тексты передавать через input (stdin), не в аргументах.
function run(cmd, args, o) {
  o = o || {};
  args = args || [];
  const env = childEnv(o.env);
  try {
    const r = needsShell(cmd)
      ? cp.spawnSync([cmd, ...args].map(q).join(' '), { encoding: 'utf8', timeout: o.timeout || 15000, cwd: o.cwd, input: o.input, windowsHide: true, shell: true, env })
      : cp.spawnSync(cmd, args, { encoding: 'utf8', timeout: o.timeout || 15000, cwd: o.cwd, input: o.input, windowsHide: true, env });
    if (r.error && !r.status && r.status !== 0) return { ok: false, code: null, out: String(r.stdout || '').trim(), err: String(r.stderr || '').trim() || String(r.error.message), error: String(r.error.code || r.error.message), timedOut: r.error.code === 'ETIMEDOUT' };
    return { ok: r.status === 0, code: r.status, out: String(r.stdout || '').trim(), err: String(r.stderr || '').trim() };
  } catch (e) { return { ok: false, code: null, out: '', err: String(e.message), error: String(e.message) }; }
}
// Завершить программу вместе с дочерними процессами (одинокий kill оставляет зомби: на Windows codex и claude запускают потомков).
function killTree(pid) {
  if (!pid) return;
  try {
    if (IS_WIN) cp.spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else { try { process.kill(-pid, 'SIGTERM'); } catch (_) { process.kill(pid, 'SIGTERM'); } setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch (_) { /* уже завершён */ } }, 3000).unref(); }
  } catch (_) { /* уже завершён */ }
}

// ---------- поиск программ без запуска оболочки ----------
// Оболочка с профилями человека не запускается (она исполняла бы его профили): PATH читается из окружения процесса, плюс обычные места установки.
const WIN_EXT = ['.exe', '.cmd', '.bat', '.com'];
function isExec(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    if (IS_WIN) return WIN_EXT.includes(path.extname(p).toLowerCase());
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch (_) { return false; }
}
function pathDirs() {
  const raw = process.env.PATH || process.env.Path || '';
  return raw.split(path.delimiter).map((d) => d.replace(/^"|"$/g, '')).filter(Boolean);
}
function knownBinDirs() {
  const h = homeDir();
  const dirs = [path.join(h, '.local', 'bin'), path.join(h, '.npm-global', 'bin'), path.join(h, '.volta', 'bin'), path.join(h, '.bun', 'bin'), path.join(h, 'n', 'bin'), path.join(h, '.asdf', 'shims'), path.join(h, '.nodenv', 'shims')];
  if (IS_WIN) {
    dirs.push(path.join(appData(), 'npm'), path.join(localAppData(), 'Programs', 'OpenAI', 'Codex', 'bin'), path.join(localAppData(), 'Volta', 'bin'), path.join(localAppData(), 'Programs', 'nodejs'), path.join(localAppData(), 'Microsoft', 'WindowsApps'));
    for (const pf of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) if (pf && !process.env.WP_HOME) dirs.push(path.join(pf, 'nodejs'), path.join(pf, 'Git', 'cmd'), path.join(pf, 'Git', 'bin'));
    const nvm = path.join(appData(), 'nvm'); for (const n of listDir(nvm) || []) if (isDir(path.join(nvm, n))) dirs.push(path.join(nvm, n));
  } else {
    // Системные папки (настоящая машина) при фейковом HOME не смотрим: тест разведки на «пустой» машине не должен находить настоящий claude хозяина (как ProgramFiles выше).
    if (!process.env.WP_HOME) {
      dirs.push('/usr/local/bin', '/opt/homebrew/bin', '/usr/bin');
      for (const n of listDir('/opt') || []) dirs.push(path.join('/opt', n, 'bin'));
    }
    for (const [base, sub] of [[path.join(h, '.nvm', 'versions', 'node'), 'bin'], [path.join(h, '.local', 'share', 'fnm', 'node-versions'), path.join('installation', 'bin')], [path.join(h, 'Library', 'Application Support', 'fnm', 'node-versions'), path.join('installation', 'bin')], [path.join(h, '.fnm', 'node-versions'), path.join('installation', 'bin')]]) {
      for (const n of listDir(base) || []) dirs.push(path.join(base, n, sub));
    }
  }
  return dirs;
}
// Все копии программы: сначала по PATH (в порядке PATH), потом в известных папках. Дубликаты по realpath убираются.
function findAll(name) {
  const found = new Map();
  const exts = IS_WIN ? WIN_EXT : [''];
  const add = (dir, via) => {
    for (const e of exts) {
      const p = path.join(dir, name + e);
      if (!isExec(p)) continue;
      const rp = real(p);
      const key = IS_WIN || IS_MAC ? rp.toLowerCase() : rp;
      if (!found.has(key)) found.set(key, { path: p, real: rp, via: [] });
      if (!found.get(key).via.includes(via)) found.get(key).via.push(via);
      break;
    }
  };
  for (const d of pathDirs()) add(d, 'PATH');
  for (const d of knownBinDirs()) add(d, 'известная папка');
  return [...found.values()];
}
// Вид установки по пути (для таблицы разведки).
function kindOf(p) {
  const x = String(p).replace(/\\/g, '/');
  if (/\.vscode[^/]*\/extensions\//i.test(x) || /\/\.cursor\/extensions\//i.test(x)) return 'встроена в расширение';
  if (/Programs\/OpenAI\/Codex/i.test(x) || /\/\.local\/bin\//.test(x)) return 'родная установка (в домашней папке)';
  if (/node_modules|\/npm\/|\/nvm\/|\/\.nvm\/|\/\.npm|AppData\/Roaming\/npm|\.npm-global|\/n\/bin/i.test(x)) return 'через npm';
  if (/\/\.volta\/|\/Volta\//i.test(x)) return 'через Volta';
  if (/\/\.asdf\/|\/\.nodenv\/|\/fnm\//.test(x)) return 'через менеджер версий Node';
  if (/^\/opt\/homebrew\/|^\/opt\/|\/Caskroom\/|\/Cellar\//.test(x)) return 'через Homebrew или менеджер пакетов';
  if (/WindowsApps/i.test(x)) return 'магазин приложений Windows (или его заглушка)';
  if (/^\/usr\/local\/bin\//.test(x)) return 'системная папка /usr/local/bin (нужны права администратора)';
  if (/^\/usr\/bin\//.test(x)) return 'системная';
  if (/Program Files/i.test(x)) return 'установщик Windows (Program Files)';
  return 'другое';
}
// Версия программы. Разведка не должна менять ни байта (G2): `codex --version` создаёт ~/.codex/tmp/arg0-*/, если CODEX_HOME существует (M1 этапа Г).
// Поэтому Codex запускается с CODEX_HOME на НЕСУЩЕСТВУЮЩУЮ временную папку: он пишет предупреждение в stderr (versionOf читает его вместе с stdout), печатает версию и ничего не создаёт.
// Если папка всё же появилась, она удаляется (только эта папка, имя уникально).
function versionOf(p, args) {
  const isCodex = path.basename(String(p)).replace(/\.(exe|cmd|bat|com)$/i, '').toLowerCase() === 'codex';
  const probeHome = isCodex ? path.join(os.tmpdir(), 'wp-probe-' + process.pid + '-' + Date.now()) : null;
  const r = run(p, args || ['--version'], { timeout: 10000, env: probeHome ? { CODEX_HOME: probeHome } : undefined });
  if (probeHome) { try { fs.rmSync(probeHome, { recursive: true, force: true }); } catch (_) { /* не создавалась */ } }
  const m = (r.out + ' ' + r.err).match(/(\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.]+)?)/);
  return { ok: r.ok, version: m ? m[1] : null, error: r.ok ? null : (r.err || r.out || r.error || 'не запускается').split(/\r?\n/)[0].slice(0, 200), timedOut: !!r.timedOut };
}

// ---------- шаблоны ----------
function fill(text, map) { return String(text).replace(/\{\{(\w+)\}\}/g, (m, k) => (k in map ? map[k] : m)); }

module.exports = {
  IS_WIN, IS_MAC, WpError,
  homeDir, codexHome, claudeHome, appData, localAppData, tilde, realish,
  exists, isDir, isFile, real, readText, readJson, listDir, sha256, sha256File, toPosix, same, within, writeAtomic,
  pad, today, stamp, hhmm, ver, atLeast, cmpVer,
  q, childEnv, needsShell, run, killTree,
  pathDirs, knownBinDirs, findAll, kindOf, versionOf, isExec, fill,
};
