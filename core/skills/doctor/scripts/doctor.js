#!/usr/bin/env node
'use strict';
// Доктор рабочего места: ничего не чинит и ничего не пишет, только проверяет и называет команду починки для каждого «нет».
//   node doctor.js [--live] [--json]
// --live: разрешает `claude auth status` (команда создаёт файлы настроек, поэтому только после «да» человека). Вход в Codex проверяется всегда
// (`codex login status` файлов не создаёт). Вход определяется ответом провайдера (providers.loginStatus), а не `claude doctor`: тот отвечает кодом 0 и без входа.
// Проверяются оба ИИ независимо от того, какой основной: направление «основной делает, второй проверяет» и обратное.
// Код выхода: 0 всё в порядке; 1 есть провал обязательной проверки; 2 провалов нет, но часть проверок не выполнена («не проверено» не считается зелёным).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function findCore() {
  for (const c of [path.resolve(__dirname, '..', '..', '..'), path.resolve(__dirname, '..', '..', '..', '..', '.workplace', 'core')]) if (fs.existsSync(path.join(c, 'lib', 'root.js'))) return c;
  return null;
}
const CORE = findCore();
const fail = (m, code) => { process.stderr.write(m + '\n'); process.exit(code || 1); };
if (!CORE) fail('Не найдено ядро (.workplace/core). Запускай из главной папки: node .workplace/core/skills/doctor/scripts/doctor.js');
const flags = { live: false, json: false };
for (const a of process.argv.slice(2)) {
  if (a === '--live') flags.live = true; else if (a === '--json') flags.json = true;
  else fail('Неизвестный параметр ' + a + '. Есть: --live, --json. Доктор ничего не пишет.', 2);
}
const rootLib = require(path.join(CORE, 'lib', 'root.js'));
const root = rootLib.findRoot(__dirname);
if (!root) fail('Главная папка не найдена (нет метки .workplace/ над скриптом). Установка не начата или скрипт запущен не из неё.');
const u = require(path.join(CORE, 'lib', 'util.js'));
const config = require(path.join(CORE, 'lib', 'config.js'));
const checks = require(path.join(CORE, 'lib', 'checks.js'));
const layout = require(path.join(CORE, 'lib', 'layout.js'));
const providers = require(path.join(CORE, 'providers'));

const WP = 'node .workplace/core/cli/wp.js';
const ctx = checks.context(root, { live: flags.live });
const cfg = ctx.cfg;
const items = [];
// status: ok | fail | notchecked. required: обязательная проверка (провал = красное), иначе «по возможности».
function add(id, title, status, detail, o) { items.push(Object.assign({ id, title, status, detail, required: true, fix: null, needsYes: false }, o || {})); }
function fromCheck(id, title, o) {
  const r = checks.run(id, ctx);
  add(id, title, r.ok ? 'ok' : 'fail', r.detail, o);
}

// ---------- программы ----------
fromCheck('P1.node', 'Node 18 или новее', { fix: 'Node ставится до установщика: команды по системе в .workplace/docs/recon-without-node.md' });
fromCheck('P1.python', 'Python', { fix: WP + ' install python --yes --human-said "слова человека с «да»"', needsYes: true });
fromCheck('P1.git', 'git (желателен)', { required: false, fix: WP + ' install git --yes --human-said "слова человека с «да»"', needsYes: true });

// ---------- оба ИИ и оба направления ----------
const rows = [];
for (const name of providers.names) {
  const p = providers.get(name);
  const d = ctx.detect(name);
  const role = name === cfg.main ? 'основной' : name === cfg.reviewer ? 'проверяющий' : 'не назначен';
  let login;
  if (!d.console) login = { state: 'unavailable', detail: 'консольной команды ' + name + ' нет' };
  else if (name === 'claude' && !flags.live) login = { state: 'unchecked', detail: '`claude auth status` создаёт файлы: запускается только после «да» человека (--live); пассивный признак: ' + d.login_hint.state };
  else login = p.loginStatus({ confirmed: true, detect: d });
  rows.push({ name, label: p.label, role, installed: d.console, version: d.primary ? d.primary.version : null, extensionOnly: !d.console && !!d.extension, login });
  const mustExist = role !== 'не назначен';
  add('install.' + name, p.label + ' (' + role + '): консольная команда', d.console ? 'ok' : 'fail',
    d.console ? p.label + ' ' + d.primary.version : (d.extension ? 'консольной команды нет, есть только расширение VS Code ' + d.extension.version : 'не найден'),
    { required: mustExist, fix: WP + ' install ' + name + ' --yes --human-said "слова человека с «да»"', needsYes: true });
  const L = login.state;
  const st = L === 'ok' ? 'ok' : L === 'unchecked' ? 'notchecked' : 'fail';
  const how = name === 'codex' ? '`codex login` (или `codex login --device-auth`)' : '`claude` (откроется браузер)';
  add('login.' + name, p.label + ' (' + role + '): вход в аккаунт', st,
    L === 'ok' ? 'вход выполнен' + (login.method ? ' (' + login.method + ')' : '') : L === 'api-key' ? 'вход по ключу API: платный, для подписки не годится' : login.detail,
    { required: mustExist, fix: L === 'unchecked' ? 'после «да» человека: node .workplace/core/skills/doctor/scripts/doctor.js --live' : L === 'unavailable' ? 'сначала установить ' + p.label : 'вход делает человек сам в браузере: ' + how + '. Пароль не диктуется и не вводится за него' });
}
const mainRow = rows.find((r) => r.name === cfg.main), revRow = rows.find((r) => r.name === cfg.reviewer);
const revOk = (r) => r && r.installed && r.login.state === 'ok';
const dirOk = revOk(mainRow) && revOk(revRow);
const dirUnknown = !dirOk && [mainRow, revRow].every((r) => r.installed && ['ok', 'unchecked'].includes(r.login.state));
add('direction', 'Направление: ' + mainRow.label + ' делает, ' + revRow.label + ' проверяет', dirOk ? 'ok' : dirUnknown ? 'notchecked' : 'fail',
  dirOk ? 'оба ИИ стоят и вошли' : dirUnknown ? 'оба ИИ стоят, вход не подтверждён' : 'не хватает: ' + [mainRow, revRow].filter((r) => !revOk(r) && r.login.state !== 'unchecked').map((r) => r.label).join(', '),
  { fix: 'см. строки выше' });
add('direction.reverse', 'Обратное направление: ' + revRow.label + ' делает, ' + mainRow.label + ' проверяет', 'ok',
  dirOk ? 'возможно (поменять роли: ' + WP + ' config set main ' + cfg.reviewer + ')' : dirUnknown ? 'возможно, если вход подтвердится (см. строки о входе)' : 'пока невозможно: нужны оба ИИ и вход в оба (информация, не ошибка)', { required: false });

// ---------- структура, сторожа, навыки ----------
fromCheck('P2.core', 'Правила, память, настройки, навыки', { fix: WP + ' layout' });
fromCheck('P2.hooks', 'Сторожа подключены в оба ИИ', { fix: WP + ' hooks wire' });
fromCheck('P3.hooks-test', 'Сторожа отвечают на тестовый ввод', { fix: WP + ' hooks test (покажет, какой сторож ответил не так); при поломке файла: ' + WP + ' layout --update' });

function skillIntegrity() {
  const src = path.join(root, '.workplace', 'core', 'skills');
  const names = (u.listDir(src) || []).filter((n) => u.isDir(path.join(src, n)));
  const bad = [];
  const want = ['cross-check', 'end-session', 'new-workspace', 'doctor'];
  for (const w of want) if (!names.includes(w)) bad.push('нет навыка ' + w + ' в пакете');
  const walk = (d, rel) => (fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name), rel + e.name + '/') : [rel + e.name])));
  const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  for (const n of names) {
    for (const f of walk(path.join(src, n), '')) {
      for (const base of [path.join(root, '.claude', 'skills'), path.join(root, '.agents', 'skills')]) {
        const dst = path.join(base, n, f);
        const tag = path.relative(root, base).split(path.sep)[0];
        if (!u.exists(dst)) bad.push(tag + '/skills/' + n + '/' + f + ' отсутствует');
        else if (sha(dst) !== sha(path.join(src, n, f))) bad.push(tag + '/skills/' + n + '/' + f + ' отличается от пакета');
      }
    }
  }
  return { ok: !bad.length, detail: bad.length ? bad.slice(0, 6).join('; ') + (bad.length > 6 ? ' (и ещё ' + (bad.length - 6) + ')' : '') : 'навыки ' + names.join(', ') + ': одинаковы в .claude/skills и .agents/skills' };
}
let si; try { si = skillIntegrity(); } catch (e) { si = { ok: false, detail: 'ошибка проверки: ' + e.message }; }
add('skills', 'Навыки одинаковы для обоих ИИ', si.ok ? 'ok' : 'fail', si.detail, { fix: WP + ' layout --update (после «да»: заменит копии навыков копиями из пакета; правки человека в самих навыках затрутся, копия прежнего файла ляжет в .workplace/backups)', needsYes: true });

const bad = config.validate(cfg);
add('config', 'config.json (main, reviewer, сторожа)', bad.length ? 'fail' : 'ok', bad.length ? bad.join('; ') : 'main ' + cfg.main + ', reviewer ' + cfg.reviewer + ', модель проверяющего ' + (cfg.reviewer_model || 'по умолчанию'), { fix: WP + ' config validate' });

// ---------- тест вшитой ошибки ----------
fromCheck('P3.selftest', 'Самопроверка кросс-проверки (вшитая ошибка: верная копия GREEN, ошибочная RED)', { fix: 'после «да» (два запуска проверяющего тратят его лимит): node .workplace/core/skills/cross-check/scripts/selftest-run.js', needsYes: true });
fromCheck('P2.git', 'История изменений главной папки (git)', { required: false, fix: WP + ' git-init' });

// ---------- итог ----------
const req = items.filter((i) => i.required);
const nFail = req.filter((i) => i.status === 'fail').length;
const nNot = req.filter((i) => i.status === 'notchecked').length;
const exit = nFail ? 1 : nNot ? 2 : 0;
const summary = { required: req.length, ok: req.filter((i) => i.status === 'ok').length, fail: nFail, notchecked: nNot, exit };
if (flags.json) {
  process.stdout.write(JSON.stringify({ main: cfg.main, reviewer: cfg.reviewer, providers: rows.map((r) => ({ name: r.name, role: r.role, installed: r.installed, version: r.version, login: r.login.state })), items, summary }, null, 2) + '\n');
} else {
  const tag = { ok: 'ок', fail: 'НЕТ', notchecked: 'не проверено' };
  process.stdout.write('Проверка рабочего места: ' + u.tilde(root) + '\n');
  for (const i of items) {
    process.stdout.write('[' + tag[i.status] + (i.required ? '' : ', по возможности') + '] ' + i.title + ': ' + i.detail + '\n');
    if (i.status !== 'ok' && i.fix) process.stdout.write('    починка: ' + i.fix + (i.needsYes ? ' (только после «да»)' : '') + '\n');
  }
  process.stdout.write('Итог: обязательных ' + summary.required + ', в порядке ' + summary.ok + ', провалено ' + nFail + ', не проверено ' + nNot + '. ' +
    (exit === 0 ? 'Всё в порядке.' : exit === 1 ? 'Есть что чинить.' : 'Провалов нет, но не всё проверено: зелёным это не считается.') + '\n');
}
process.exit(exit);
