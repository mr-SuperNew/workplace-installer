#!/usr/bin/env node
'use strict';
// Модуль vscode: включает настройку расширения Claude Code «Focus view» (ключ claudeCode.focusView) в файле настроек пользователя VS Code.
// Только встроенные модули Node 18+. Mac и Windows.
//
//   node focus-view.js status                 только чтение: где файл настроек и включена ли настройка
//   node focus-view.js apply [--yes]          без --yes только показывает, что изменится; с --yes пишет, но только если в записанных сообщениях человека есть «да» и названы VS Code или focus view (сам --yes «да» не доказывает)
//   node focus-view.js revert [--yes]         вернуть файл настроек таким, каким он был до apply (если с тех пор его никто не менял); то же правило «да»
//
// Запись идёт ТОЛЬКО в файл настроек пользователя VS Code и ТОЛЬКО одного ключа. Остальной файл (комментарии, порядок, чужие ключи) не меняется.
// Перед записью копия файла кладётся в <главная папка>/.workplace/backup-update/. Запускать apply можно только из главной папки
// (<главная папка>/.workplace/modules/vscode/focus-view.js): копия нужна, чтобы откат был возможен.
// Источник ключа: package.json расширения anthropic.claude-code 2.1.286: "claudeCode.focusView", boolean, по умолчанию false, scope "application"
// (значит, ключ работает только в настройках пользователя, не в .vscode/settings.json проекта).
// WP_HOME: если задана, считается домашней папкой (проверки на фейковом HOME, как в ядре).
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');

const KEY = 'claudeCode.focusView';
const ENTRY = '"' + KEY + '": true';

function say(s) { process.stdout.write(s + '\n'); }
function die(s, code) { process.stderr.write(s + '\n'); process.exit(code || 1); }

// ---------- пути ----------
function homeDir() { return process.env.WP_HOME ? path.resolve(process.env.WP_HOME) : os.homedir(); }
function appData() { return process.env.WP_HOME ? path.join(homeDir(), 'AppData', 'Roaming') : (process.env.APPDATA || path.join(homeDir(), 'AppData', 'Roaming')); }
function settingsPath() {
  if (process.platform === 'darwin') return path.join(homeDir(), 'Library', 'Application Support', 'Code', 'User', 'settings.json');
  if (process.platform === 'win32') return path.join(appData(), 'Code', 'User', 'settings.json');
  return path.join(homeDir(), '.config', 'Code', 'User', 'settings.json');
}
function tilde(p) {
  const q = String(p).replace(/\\/g, '/'), h = homeDir().replace(/\\/g, '/');
  return q.toLowerCase().startsWith(h.toLowerCase() + '/') ? '~' + q.slice(h.length) : q;
}
// Главная папка по расположению скрипта: <корень>/.workplace/modules/vscode/focus-view.js. Иначе null.
function rootByScript() {
  const root = path.resolve(__dirname, '..', '..', '..');
  if (path.basename(path.resolve(__dirname, '..', '..')) !== '.workplace') return null;
  const wp = path.join(root, '.workplace');
  return fs.existsSync(path.join(wp, 'config.json')) || fs.existsSync(path.join(wp, 'state.json')) ? root : null;
}
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
function stamp() { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()); }

// ---------- разбор JSONC (JSON с комментариями и лишними запятыми, как у настроек VS Code) ----------
function skip(t, i) {
  for (;;) {
    while (i < t.length && /\s/.test(t[i])) i++;
    if (t[i] === '/' && t[i + 1] === '/') { while (i < t.length && t[i] !== '\n') i++; continue; }
    if (t[i] === '/' && t[i + 1] === '*') { const e = t.indexOf('*/', i + 2); if (e < 0) throw new Error('не закрыт комментарий'); i = e + 2; continue; }
    return i;
  }
}
function scanString(t, i) {
  if (t[i] !== '"') throw new Error('ожидалась строка в позиции ' + i);
  i++;
  while (i < t.length) { if (t[i] === '\\') { i += 2; continue; } if (t[i] === '"') return i + 1; i++; }
  throw new Error('не закрыта строка');
}
function scanValue(t, i) {
  const c = t[i];
  if (c === '"') return scanString(t, i);
  if (c === '{' || c === '[') {
    const close = c === '{' ? '}' : ']';
    i++;
    for (;;) {
      i = skip(t, i);
      if (i >= t.length) throw new Error('не закрыта скобка');
      if (t[i] === close) return i + 1;
      if (t[i] === ',') { i++; continue; }
      if (c === '{') { i = skip(t, scanString(t, i)); if (t[i] !== ':') throw new Error('ожидалось двоеточие'); i = skip(t, i + 1); }
      i = scanValue(t, i);
    }
  }
  const re = /[^\s,\]}\/]+/y; re.lastIndex = i;
  const m = re.exec(t);
  if (!m) throw new Error('ожидалось значение в позиции ' + i);
  return i + m[0].length;
}
// Верхний уровень файла: { open, close, members:[{key,keyStart,valStart,valEnd}], lastSig }.
function parseTop(t) {
  let i = skip(t, 0);
  if (t[i] !== '{') throw new Error('файл настроек не объект JSON');
  const open = i; i++;
  const members = []; let lastSig = open;
  for (;;) {
    i = skip(t, i);
    if (i >= t.length) throw new Error('не закрыта фигурная скобка');
    if (t[i] === '}') { if (skip(t, i + 1) !== t.length) throw new Error('после закрывающей скобки есть лишний текст'); return { open, close: i, members, lastSig }; }
    if (t[i] === ',') { lastSig = i; i++; continue; }
    const ks = i, ke = scanString(t, i);
    const key = JSON.parse(t.slice(ks, ke));
    i = skip(t, ke);
    if (t[i] !== ':') throw new Error('ожидалось двоеточие');
    i = skip(t, i + 1);
    const vs = i, ve = scanValue(t, i);
    members.push({ key, keyStart: ks, valStart: vs, valEnd: ve });
    lastSig = ve - 1; i = ve;
  }
}
// Текст без комментариев и лишних запятых: годится для JSON.parse (проверка результата).
function stripJsonc(t) {
  let out = '', i = 0;
  while (i < t.length) {
    const c = t[i];
    if (c === '"') { const e = scanString(t, i); out += t.slice(i, e); i = e; continue; }
    if (c === '/' && t[i + 1] === '/') { while (i < t.length && t[i] !== '\n') i++; continue; }
    if (c === '/' && t[i + 1] === '*') { const e = t.indexOf('*/', i + 2); i = e < 0 ? t.length : e + 2; continue; }
    out += c; i++;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

// ---------- правка текста ----------
// Возвращает { text, changed, before } : before = прежнее значение ключа (текст) или null.
function setFocusView(raw) {
  const bom = raw.charCodeAt(0) === 0xFEFF ? '﻿' : '';
  const t = bom ? raw.slice(1) : raw;
  const eol = t.includes('\r\n') ? '\r\n' : '\n';
  if (!t.trim()) return { text: bom + '{' + eol + '    ' + ENTRY + eol + '}' + eol, changed: true, before: null };
  const top = parseTop(t);
  const found = top.members.filter((m) => m.key === KEY).pop();
  let out;
  let before = null;
  if (found) {
    before = t.slice(found.valStart, found.valEnd);
    if (before === 'true') return { text: raw, changed: false, before };
    out = t.slice(0, found.valStart) + 'true' + t.slice(found.valEnd);
  } else {
    let indent = '    ';
    if (top.members.length) {
      const first = top.members[0];
      const ls = t.lastIndexOf('\n', first.keyStart) + 1;
      const pre = t.slice(ls, first.keyStart);
      if (/^[ \t]+$/.test(pre)) indent = pre;
    }
    const pos = top.lastSig + 1;
    const needComma = top.members.length > 0 && t[top.lastSig] !== ',';
    const tail = t.slice(pos, top.close);
    out = t.slice(0, pos) + (needComma ? ',' : '') + eol + indent + ENTRY + (tail.includes('\n') ? '' : eol) + t.slice(pos);
  }
  // проверка результата: разбирается, ключ верхнего уровня равен true, прочие ключи те же
  const chk = parseTop(out);
  const got = chk.members.filter((m) => m.key === KEY).pop();
  if (!got || out.slice(got.valStart, got.valEnd) !== 'true') throw new Error('проверка результата не прошла: ключ не стал true');
  const a = JSON.parse(stripJsonc(t)), b = JSON.parse(stripJsonc(out));
  for (const k of Object.keys(a)) if (k !== KEY && JSON.stringify(a[k]) !== JSON.stringify(b[k])) throw new Error('проверка результата не прошла: изменился ключ ' + k);
  for (const k of Object.keys(b)) if (k !== KEY && !(k in a)) throw new Error('проверка результата не прошла: появился лишний ключ ' + k);
  return { text: bom + out, changed: true, before };
}

function readSettings(file) {
  let lst = null;
  try { lst = fs.lstatSync(file); } catch (_) { /* нет файла */ }
  if (lst && lst.isSymbolicLink()) die('Файл настроек ' + tilde(file) + ' это ссылка: не пишу. Ничего не изменено.', 3);
  if (lst && !lst.isFile()) die(tilde(file) + ' не файл. Ничего не изменено.', 3);
  return lst ? fs.readFileSync(file, 'utf8') : null;
}

// ---------- команды ----------
function cmdStatus() {
  const file = settingsPath();
  say('Файл настроек пользователя VS Code: ' + tilde(file));
  const raw = readSettings(file);
  if (raw === null) { say(fs.existsSync(path.dirname(file)) ? 'Файла ещё нет: настройка не включена.' : 'Папки настроек VS Code нет: VS Code на этой машине ещё не запускался.'); return; }
  let top;
  try { top = parseTop(raw.replace(/^﻿/, '')); } catch (e) { die('Файл настроек не разобран (' + e.message + '). Править его нужно руками.', 3); }
  const m = top.members.filter((x) => x.key === KEY).pop();
  const t = raw.replace(/^﻿/, '');
  say(m ? KEY + ' = ' + t.slice(m.valStart, m.valEnd) : KEY + ' не задан (по умолчанию выключено).');
}

function cmdApply(yes) {
  const file = settingsPath();
  const root = rootByScript();
  if (!fs.existsSync(path.dirname(file))) die('Папки настроек VS Code (' + tilde(path.dirname(file)) + ') нет: VS Code на этой машине ещё не запускался. Запустите его один раз и повторите. Ничего не изменено.', 3);
  const raw = readSettings(file);
  let res;
  try { res = setFocusView(raw === null ? '' : raw); } catch (e) { die('Файл настроек не разобран (' + e.message + '). Править его нужно руками: добавьте строку ' + ENTRY + '. Ничего не изменено.', 3); }
  if (!res.changed) { say(KEY + ' уже true: ничего не меняю.'); return; }
  say('Файл: ' + tilde(file));
  say('Изменится одна строка: ' + (res.before === null ? 'добавится ' + ENTRY : KEY + ': ' + res.before + ' станет true') + '. Остальное в файле не меняется.');
  say('Это запись вне главной папки (класс «файлы, которые мог менять человек или VS Code»). Копия файла до записи ляжет в .workplace/backup-update.');
  if (!yes) { say('Это только план: ничего не записано. Покажите его человеку и после «да» повторите с --yes.'); process.exitCode = 2; return; }
  if (!root) die('apply запускается из главной папки: .workplace/modules/vscode/focus-view.js. Копия файла до записи нужна для отката, поэтому из пакета запись не делается. Ничего не изменено.', 3);
  requireHuman(root, 'apply');
  const dir = path.join(root, '.workplace', 'backup-update', 'vscode-' + stamp());
  let backup = null;
  if (raw !== null) {
    fs.mkdirSync(dir, { recursive: true });
    backup = path.join(dir, 'settings.json');
    fs.copyFileSync(file, backup);
  } else fs.mkdirSync(dir, { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, res.text);
  fs.renameSync(tmp, file);
  fs.writeFileSync(path.join(root, '.workplace', 'backup-update', 'vscode-last.json'), JSON.stringify({
    file: tilde(file), existed: raw !== null, backup: backup ? path.relative(root, backup).split(path.sep).join('/') : null,
    before_sha: raw === null ? null : sha(Buffer.from(raw)), after_sha: sha(Buffer.from(res.text)), at: new Date().toISOString(),
  }, null, 2) + '\n');
  say('Готово: ' + KEY + ' включён' + (backup ? '. Копия до записи: ' + path.relative(root, backup).split(path.sep).join('/') : ' (файла не было, создан)') + '.');
  say('Откат: node .workplace/modules/vscode/focus-view.js revert --yes');
  logToState(root, 'модуль vscode: в настройках VS Code включён ' + KEY + ' (по «да» человека)', tilde(file) + '#' + KEY);
}

function cmdRevert(yes) {
  const root = rootByScript();
  if (!root) die('revert запускается из главной папки. Ничего не изменено.', 3);
  const meta = (() => { try { return JSON.parse(fs.readFileSync(path.join(root, '.workplace', 'backup-update', 'vscode-last.json'), 'utf8')); } catch (_) { return null; } })();
  if (!meta) die('Нет записи о прежней правке (vscode-last.json): откатывать нечего. Ничего не изменено.', 3);
  const file = settingsPath();
  const cur = fs.existsSync(file) ? fs.readFileSync(file) : null;
  if (!cur || sha(cur) !== meta.after_sha) die('Файл настроек с тех пор менялся (сам VS Code или человек). Автоматический откат затёр бы эти изменения, поэтому я его не делаю. Уберите строку ' + KEY + ' руками. Ничего не изменено.', 3);
  if (!yes) { say('Файл ' + tilde(file) + ' вернётся к состоянию до apply' + (meta.existed ? '' : ' (до apply его не было: он будет удалён)') + '. Это только план: после «да» повторите с --yes.'); process.exitCode = 2; return; }
  requireHuman(root, 'revert');
  if (meta.existed) {
    const b = path.join(root, meta.backup);
    if (!fs.existsSync(b)) die('Копии ' + meta.backup + ' нет. Ничего не изменено.', 3);
    const tmp = file + '.tmp-' + process.pid;
    fs.copyFileSync(b, tmp); fs.renameSync(tmp, file);
  } else fs.unlinkSync(file);
  fs.unlinkSync(path.join(root, '.workplace', 'backup-update', 'vscode-last.json'));
  say('Готово: файл настроек возвращён к состоянию до apply.');
  logToState(root, 'модуль vscode: правка настроек VS Code откатана', null);
}

// «Да» человека для apply и revert: запись идёт в настройки VS Code вне главной папки. Флаг --yes «да» не доказывает (его ставит ИИ).
// Нужно: «да» в последнем сообщении человека и «VS Code» (или focus view) в двух последних сообщениях либо в принятом плане (wp.js consent plan).
// Сообщения пишет хук human-message в корне; ядро (core/lib/consent.js) лежит рядом с модулем. Нет записей или нет ядра: подтвердить нечем, запись не делается.
const VSCODE_NAMES = ['vs code', 'vscode', 'visual studio code', 'вс код', 'вскод', 'вс-код', 'focus view', 'focusview'];
function requireHuman(root, what) {
  const show = 'Покажите человеку, что изменится в настройках VS Code, и дождитесь его «да»; затем повторите команду. Один флаг --yes подтверждением не является.';
  let consent = null;
  try { consent = require(path.join(root, '.workplace', 'core', 'lib', 'consent.js')); } catch (_) { /* ядра рядом нет */ }
  if (!consent) die(what + ': рядом с модулем нет ядра (.workplace/core/lib/consent.js), сообщения человека проверить нечем. Запись не сделана. ' + show, 3);
  const res = consent.evaluate(root, null, { kind: 'target', targets: [{ kind: 'name', names: VSCODE_NAMES }] });
  if (res.ok) return;
  die(what + ': ' + (res.why === 'no-record'
    ? 'сторож не видит сообщений человека (хук human-message не подключён или не доверен; у Codex проекту нужно доверие, команда /hooks), подтвердить нечем. Попросите человека выполнить эту команду самому в терминале.'
    : res.why === 'no-yes'
      ? 'в последнем сообщении человека нет «да». ' + show
      : 'в двух последних сообщениях человека не названы VS Code или focus view, и принятого плана нет. ' + show + ' Чтобы одно «да» покрыло план: node .workplace/core/cli/wp.js consent plan "включаю focus view в настройках VS Code".') + ' Ничего не изменено.', 3);
}

// Запись в журнал установки через wp.js (если он рядом). Не получилось: сказать вслух, чтобы ИИ записал сам.
function logToState(root, text, declarePath) {
  const wp = path.join(root, '.workplace', 'core', 'cli', 'wp.js');
  if (!fs.existsSync(wp)) { say('Запишите в журнал сами: ' + text); return; }
  const run = (args) => cp.spawnSync(process.execPath, [wp, ...args], { cwd: root, encoding: 'utf8', timeout: 20000, windowsHide: true });
  if (declarePath && /^~\//.test(declarePath)) run(['state', 'declare', declarePath]);
  const r = run(['state', 'log', text]);
  if (r.status !== 0) say('В журнал записать не удалось. Запишите сами: ' + text);
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const yes = argv.includes('--yes');
  const extra = argv.slice(1).filter((a) => a !== '--yes');
  if (extra.length) die('Неизвестные параметры: ' + extra.join(' ') + '. Путей записи у этой команды нет. Ничего не изменено.', 2);
  if (cmd === 'status') return cmdStatus();
  if (cmd === 'apply') return cmdApply(yes);
  if (cmd === 'revert') return cmdRevert(yes);
  die('Команды: status, apply [--yes], revert [--yes].', 2);
}

if (require.main === module) main();
module.exports = { setFocusView, parseTop, stripJsonc, settingsPath, KEY };
