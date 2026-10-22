'use strict';
// Разбор shell-команды для сторожей (secret-guard, danger-guard, cross-check-guard). Это не хук: файлы с «_» не подключаются.
// Опирается на core/lib/shell-lex.js: «команда это или текст» решает позиция слова, поэтому echo "rm -rf /" и git commit -m "sudo" ничего не запускают.
// flatten() превращает строку в плоский список простых команд: обёртки (sudo, env, nohup, xargs...) раскрыты, содержимое bash -c / powershell -Command /
// cmd /c / eval / подстановок $(...) / heredoc в оболочку разобрано рекурсивно, отслеживается cd внутри одной команды.
const os = require('os');
const path = require('path');
const lex = require('../lib/shell-lex');
const u = require('../lib/util');

const MAX_DEPTH = 4;
const MAX_ITEMS = 400;

const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', 'time', '{', '}']);
const ASSIGN_RX = /^[A-Za-z_][A-Za-z0-9_]*=/;
// Обёртки: после них идёт настоящая команда. Значение: параметры, которые берут значение (пропускаются парой).
const WRAPPERS = {
  command: [], builtin: [], exec: [], nohup: [], noglob: [], setsid: [], chronic: [], caffeinate: [],
  env: [], nice: ['-n'], ionice: ['-c', '-n', '-p'], timeout: ['-s', '-k', '--signal', '--kill-after'], stdbuf: [],
  xargs: ['-n', '-I', '-P', '-L', '-s', '-d', '-E', '-a', '--max-args', '--max-procs'],
  sudo: ['-u', '-g', '-h', '-p', '-C', '-T', '-r', '-t', '-D'], doas: ['-u', '-C'], gsudo: [], pkexec: ['--user'],
  wsl: ['-d', '-u', '--distribution', '--user', '--cd'],
};
const ELEVATORS = new Set(['sudo', 'doas', 'gsudo', 'pkexec', 'su', 'runas']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'ash', 'csh', 'tcsh']);
const PS_SHELLS = new Set(['powershell', 'pwsh']);

function key(t) { return lex.cmdKey(t).replace(/\.(cmd|bat|com|ps1)$/, ''); }
function isFlag(w) { return !w.q && /^-/.test(w.t); }

// Находит настоящую команду в списке слов стадии: пропускает ключевые слова if/then/do, присваивания FOO=bar и обёртки.
function resolveCommand(args) {
  let i = 0;
  const wrappers = [];
  for (;;) {
    const w = args[i];
    if (!w) return wrappers.length ? { cmd: wrappers[wrappers.length - 1], raw: wrappers[wrappers.length - 1], rest: [], wrappers: wrappers.slice(0, -1) } : null;
    if (ASSIGN_RX.test(w.t)) { i++; continue; }
    const k = key(w.t);
    if (KEYWORDS.has(k)) { i++; continue; }
    if (Object.prototype.hasOwnProperty.call(WRAPPERS, k)) {
      wrappers.push(k);
      i++;
      const valued = WRAPPERS[k];
      if (k === 'env') {
        while (args[i] && (isFlag(args[i]) || ASSIGN_RX.test(args[i].t))) { if (/^-[uC]$/.test(args[i].t)) i++; i++; }
        if (!args[i]) return { cmd: 'env', raw: 'env', rest: [], wrappers: wrappers.slice(0, -1), envDump: true };
      } else {
        while (args[i] && isFlag(args[i])) { const t = args[i].t; i++; if (valued.includes(t) && args[i]) i++; }
        if (k === 'timeout' && args[i]) i++;   // длительность
        if (k === 'wsl' && args[i] && /^(-e|--exec|--)$/.test(args[i].t)) i++;
      }
      continue;
    }
    return { cmd: k, raw: w.t, rest: args.slice(i + 1), wrappers };
  }
}

// Домашняя папка: u.homeDir() (WP_HOME подменяет её в тестах; в обычной работе это os.homedir()).
function home() { return u.homeDir().replace(/\\/g, '/'); }
function tmp() { return os.tmpdir().replace(/\\/g, '/'); }

// Цель команды в путь. {p} - абсолютный путь (для шаблона с * это ближайшая папка без шаблона, glob:true), {unknown:true} - проверить нельзя ($VAR, подстановка, неизвестная папка).
function expandTarget(t, cwd) {
  let s = String(t);
  s = s.replace(/^(\$\{?(?:HOME)\}?|\$env:(?:USERPROFILE|HOME)|%USERPROFILE%)(?=[\/\\]|$)/i, home());
  s = s.replace(/^(\$\{?(?:TMPDIR|TMP|TEMP)\}?|\$env:(?:TEMP|TMP)|%TEMP%|%TMP%)(?=[\/\\]|$)/i, tmp());
  if (s === '~') s = home();
  s = s.replace(/^~(?=[\/\\])/, home());
  if (/[$`]|%[A-Za-z_]+%/.test(s)) return { unknown: true };
  let glob = false;
  const gi = s.search(/[*?\[]/);
  if (gi >= 0) {
    glob = true;
    let pre = s.slice(0, gi);
    if (!/[\/\\]$/.test(pre)) pre = pre.replace(/[^\/\\]*$/, '');
    s = pre || './';
  }
  const isAbs = /^([A-Za-z]:[\/\\]|\/|\\|~[\/\\])/.test(s);
  if (!isAbs && !cwd) return { unknown: true };
  return { p: lex.resolvePath(s, cwd || process.cwd()), glob };
}

// Папки, внутри которых можно удалять рекурсивно: корень рабочего места и временные папки.
function safeZones(root) {
  const z = [];
  const add = (p) => { if (p) { z.push(path.resolve(p)); try { z.push(require('fs').realpathSync(p)); } catch (_) { /* нет такой */ } } };
  add(root);
  // WP_TMP_ZONES (только для тестов): папки через разделитель PATH вместо настоящих временных папок.
  const tmps = process.env.WP_TMP_ZONES ? process.env.WP_TMP_ZONES.split(path.delimiter).filter(Boolean) : [os.tmpdir(), '/tmp', '/var/tmp', '/private/tmp', '/var/folders', '/private/var/folders'];
  for (const t of tmps) add(t);
  return { zones: z, root: root ? path.resolve(root) : null };
}
// Путь строго внутри одной из папок (сама папка не считается: удалить весь корень или всю temp нельзя).
function strictlyInside(p, zones) {
  const rp = path.resolve(p);
  return zones.some((z) => u.within(z, rp) && !u.same(z, rp));
}

function lexOne(src, mode) { try { return lex.lex(src, mode); } catch (_) { return { stages: [], subs: [] }; } }

function psDecode(b64) {
  try { return Buffer.from(String(b64), 'base64').toString('utf16le'); } catch (_) { return ''; }
}
function shellScript(it) {
  // -> { script, mode } для оболочек с -c, PowerShell -Command/-EncodedCommand, cmd /c; иначе null
  const rest = it.rest;
  if (SHELLS.has(it.cmd)) {
    for (let i = 0; i < rest.length; i++) if (!rest[i].q && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(rest[i].t) && rest[i + 1]) return { script: rest[i + 1].t, mode: 'sh' };
    return null;
  }
  if (PS_SHELLS.has(it.cmd)) {
    for (let i = 0; i < rest.length; i++) {
      const t = rest[i].t;
      if (/^-(c|command)$/i.test(t) && rest[i + 1]) return { script: rest.slice(i + 1).map((w) => w.t).join(' '), mode: 'ps' };
      if (/^-(e|ec|enc|encodedcommand)$/i.test(t) && rest[i + 1]) return { script: psDecode(rest[i + 1].t), mode: 'ps' };
    }
    return null;
  }
  if (it.cmd === 'cmd') {
    for (let i = 0; i < rest.length; i++) if (/^\/[ck]$/i.test(rest[i].t)) return { script: rest.slice(i + 1).map((w) => w.t).join(' '), mode: 'sh' };
    return null;
  }
  if (it.cmd === 'eval' && rest.length) return { script: rest.map((w) => w.t).join(' '), mode: 'sh' };
  return null;
}

function cdTarget(it, cwd) {
  const first = it.rest.find((w) => !isFlag(w) || w.t === '-');
  if (!first) return home();
  if (first.t === '-') return null;
  const r = expandTarget(first.t, cwd);
  return r.p || null;
}

// Переменные, которым в этом же скрипте один раз присвоено известное значение (PowerShell: `$t = 'C:/путь'`, `$t = Join-Path $env:USERPROFILE 'old-tmp'`):
// их подстановка в последующие слова превращает `Remove-Item $t` в команду с настоящим путём. Присвоенная дважды или неразобранная переменная остаётся неизвестной.
const VAR_ASSIGN_RX = /^\$([A-Za-z_][A-Za-z0-9_]*)$/;
const VAR_LEAD_RX = /^\$([A-Za-z_][A-Za-z0-9_]*)(?=[\/\\]|$)/;
function substVars(text, vars) {
  const m = VAR_LEAD_RX.exec(text);
  if (!m || !Object.prototype.hasOwnProperty.call(vars, m[1])) return text;
  return vars[m[1]] + text.slice(m[0].length);
}
function varValue(words, vars) {
  let ws = words.map((w) => ({ t: String(w.t), q: !!w.q }));
  if (ws.length && !ws[0].q) ws[0].t = ws[0].t.replace(/^\(+/, '');
  if (ws.length && !ws[ws.length - 1].q) ws[ws.length - 1].t = ws[ws.length - 1].t.replace(/\)+$/, '');
  ws = ws.filter((w) => w.t !== '');
  let val = null;
  if (ws.length === 1) val = ws[0].t;
  else if (ws.length >= 3 && !ws[0].q && /^join-path$/i.test(ws[0].t)) {
    const parts = ws.slice(1).filter((w) => w.q || !/^-/.test(w.t)).map((w) => w.t);
    if (parts.length === 2) val = parts[0].replace(/[\/\\]+$/, '') + '/' + parts[1].replace(/^[\/\\]+/, '');
  }
  if (val === null) return null;
  val = substVars(val, vars);
  // остаться может только домашняя или временная папка в начале: их раскрывает expandTarget; любая другая подстановка - неизвестный путь
  const rest = val.replace(/^(\$\{?(?:HOME|TMPDIR|TMP|TEMP)\}?|\$env:(?:USERPROFILE|HOME|TEMP|TMP)|%USERPROFILE%|%TEMP%|%TMP%)(?=[\/\\]|$)/i, '');
  return /[$`]|%[A-Za-z_]+%|[()]/.test(rest) ? null : val;
}

// Плоский список простых команд. mode: 'sh' | 'ps'. cwd: папка запуска (null - неизвестна).
function flatten(src, mode, cwd, depth, out) {
  out = out || [];
  depth = depth || 0;
  if (depth > MAX_DEPTH || out.length > MAX_ITEMS) return out;
  const L = lexOne(String(src), mode);
  let cur = cwd || null;
  const startCwd = cur;
  const vars = Object.create(null), seen = new Set();
  const cwdStack = [];      // папка до входа в круглые скобки: после `)` cd из скобок не действует
  for (const stage of L.stages) {
    const dpt = stage.depth || 0;
    while (cwdStack.length > dpt) cur = cwdStack.pop();
    while (cwdStack.length < dpt) cwdStack.push(cur);
    const { args, redirs } = lex.splitRedirects(stage.words);
    const last = stage.words[stage.words.length - 1];
    const trailingLt = !!(last && last.op && last.t === '<');
    const rc = resolveCommand(args);
    if (!rc) { out.push({ cmd: '', raw: '', rest: [], wrappers: [], redirs, stmt: stage.stmt, here: stage.here, cwd: cur, depth, trailingLt }); continue; }
    const it = Object.assign({}, rc, { redirs, stmt: stage.stmt, here: stage.here, cwd: cur, depth, trailingLt });
    const va = VAR_ASSIGN_RX.exec(rc.raw);
    if (va && rc.rest[0] && !rc.rest[0].q && rc.rest[0].t === '=') {
      // присваивание переменной: запоминаем значение (второе присваивание делает переменную неизвестной)
      const name = va[1];
      if (seen.has(name)) delete vars[name];
      else { seen.add(name); const v = varValue(rc.rest.slice(1), vars); if (v !== null) vars[name] = v; }
    } else if (Object.keys(vars).length) {
      it.rest = it.rest.map((w) => { const t = substVars(w.t, vars); return t === w.t ? w : Object.assign({}, w, { t }); });
    }
    out.push(it);
    if (/^(cd|pushd|chdir|set-location|sl)$/.test(it.cmd)) cur = cdTarget(it, cur);
    else if (/^(popd)$/.test(it.cmd)) cur = null;
    const sc = shellScript(it);
    if (sc && sc.script) flatten(sc.script, sc.mode, cur, depth + 1, out);
    if ((SHELLS.has(it.cmd) || PS_SHELLS.has(it.cmd)) && !sc && it.here) for (const h of it.here) if (h.body) flatten(h.body, SHELLS.has(it.cmd) ? 'sh' : 'ps', cur, depth + 1, out);
  }
  for (const sub of L.subs) flatten(sub, mode, startCwd, depth + 1, out);
  return out;
}

// По режимам: на PowerShell-инструменте только 'ps', иначе оба (Codex на Windows присылает PowerShell под именем shell_command).
function flattenAll(src, o) {
  o = o || {};
  // Heredoc (<<EOF) бывает только в sh, here-string (@' ... '@) только в PowerShell: тогда второй режим исказил бы разбор.
  const text = String(src);
  let modes = ['sh', 'ps'];
  if (o.psOnly || /@['"][ \t]*\r?\n/.test(text)) modes = ['ps'];
  else if (/<<-?[ \t]*['"]?[A-Za-z_]/.test(text)) modes = ['sh'];
  const res = [];
  for (const m of modes) res.push({ mode: m, items: flatten(src, m, o.cwd) });
  return res;
}

// Подкоманда git: пропускает -C <путь>, -c k=v и прочие глобальные параметры.
function gitSub(rest) {
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i].t;
    if (t === '-C' || t === '-c' || t === '--git-dir' || t === '--work-tree' || t === '--namespace') { i++; continue; }
    if (/^-/.test(t)) continue;
    return { sub: t.toLowerCase(), args: rest.slice(i + 1) };
  }
  return { sub: '', args: [] };
}
function hasFlag(words, ...names) {
  return words.some((w) => !w.q && names.some((n) => (n instanceof RegExp ? n.test(w.t) : w.t === n || w.t.startsWith(n + '='))));
}
function positional(words) { return words.filter((w) => !isFlag(w)); }

// Адреса (https://...) в тексте команды.
function urlsIn(text) {
  const m = String(text).match(/https?:\/\/[^\s'"`|)<>]+/gi) || [];
  return m.map((x) => x.replace(/[.,;:]+$/, ''));
}

module.exports = { MAX_DEPTH, KEYWORDS, ELEVATORS, SHELLS, PS_SHELLS, key, isFlag, resolveCommand, expandTarget, safeZones, strictlyInside, flatten, flattenAll, shellScript, gitSub, hasFlag, positional, urlsIn, home, tmp };
