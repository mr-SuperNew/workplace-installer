#!/usr/bin/env node
'use strict';
// Проверки focus-view.js на фейковой домашней папке (WP_HOME) и фейковой главной папке во временной папке ОС. Настоящие настройки VS Code не читаются и не пишутся.
// Запуск: node modules/vscode/focus-view.test.js (временная папка: WP_TEST_TMP или папка ОС). Код выхода 1, если хоть одна проверка не прошла.
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');

const SRC = path.join(__dirname, 'focus-view.js');
const SB = fs.mkdtempSync(path.join(process.env.WP_TEST_TMP || os.tmpdir(), 'wp-vscode-'));
const HOME = path.join(SB, 'home');
const ROOT = path.join(SB, 'root');
process.env.WP_HOME = HOME;
const fv = require(SRC);
const SETTINGS = fv.settingsPath();

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('[ok] ' + name); } else { fail++; console.log('[НЕТ] ' + name + (extra ? '\n' + extra : '')); }
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
function put(text) { fs.mkdirSync(path.dirname(SETTINGS), { recursive: true }); fs.writeFileSync(SETTINGS, text); }
function get() { return fs.existsSync(SETTINGS) ? fs.readFileSync(SETTINGS, 'utf8') : null; }
function clean() { try { fs.rmSync(SETTINGS, { force: true }); } catch (_) { /* нет */ } }
function run(script, args) {
  const r = cp.spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: Object.assign({}, process.env, { WP_HOME: HOME }), timeout: 30000, windowsHide: true });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '', all: (r.stdout || '') + (r.stderr || '') };
}

// фейковая главная папка со скриптом на месте модуля
const inRoot = path.join(ROOT, '.workplace', 'modules', 'vscode', 'focus-view.js');
fs.mkdirSync(path.dirname(inRoot), { recursive: true });
fs.writeFileSync(path.join(ROOT, '.workplace', 'config.json'), '{}\n');
fs.copyFileSync(SRC, inRoot);
const R = (...a) => run(inRoot, a);
// ядро рядом с модулем, как в настоящей главной папке: «да» человека берётся из .workplace/human-messages.json (его пишет хук human-message; тут то же через consent.record)
const KIT = path.resolve(__dirname, '..', '..');
const coreLib = path.join(ROOT, '.workplace', 'core', 'lib');
for (const f of fs.readdirSync(path.join(KIT, 'core', 'lib'))) { fs.mkdirSync(coreLib, { recursive: true }); fs.copyFileSync(path.join(KIT, 'core', 'lib', f), path.join(coreLib, f)); }
const consent = require(path.join(coreLib, 'consent.js'));
const says = (text) => consent.record(ROOT, { prompt: text });

try {
  // 1. VS Code не запускался: папки настроек нет
  let r = R('apply', '--yes');
  ok('нет папки настроек VS Code: отказ (код 3), ничего не создано', r.code === 3 && !fs.existsSync(path.dirname(SETTINGS)), r.all);
  r = R('status');
  ok('status без папки настроек: код 0 и понятная фраза', r.code === 0 && /не запускался/.test(r.out), r.all);

  // 2. файл с комментариями, лишней запятой и чужими ключами
  const orig = '// мои настройки\n{\n    "editor.fontSize": 14, // размер\n    /* тема */\n    "workbench.colorTheme": "Default Dark+",\n    "files.exclude": { "claudeCode.focusView": false },\n}\n';
  put(orig);
  r = R('apply');
  ok('apply без --yes: только план, код 2, файл не изменён', r.code === 2 && get() === orig && /только план/.test(r.out), r.all);
  // флаг --yes «да» не доказывает: нужно сообщение человека, в котором есть «да» и названы VS Code или focus view
  r = R('apply', '--yes');
  ok('apply --yes без сообщений человека: отказ (код 3), файл не изменён, нет копии', r.code === 3 && get() === orig && /не видит сообщений человека/.test(r.all) && !fs.existsSync(path.join(ROOT, '.workplace', 'backup-update')), r.all);
  says('Привет, как дела'); says('да');
  r = R('apply', '--yes');
  ok('«да» есть, но ни VS Code, ни focus view человек не называл: отказ (код 3), файл не изменён', r.code === 3 && get() === orig && /не названы VS Code/.test(r.all), r.all);
  says('Включи focus view в VS Code');
  r = R('apply', '--yes');
  ok('просьба есть, «да» нет: отказ (код 3), файл не изменён', r.code === 3 && get() === orig && /нет «да»/.test(r.all), r.all);
  says('да');
  r = R('apply', '--yes');
  const after = get();
  ok('apply --yes: код 0', r.code === 0, r.all);
  ok('ключ добавлен верхнего уровня и равен true (вложенный одноимённый ключ не считается)', fv.parseTop(after).members.some((m) => m.key === 'claudeCode.focusView') && JSON.parse(fv.stripJsonc(after))['claudeCode.focusView'] === true);
  ok('комментарии и порядок других ключей сохранены', after.startsWith('// мои настройки\n{') && after.includes('// размер') && after.includes('/* тема */') && after.indexOf('editor.fontSize') < after.indexOf('workbench.colorTheme'));
  ok('чужие ключи не изменились', (() => { const a = JSON.parse(fv.stripJsonc(orig)), b = JSON.parse(fv.stripJsonc(after)); delete b['claudeCode.focusView']; return JSON.stringify(a) === JSON.stringify(b); })());
  const bdir = path.join(ROOT, '.workplace', 'backup-update');
  const last = path.join(bdir, 'vscode-last.json');
  ok('копия файла до записи лежит внутри главной папки и совпадает с исходным', fs.existsSync(last) && (() => { const m = JSON.parse(fs.readFileSync(last, 'utf8')); return fs.readFileSync(path.join(ROOT, m.backup), 'utf8') === orig; })());
  r = R('status');
  ok('status показывает true', /claudeCode\.focusView = true/.test(r.out), r.all);
  const shaAfter = sha(fs.readFileSync(SETTINGS));
  r = R('apply', '--yes');
  ok('повторный apply: уже true, файл не менялся', r.code === 0 && /уже true/.test(r.out) && sha(fs.readFileSync(SETTINGS)) === shaAfter, r.all);

  // 3. откат
  r = R('revert');
  ok('revert без --yes: план, код 2', r.code === 2 && get() === after, r.all);
  says('спасибо, посмотрю');
  r = R('revert', '--yes');
  ok('revert --yes после сообщения без «да»: отказ (код 3), файл не изменён', r.code === 3 && get() === after && /нет «да»/.test(r.all), r.all);
  says('да, откати настройку в VS Code');
  r = R('revert', '--yes');
  ok('revert --yes: файл вернулся к исходному байт в байт', r.code === 0 && get() === orig && !fs.existsSync(last), r.all);

  // 4. откат отказывает, если файл менялся после apply
  put(orig);
  R('apply', '--yes');
  fs.appendFileSync(SETTINGS, '\n// правка человека\n');
  const edited = get();
  r = R('revert', '--yes');
  ok('revert после чужой правки: отказ (код 3), правка человека на месте', r.code === 3 && get() === edited, r.all);

  // 5. значение false заменяется на true
  put('{\n  "claudeCode.focusView": false,\n  "a": 1\n}\n');
  r = R('apply', '--yes');
  ok('false заменяется на true, отступ и другие ключи целы', r.code === 0 && get() === '{\n  "claudeCode.focusView": true,\n  "a": 1\n}\n', get());

  // 6. пустой объект и пустой файл
  put('{}');
  r = R('apply', '--yes');
  ok('пустой объект: ключ добавлен, файл разбирается', r.code === 0 && JSON.parse(fv.stripJsonc(get()))['claudeCode.focusView'] === true && get() === '{\n    "claudeCode.focusView": true\n}', JSON.stringify(get()));
  clean(); put('');
  r = R('apply', '--yes');
  ok('пустой файл: создан объект с одним ключом', r.code === 0 && JSON.parse(get())['claudeCode.focusView'] === true, JSON.stringify(get()));
  clean();
  r = R('apply', '--yes');
  ok('файла нет, папка есть: файл создаётся', r.code === 0 && JSON.parse(get())['claudeCode.focusView'] === true, r.all);
  r = R('revert', '--yes');
  ok('revert для созданного файла удаляет его', r.code === 0 && !fs.existsSync(SETTINGS), r.all);

  // 7. CRLF и BOM
  put('﻿{\r\n    "a": 1\r\n}\r\n');
  r = R('apply', '--yes');
  const crlf = get();
  ok('CRLF и BOM сохранены, голых LF нет', r.code === 0 && crlf.charCodeAt(0) === 0xFEFF && !/[^\r]\n/.test(crlf) && JSON.parse(fv.stripJsonc(crlf.slice(1)))['claudeCode.focusView'] === true, JSON.stringify(crlf));

  // 8. файл без запятой после последнего значения и с комментарием в конце строки
  put('{\n    "a": 1 // последний\n}\n');
  r = R('apply', '--yes');
  ok('после последнего значения без запятой ставится запятая, комментарий цел', r.code === 0 && get().includes('// последний') && JSON.parse(fv.stripJsonc(get())).a === 1 && JSON.parse(fv.stripJsonc(get()))['claudeCode.focusView'] === true, get());

  // 9. битый файл не трогается
  const broken = '{\n  "a": 1,\n  "b": [1, 2\n}\n';
  put(broken);
  r = R('apply', '--yes');
  ok('битый файл настроек: отказ (код 3), файл не изменён', r.code === 3 && get() === broken, r.all);
  r = R('status');
  ok('status на битом файле: отказ, а не падение', r.code === 3 && /не разобран/.test(r.err), r.all);

  // 10. запуск из пакета: записи нет
  put('{\n  "a": 1\n}\n');
  const pkgRun = run(SRC, ['apply', '--yes']);
  ok('apply из пакета (не из главной папки): отказ (код 3), файл не изменён', pkgRun.code === 3 && get() === '{\n  "a": 1\n}\n', pkgRun.all);
  ok('status из пакета работает', run(SRC, ['status']).code === 0);

  // 11. лишние параметры и ссылка
  r = R('apply', '--file', 'x');
  ok('неизвестный параметр: отказ (код 2), путей записи нет', r.code === 2, r.all);
  if (process.platform !== 'win32') {
    const target = path.join(SB, 'elsewhere.json');
    fs.writeFileSync(target, '{}');
    fs.rmSync(SETTINGS, { force: true });
    fs.symlinkSync(target, SETTINGS);
    r = R('apply', '--yes');
    ok('файл настроек это ссылка: отказ (код 3), цель не изменена', r.code === 3 && fs.readFileSync(target, 'utf8') === '{}', r.all);
  }
} finally {
  try { fs.rmSync(SB, { recursive: true, force: true }); } catch (_) { /* не критично */ }
}
console.log('\nПройдено ' + pass + ', не прошло ' + fail + '.');
process.exit(fail ? 1 : 0);
