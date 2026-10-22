#!/usr/bin/env node
'use strict';
// wp.js - помощник установки рабочего места v4. Только встроенные модули Node 18+. Работает на Mac и Windows.
// Основа - setup.js и recon.js из v3. Различие: установка недостающего есть (после «да»), оба ИИ (Claude Code и Codex) симметричны.
//
// Без главной папки (из пакета или из любой папки):
//   recon [--json] [--no-scan] [--scan папки] [--plan-only]   разведка: ТОЛЬКО ЧТЕНИЕ, определяет случай, ничего не пишет
//   plan [--main claude|codex] [--reviewer ...] [--json]      план установки по разведке (ничего не выполняет)
//   init --root <папка> [--main claude|codex] [--reviewer ...] [--reviewer-model M] [--instruction файл] [--no-scan]
//                                                             (только из пакета; папка нет или пуста, иначе отказ) создать главную папку
//   update plan|apply --root <папка> [--yes] [--overwrite путь,путь]   (только из нового пакета) обновить установленное; apply берёт «да» из записанных сообщений человека (--yes его не заменяет), --overwrite требует, чтобы человек назвал файлы
// Из главной папки (node .workplace/core/cli/wp.js ...):
//   install claude|codex|python|git --yes [--human-said "слова человека"] [--npm] [--dry-run]   поставить недостающее после «да» человека (--yes сам «да» не доказывает: см. install.js, requireHuman)
//   path-fix [--yes] [--human-said "слова"] [--dry-run]       Mac и Linux: дописать строку PATH в профиль оболочки, если установленная программа не видна в новом окне (только с «да», запись объявляется)
//   layout [--update]                  раскладка правил, памяти, навыков (чужое не перезаписывается)
//   hooks status|wire|test [--dry-run] подключение сторожей в .claude/settings.json и .codex/hooks.json
//   config show|get <ключ>|set <ключ> <значение>|validate
//   gitignore check|append [--dry-run] ; git-init [--name Имя --email адрес]
//   state show|next|set <этап> <статус> [--action present|installed|manual|created] [--note текст]
//   state log "текст" | manual "текст" | note "текст" [--stage этап] | choice <ключ> <значение> | get <ключ> | declare <путь[#ключ]> | wait begin|end | timing
//   snapshot before|after|diff [--force] [--json] [--live]    файлы вне главной папки до и после, три класса записей
//   verify [этап ...|all] [--live]     проверки этапов, код выхода 1 при провале (all не включает P5.report: отчёт пишет report, его проверка: verify P5.report)
//   report [--live]                    собрать install-report.md
//   new-workspace <имя|название> [--title ... --goal ...]
//   module add <папка модуля>
//   consent plan "текст" | status      план, который ты показал человеку (сторож засчитает его «да» как ответ на этот план); что сторож видит из сообщений человека
//   adopt <путь> [--name имя] [--dry-run]   принять проект человека: лежит в главной папке — копия, вложенный .git в .gitignore; лежит снаружи — копия с историей через migrate-project
//   role set <claude|codex> [--reviewer-model M] [--no-selftest] [--selftest-timeout сек]   сменить основного ИИ одним шагом: настройки, роли в AGENTS.md, навыки, сторожа, самопроверка
//   delegate [--to codex] [--dir папка] (--task-file файл | текст задания)   отдать задачу другому ИИ на исполнение (Codex: codex exec --sandbox workspace-write); итог в .workplace/delegate/
//   backup <файл|папка>                копия перед правкой в .workplace/backups/ (файл: список index.jsonl; папка: без тяжёлых папок, до 500 МБ); исходник не меняется
//   gitignore nested [--dry-run]       закрыть в .gitignore главной папки вложенные репозитории по любому пути
// Коды выхода: 0 готово; 1 ошибка или провал проверки; 2 неверные параметры или есть расхождения; 3 отказ (чужая папка, запись вне корня); 4 нужны имя и почта git; 5 Node старше 18; 6 git недоступен.
if (parseInt(process.versions.node, 10) < 18) {
  process.stderr.write('Нужен Node 18 или новее (сейчас ' + process.version + '). Скрипты на Node, поэтому сначала Node: команды для вашей системы в docs/recon-without-node.md. Установка остановлена.\n');
  process.exit(5);
}
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const lib = path.join(__dirname, '..', 'lib');
const u = require(path.join(lib, 'util'));
const rootLib = require(path.join(lib, 'root'));
const config = require(path.join(lib, 'config'));
const state = require(path.join(lib, 'state'));
const recon = require(path.join(lib, 'recon'));
const plan = require(path.join(lib, 'plan'));
const layout = require(path.join(lib, 'layout'));
const snapshot = require(path.join(lib, 'snapshot'));
const checks = require(path.join(lib, 'checks'));
const report = require(path.join(lib, 'report'));
const update = require(path.join(lib, 'update'));
const install = require(path.join(lib, 'install'));
const { makeGuard } = require(path.join(lib, 'fsguard'));
const consent = require(path.join(lib, 'consent'));
const adoptLib = require(path.join(lib, 'adopt'));
const backupLib = require(path.join(lib, 'backup'));
const roles = require(path.join(lib, 'roles'));
const providers = require(path.join(__dirname, '..', 'providers'));

const BOOL = new Set(['json', 'no-scan', 'plan-only', 'yes', 'live', 'force', 'dry-run', 'update', 'npm', 'no-selftest']);
const VALUE = new Set(['root', 'main', 'reviewer', 'reviewer-model', 'name', 'email', 'title', 'goal', 'action', 'note', 'overwrite', 'scan', 'instruction', 'stage', 'to', 'dir', 'task-file', 'selftest-timeout', 'human-said']);
const argv = process.argv.slice(2);
const flags = {};
const pos = [];

function say(s) { process.stdout.write(s + '\n'); }
function fail(msg, code) { throw new u.WpError(msg, code || 1); }

const KIT = path.resolve(__dirname, '..', '..');            // пакет: <пакет>/ или <корень>/.workplace/
const INSTALLED = path.basename(KIT) === rootLib.MARK;
const ROOT_CMDS = new Set(['install', 'path-fix', 'layout', 'hooks', 'config', 'gitignore', 'git-init', 'state', 'snapshot', 'verify', 'report', 'new-workspace', 'module', 'consent', 'adopt', 'role', 'delegate', 'backup']);
let ROOT = null;

function parse() {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const k = a.slice(2);
    if (BOOL.has(k)) flags[k] = true;
    else if (VALUE.has(k)) {
      if (i + 1 >= argv.length) fail('У параметра --' + k + ' нет значения.', 2);
      flags[k] = argv[++i];
    } else fail('Неизвестный параметр ' + a + '. Путей записи у wp.js нет (главную папку задают только init и update через --root). Ничего не сделано.', 2);
  }
}
function needRoot(cmd) {
  if (Object.prototype.hasOwnProperty.call(flags, 'root')) fail('--root принимают только init и update. Остальные команды работают в главной папке, где лежит этот скрипт (<папка>/.workplace/core/cli/wp.js). Ничего не сделано.', 3);
  if (!INSTALLED) fail('Команда ' + cmd + ' запускается только из главной папки: <папка>/.workplace/core/cli/wp.js (папку создаёт init). Из пакета она не работает. Ничего не сделано.', 3);
  ROOT = path.dirname(KIT);
  if (!rootLib.isRoot(ROOT)) fail('В ' + ROOT + ' нет .workplace/config.json или state.json: это не главная папка. Ничего не записано.', 3);
}
function autoStage(id, detailOk) {
  const ctx = checks.context(ROOT, {});
  const r = checks.run(id, ctx);
  if (!r.ok) return r;
  const s = state.need(ROOT);
  if (s.stages[id] && s.stages[id].status !== 'done') { state.setStage(s, id, 'done', 'created', detailOk || r.detail); state.save(ROOT, s); }
  return r;
}

// ---------- recon / plan ----------
function cmdRecon() {
  const r = recon.collect({ scan: !flags['no-scan'], extraScan: flags.scan ? flags.scan.split(',') : [] });
  if (flags.json) process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  else if (flags['plan-only']) { for (const x of r.plan) say(x.item + ': ' + x.state + ': ' + x.action); }
  else say(recon.md(r));
}
function cmdPlan() {
  const r = recon.collect({ scan: false });
  const o = { main: flags.main, reviewer: flags.reviewer, root: INSTALLED ? path.dirname(KIT) : null };
  if (flags.main && !config.PROVIDERS.includes(flags.main)) fail('--main: claude или codex.', 2);
  if (flags.reviewer && !config.PROVIDERS.includes(flags.reviewer)) fail('--reviewer: claude или codex.', 2);
  if (INSTALLED && !flags.main) { const c = config.load(o.root); o.main = c.main; o.reviewer = c.reviewer; }
  const pl = plan.buildPlan(r, o);
  if (flags.json) process.stdout.write(JSON.stringify(pl, null, 2) + '\n');
  else say(plan.render(pl));
}

// ---------- init ----------
function cmdInit() {
  if (INSTALLED) fail('init запускается только из пакета (распакованный архив): node <пакет>/core/cli/wp.js init --root <новая папка>. Скрипт из <папка>/.workplace продолжает начатую установку (state next), папку он не создаёт. Ничего не сделано.', 3);
  if (!flags.root) fail('Нужен --root <новая папка>.', 2);
  const root = path.resolve(flags.root);
  const refusal = layout.rootRefusal(root);
  if (refusal) fail(refusal, 3);
  const r = recon.collect({ scan: !flags['no-scan'] });
  const main = flags.main || r.case.suggested.main;
  if (!config.PROVIDERS.includes(main)) fail('--main: claude или codex.', 2);
  const reviewer = flags.reviewer || config.other(main);
  const pl = plan.buildPlan(r, { main, reviewer, root });
  const res = layout.init({ root, kit: KIT, main, reviewer, reviewerModel: flags['reviewer-model'] || null, recon: r, plan: pl, instruction: flags.instruction });
  // файлы пакета (.workplace/core, modules) одной строкой, остальное по именам
  const pkg = res.report.filter(([, p]) => /^\.workplace\/(core|modules|docs)\//.test(p));
  for (const [st, p] of res.report) if (!/^\.workplace\/(core|modules|docs)\//.test(p)) say(st + ': ' + p);
  say('создан: пакет в .workplace (core, modules, docs; файлов ' + pkg.length + ')');
  for (const w of res.warnings) say('Предупреждение: ' + w);
  let snapOk = true;
  try { snapshot.take(root, 'before'); say('создан: .workplace/snapshots/before.json (снимок файлов вне главной папки «до»; хеши, копии несекретных настроек лежат в .workplace/snapshots, она закрыта в .gitignore)'); } catch (e) {
    snapOk = false;
    say('ВНИМАНИЕ: снимок «до» НЕ снят (' + e.message + '). Без него итоговая сверка файлов вне главной папки невозможна. Повтори: node .workplace/core/cli/wp.js snapshot before, и скажи об этом человеку.');
    try { const s0 = state.need(root); state.addNote(s0, 'снимок «до» не снят при init: ' + e.message + '; повторить snapshot before', 'P1.root'); state.save(root, s0); state.log(root, 'снимок «до» не снят: ' + e.message); } catch (_) { /* журнал недоступен: сообщение выше уже показано */ }
  }
  say('Направление: основной ' + main + ', проверяет ' + reviewer + (flags.main ? '' : ' (предложено разведкой, случай: ' + r.case.id + ')') + '.');
  say('Главная папка: ' + root);
  say(snapOk ? 'Дальше из неё: node .workplace/core/cli/wp.js state next' : 'Сначала снимок «до» (см. ВНИМАНИЕ выше), потом: node .workplace/core/cli/wp.js state next');
}

// ---------- state ----------
function cmdState() {
  const sub = pos[1];
  const s = state.need(ROOT);
  if (sub === 'show') {
    for (const [id] of state.STAGES) { const x = s.stages[id]; say(String(x.status).padEnd(14) + ' ' + id.padEnd(18) + ' ' + (x.title || '') + (x.action ? ' [' + x.action + ']' : '') + (x.note ? ': ' + x.note : '')); }
    const t = state.timingSummary(s);
    say('Время: всего ' + t.total_min + ' мин, без ожиданий человека ' + t.without_waits_min + ' мин.');
    return;
  }
  if (sub === 'next') { const n = state.next(s); say(n ? n.id + ': ' + n.title + ' (' + n.status + ')' + (n.note ? ' - ' + n.note : '') : 'Все этапы завершены, пропущены или по выбору.'); return; }
  if (sub === 'set') {
    const id = pos[2], status = pos[3];
    state.setStage(s, id, status, flags.action, flags.note);
    state.save(ROOT, s);
    state.log(ROOT, id + ': ' + status + (flags.action ? ' (' + flags.action + ')' : '') + (flags.note ? ' - ' + flags.note : ''));
    say(id + ': ' + status);
    return;
  }
  if (sub === 'log') { const t = pos.slice(2).join(' '); if (!t) fail('Нужен текст.', 2); state.log(ROOT, t); say('записано в STATE.md'); return; }
  if (sub === 'manual' || sub === 'note') {
    const t = pos.slice(2).join(' ');
    if (!t) fail('Нужен текст.', 2);
    if (sub === 'manual') state.addManual(s, t); else state.addNote(s, t, flags.stage);
    state.save(ROOT, s);
    state.log(ROOT, (sub === 'manual' ? 'руками: ' : 'замечание: ') + t);
    say('записано (' + sub + ')');
    return;
  }
  if (sub === 'choice') { s.choices[pos[2]] = pos[3] === undefined ? true : (pos[3] === 'true' ? true : pos[3] === 'false' ? false : pos[3]); state.save(ROOT, s); say('выбор ' + pos[2] + ' = ' + s.choices[pos[2]]); return; }
  if (sub === 'get') { const v = s.choices[pos[2]]; say(v === undefined ? '' : String(v)); return; }
  if (sub === 'declare') {
    const t = pos[2];
    if (!t || !/^~\//.test(t)) fail('Путь вида ~/файл: запись вне главной папки, о которой человеку сказали заранее.', 2);
    if (!s.declared.includes(t)) s.declared.push(t);
    state.save(ROOT, s); state.log(ROOT, 'объявлена запись вне главной папки: ' + t); say('объявлено: ' + t); return;
  }
  if (sub === 'wait') {
    if (pos[2] === 'begin') state.waitBegin(s); else if (pos[2] === 'end') state.waitEnd(s); else fail('state wait begin|end', 2);
    state.save(ROOT, s); say('ожидание человека: ' + pos[2]); return;
  }
  if (sub === 'timing') { const t = state.timingSummary(s); say('всего ' + t.total_min + ' мин; без ожиданий ' + t.without_waits_min + ' мин; ожидание ' + t.wait_min + ' мин'); return; }
  fail('state show | next | set <этап> <статус> | log | manual | note | choice | get | declare | wait begin|end | timing', 2);
}

// ---------- layout / hooks / config / git ----------
function cmdLayout() {
  const rep = layout.layout(ROOT, { update: !!flags.update });
  for (const [st, p] of rep) say(st + ': ' + p);
  if (rep.some(([st]) => /^ОТЛИЧАЕТСЯ/.test(st))) { say('Есть расхождения: покажи их человеку, не перезаписывай без его «да» (пакет и навыки обновляет layout --update).'); process.exitCode = 2; }
  const r = autoStage('P2.core', 'файлы раскладки на месте');
  state.log(ROOT, 'раскладка: ' + (r.ok ? 'готово' : r.detail));
  say('Дальше: node .workplace/core/cli/wp.js hooks wire');
}
function cmdHooks() {
  const sub = pos[1] || 'status';
  if (sub === 'wire') {
    const r = layout.wireHooks(ROOT, { dryRun: !!flags['dry-run'] });
    const f = (x) => 'добавлено хуков ' + x.stat.added + ', обновлено ' + x.stat.updated + ', убрано устаревших ' + x.stat.removed + (x.stat.perms !== undefined ? ', разрешений ' + x.stat.perms : '') + (x.backup ? ' (копия прежнего файла: ' + path.basename(x.backup) + ')' : '');
    say('.claude/settings.json: ' + f(r.claude));
    say('.codex/hooks.json: ' + f(r.codex));
    if (r.missing.length) say('Нет в пакете (пропущены): ' + r.missing.join(', '));
    say('Хуки Claude Code подхватываются без перезапуска (в -p проверено); в VS Code на всякий случай «Перезагрузить окно». Хуки Codex грузятся из .codex/hooks.json только в доверенном проекте с .git в корне; постоянное доверие даёт человек командой /hooks в Codex (разовый шаг).');
    if (!flags['dry-run']) { const c = autoStage('P2.hooks', 'сторожа подключены'); state.log(ROOT, 'сторожа подключены' + (c.ok ? '' : ': ' + c.detail)); }
    return;
  }
  if (sub === 'status') {
    const rows = layout.hooksStatus(ROOT);
    for (const x of rows) say((x.present ? 'есть   ' : 'НЕТ    ') + x.hook.padEnd(36) + ' синтаксис ' + (x.syntax === null ? '?' : x.syntax ? 'ок' : 'ОШИБКА') + '; Claude: ' + (x.claude.wanted ? (x.claude.wired ? 'подключён' : 'не подключён') : '-') + '; Codex: ' + (x.codex.wanted ? (x.codex.wired ? 'подключён' : 'не подключён') : '-'));
    if (rows.some((x) => !x.present || x.syntax === false)) process.exitCode = 1;
    return;
  }
  if (sub === 'test') {
    const r = layout.hooksTest(ROOT);
    say('Проверено хуков: ' + r.checked);
    if (r.bad.length) { r.bad.forEach((b) => say('НЕТ: ' + b)); process.exitCode = 1; return; }
    say('Все отвечают как положено.');
    const s = state.need(ROOT); state.setStage(s, 'P3.hooks-test', 'done', 'created', 'сторожа отвечают'); state.save(ROOT, s);
    return;
  }
  fail('hooks status | wire [--dry-run] | test', 2);
}
function cmdConfig() {
  const sub = pos[1] || 'show';
  const cfg = config.load(ROOT);
  if (sub === 'show') { process.stdout.write(JSON.stringify(config.strip(cfg), null, 2) + '\n'); return; }
  if (sub === 'get') { const v = config.get(cfg, pos[2]); say(v === undefined ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v))); return; }
  if (sub === 'validate') { const b = config.validate(cfg); say(b.length ? 'НЕТ: ' + b.join('; ') : 'config.json верен'); if (b.length) process.exitCode = 1; return; }
  if (sub === 'set') {
    const k = pos[2], v = pos.slice(3).join(' ');
    if (!k || v === '') fail('config set <ключ> <значение>', 2);
    // выключить сторожа секретов, опасных команд или кросс-проверки можно только по «да» человека (иначе это обход подтверждения)
    if (/^guards\.(secret_guard|danger_guard|cross_check_guard)$/.test(k) && /^(false|0|off)$/i.test(v)) {
      const res = consent.evaluate(ROOT, null, { kind: 'yes', targets: [] });
      if (!res.ok) fail('Сторожа выключает человек: ' + (res.why === 'no-record' ? 'подтвердить нечем (хук human-message не подключён или не доверен), пусть сделает сам: node .workplace/core/cli/wp.js config set ' + k + ' false.' : 'в последнем сообщении человека нет «да». Объясни ему, что именно перестанет проверяться, спроси «да» и повтори.'), 3);
    }
    const c = config.strip(cfg);
    config.set(c, k, v);
    if (k === 'main') c.reviewer = config.other(c.main);   // направление меняется целиком: проверяет всегда другой ИИ
    config.save(ROOT, c);
    state.log(ROOT, 'настройка ' + k + ' изменена');
    say(k + ' = ' + JSON.stringify(config.get(c, k)) + (k === 'main' ? '; проверяет теперь ' + c.reviewer + ' (смена основного ИИ целиком, с правилами, навыками, сторожами и самопроверкой: role set ' + c.main + ')' : ''));
    return;
  }
  fail('config show | get <ключ> | set <ключ> <значение> | validate', 2);
}
function cmdGitignore() {
  const sub = pos[1];
  const g = makeGuard(ROOT);
  if (sub === 'check') {
    const miss = layout.gitignoreMissing(ROOT);
    say(miss.length ? 'В .gitignore не хватает строк:\n' + miss.map((l) => '  ' + l).join('\n') : '.gitignore содержит все нужные строки.');
    const gs = recon.gitStatus();
    if (u.exists(path.join(ROOT, '.git')) && gs.ok) {
      const bad = layout.GI_PROBES.filter((f) => !u.run(gs.path, ['-C', ROOT, 'check-ignore', '-q', f]).ok);
      say(bad.length ? 'git НЕ игнорирует: ' + bad.join(', ') : 'git игнорирует все служебные пути (проверено через git check-ignore).');
      if (bad.length) process.exitCode = 1;
    }
    const nest = adoptLib.gitignoreNested(ROOT, { dryRun: true });
    if (nest.added.length) { say('Вложенные репозитории не закрыты в .gitignore: ' + nest.added.join(', ') + ' (закрыть: gitignore nested)'); process.exitCode = 1; }
    else if (nest.repos.length) say('Вложенные репозитории закрыты в .gitignore: ' + nest.repos.join(', '));
    return;
  }
  if (sub === 'nested') {
    const r = adoptLib.gitignoreNested(ROOT, { dryRun: !!flags['dry-run'] });
    if (r.added.length) say((flags['dry-run'] ? 'Добавил бы в .gitignore: ' : 'Добавлено в .gitignore: ') + r.added.map(adoptLib.giLine).join(', '));
    if (r.already.length) say('Уже закрыто: ' + r.already.join(', '));
    if (!r.repos.length) say('Вложенных репозиториев (папок со своим .git) в главной папке нет.');
    return;
  }
  if (sub === 'append') { say(layout.gitignoreAppend(g, ROOT, !!flags['dry-run']).text); return; }
  fail('gitignore check | append [--dry-run] | nested [--dry-run]', 2);
}
function cmdGitInit() {
  for (const l of layout.gitInit(ROOT, { name: flags.name, email: flags.email })) say(l);
  autoStage('P2.git', 'git главной папки');
  state.log(ROOT, 'git главной папки готов');
}

// ---------- snapshot ----------
function cmdSnapshot() {
  const sub = pos[1];
  const s = state.need(ROOT);
  if (sub === 'before') {
    if (snapshot.load(ROOT, 'before') && !flags.force) { say('Снимок «до» уже есть (' + snapshot.load(ROOT, 'before').taken + '): повторно не снимаю. Принудительно: --force.'); return; }
    const sn = snapshot.take(ROOT, 'before');
    say('Снимок «до» снят: ' + sn.taken + '. Файлов найдено: ' + Object.values(sn.files).filter((x) => x.exists).length + '; копий несекретных файлов: ' + Object.values(sn.files).filter((x) => x.backup).length + '; секретные и похожие на них только по хешу.');
    return;
  }
  if (sub === 'after') { const sn = snapshot.take(ROOT, 'after'); say('Снимок «после» снят: ' + sn.taken + '. Сравнить: snapshot diff'); return; }
  if (sub === 'diff') {
    const b = snapshot.load(ROOT, 'before');
    if (!b) fail('Нет снимка «до»: сначала snapshot before.', 2);
    const a = (!flags.live && snapshot.load(ROOT, 'after')) || snapshot.scan(null);
    const d = snapshot.diff(b, a, { declared: s.declared, installs: s.installs.length });
    if (flags.json) process.stdout.write(JSON.stringify({ before: b.taken, after: a.taken, alarm: d.alarm, classes: d.classes }, null, 2) + '\n');
    else say(snapshot.renderDiff(d, b.taken));
    if (d.alarm) process.exitCode = 1;
    return;
  }
  fail('snapshot before | after | diff [--json] [--live] [--force]', 2);
}

// ---------- verify / report ----------
function cmdVerify() {
  const all = !(pos.length > 1 && pos[1] !== 'all');
  // P5.report появляется только после `report`: в `verify all` он не входит (иначе шаг отчёта всегда начинался бы с красного); проверить его можно явно: verify P5.report
  const list = all ? state.STAGE_IDS.filter((id) => id !== 'P5.report') : pos.slice(1);
  const s = state.load(ROOT);
  const ctx = checks.context(ROOT, { live: !!flags.live });
  let fail_ = 0;
  for (const id of list) {
    const r = checks.run(id, ctx);
    const x = s && s.stages[id];
    const waiting = x && ['needs-install', 'needs-human'].includes(x.status);
    const optional = x && ['optional', 'skipped'].includes(x.status);
    const tag = r.ok ? 'ok' : (waiting ? (x.status === 'needs-install' ? 'ждёт да' : 'ждёт человека') : (optional ? 'по выбору' : 'НЕТ'));
    say('[' + tag + '] ' + id + ': ' + r.detail);
    if (!r.ok && !waiting && !optional) fail_++;
    if (s) { s.last_checks[id] = { ok: r.ok, detail: r.detail, at: new Date().toISOString(), live: !!flags.live }; }
  }
  if (s) state.save(ROOT, s);
  if (all) say('(P5.report в all не входит: отчёт пишет report, его проверка: verify P5.report)');
  if (fail_) process.exitCode = 1;
}
function cmdReport() {
  const r = report.write(ROOT, { live: !!flags.live });
  say('Отчёт записан: ' + path.relative(ROOT, r.file).split(path.sep).join('/'));
  if (r.problems.length) { say('В отчёте остались личные данные: ' + r.problems.join('; ') + '. Не пересылай, покажи человеку.'); process.exitCode = 1; }
}

// ---------- прочее ----------
function cmdNewWorkspace() {
  const r = layout.newWorkspace(ROOT, pos.slice(1).join(' '), { title: flags.title, goal: flags.goal });
  say('Создана папка: workspaces/' + r.slug + ' (AGENTS.md, CLAUDE.md, tasks.md, MEMORY.md, handoffs/, data/, out/)');
  if (r.similar.length) say('Рядом есть похожие папки: ' + r.similar.join(', ') + ' (проверь, не та же ли это задача).');
  say(r.how);
}
function cmdModule() {
  if (pos[1] !== 'add' || !pos[2]) fail('module add <папка модуля>', 2);
  const r = layout.moduleAdd(ROOT, pos[2]);
  for (const [k, v] of r.report) say(k + ': ' + v);
}
// ---------- подтверждение, проекты, роли, задачи другому ИИ ----------
function cmdConsent() {
  const sub = pos[1];
  if (sub === 'plan') {
    const text = pos.slice(2).join(' ');
    const r = consent.registerPlan(ROOT, text);
    say('План записан (' + r.at + '). Покажи человеку этот же текст простыми словами и спроси «да»: сторож засчитает его «да» как ответ именно на этот план (цели из плана считаются названными). Если человек напишет что-то другое, план перестанет действовать.');
    return;
  }
  if (sub === 'status') {
    const recs = consent.recent(ROOT, null, 2);
    if (!recs.length) { say('Сообщений человека нет: хук human-message не подключён или не доверен (hooks status; у Codex доверие даёт человек командой /hooks). Подтвердить нечем: действия, которым нужно «да», делает сам человек.'); return; }
    const last = recs[recs.length - 1];
    say('Последнее сообщение человека (' + last.at + '): «' + String(last.text).replace(/\s+/g, ' ').slice(0, 80) + '»; «да»: ' + (consent.isYes(last.text) ? 'есть' : 'нет'));
    const pl = consent.approvedPlan(ROOT, null);
    say(pl ? 'План, на который человек ответил «да», есть (' + pl.at + ').' : 'Принятого плана нет.');
    return;
  }
  fail('consent plan "текст" | status', 2);
}
function cmdBackup() {
  if (!pos[1]) fail('backup <файл или папка>: копия перед правкой лежит в .workplace/backups/.', 2);
  const abs = path.resolve(pos[1]);
  if (!u.exists(abs)) { say('Нечего копировать: ' + u.tilde(abs) + ' нет (файл будет создан заново). Копия не нужна.'); return; }
  if (u.isDir(abs)) {
    const r = backupLib.backupDir(ROOT, abs, null);
    if (r.made) say('Копия папки ' + u.tilde(abs) + ': ' + r.dir + ' (файлов ' + r.files + (r.skipped.length ? '; тяжёлые папки не копировались: ' + r.skipped.join(', ') : '') + ').');
    else { say('НЕТ: копия папки не сделана (' + (r.reason || 'ошибка') + '). Сделай обычное копирование или скажи человеку.'); process.exitCode = 1; }
    return;
  }
  const r = backupLib.backupFile(ROOT, abs);
  if (r.made) say('Копия файла ' + u.tilde(abs) + ': ' + r.file);
  else if (r.file) say('Такая копия уже есть: ' + r.file);
  else { say('НЕТ: копия не сделана (' + (r.error || r.reason) + ').'); process.exitCode = 1; }
}
function cmdAdopt() {
  adoptLib.adopt(ROOT, pos[1], { name: flags.name, dryRun: !!flags['dry-run'], say });
}
function cmdRole() {
  if (pos[1] !== 'set' || !pos[2]) fail('role set <claude|codex> [--reviewer-model M] [--no-selftest] [--selftest-timeout сек]', 2);
  const r = roles.setRole(ROOT, pos[2], { reviewerModel: flags['reviewer-model'] });
  say('Направление: было основной ' + r.before.main + ', проверяет ' + r.before.reviewer + '; стало основной ' + r.after.main + ', проверяет ' + r.after.reviewer + '.');
  for (const [st, what] of r.report) say(st + ': ' + what);
  if (r.after.main === 'codex') say('Хуки основного Codex грузятся из .codex/hooks.json только в доверенном проекте: человек подтверждает их один раз командой /hooks в Codex.');
  if (r.problems.length) { r.problems.forEach((p) => say('НЕТ: ' + p)); process.exitCode = 1; return; }
  say('Роли согласованы: настройки, AGENTS.md, навыки в .claude/skills и .agents/skills, сторожа в обоих ИИ.');
  if (flags['no-selftest']) { say('Самопроверка пропущена по просьбе (--no-selftest): без неё проверяющий не доказал, что краснеет на ошибке. Запусти: node .workplace/core/skills/cross-check/scripts/selftest-run.js'); return; }
  const script = path.join(ROOT, '.workplace', 'core', 'skills', 'cross-check', 'scripts', 'selftest-run.js');
  if (!u.isFile(script)) { say('НЕТ: нет навыка cross-check в пакете, самопроверку запустить нечем.'); process.exitCode = 1; return; }
  say('Самопроверка с вшитой ошибкой: ' + providers.get(r.after.reviewer).label + ' проверяет два результата (тратит его лимит).');
  const args = [script].concat(flags['selftest-timeout'] ? ['--timeout', flags['selftest-timeout']] : []);
  const st = cp.spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', env: process.env, timeout: ((parseInt(flags['selftest-timeout'] || '540', 10) || 540) * 2 + 120) * 1000, maxBuffer: 64 * 1024 * 1024 });
  say(String(st.stdout || '').trim() + (st.stderr ? '\n' + String(st.stderr).trim() : ''));
  if (st.status !== 0) { say('НЕТ: самопроверка не пройдена: проверка слепая, ей нельзя доверять. Что сказал проверяющий, показано выше.'); process.exitCode = 1; return; }
  const c = autoStage('P3.selftest', 'самопроверка пройдена после смены ролей');
  say(c.ok ? 'Этап P3.selftest отмечен: самопроверка пройдена проверяющим ' + providers.get(r.after.reviewer).label + '.' : 'НЕТ: самопроверка запускалась, но этап не засчитан: ' + c.detail);
  if (!c.ok) process.exitCode = 1;
}
async function cmdDelegate() {
  const cfg = config.load(ROOT);
  const to = flags.to || config.other(cfg.main);
  if (!config.PROVIDERS.includes(to)) fail('--to: claude или codex.', 2);
  const prov = providers.get(to);
  if (typeof prov.run !== 'function') fail('Исполнителем может быть пока только Codex (codex exec --sandbox workspace-write). Для ' + prov.label + ' запуск задачи не подключён: сделай задачу сам или смени основного ИИ (role set).', 2);
  const prompt = flags['task-file'] ? u.readText(path.resolve(flags['task-file'])) : pos.slice(1).join(' ');
  if (!prompt || !prompt.trim()) fail('Нужно задание: delegate --task-file файл или delegate "текст задания".', 2);
  const dir = path.resolve(flags.dir || ROOT);
  if (!u.isDir(dir)) fail('Папки ' + dir + ' нет. Ничего не запущено.', 2);
  if (!u.within(ROOT, dir)) {
    // исполнитель пишет в папке задачи; снаружи главной папки это тот же случай, что запись в проект человека: нужно «да» и названная папка
    const res = consent.evaluate(ROOT, null, { kind: 'target', targets: [{ kind: 'path', abs: dir }] });
    if (!res.ok) fail('Папка ' + u.tilde(dir) + ' вне главной папки: ' + prov.label + ' будет менять в ней файлы. ' + (res.why === 'no-record' ? 'Подтвердить нечем (хук human-message не подключён или не доверен): задачу запускает сам человек.' : res.why === 'no-yes' ? 'В последнем сообщении человека нет «да». Покажи ему папку и задание, спроси «да» и повтори.' : 'Папка не названа в последних двух сообщениях человека. Зарегистрируй показанное (consent plan "текст"), спроси «да» и повтори.'), 3);
  }
  const run = path.join(ROOT, '.workplace', 'delegate', u.stamp());
  const g = makeGuard(ROOT);
  g.mk(run);
  const outFile = path.join(run, 'answer.md');
  say(prov.label + ' получает задание в папке ' + u.tilde(dir) + ' (песочница workspace-write: пишет только там). Это может занять несколько минут.');
  const r = await prov.run({ dir, prompt, outFile, logFile: path.join(run, 'log.txt'), timeoutMs: flags['selftest-timeout'] ? parseInt(flags['selftest-timeout'], 10) * 1000 : undefined });
  if (r.ok) {
    say('Готово за ' + Math.round(r.durationMs / 1000) + ' с. Итог ' + prov.label + ' (файл ' + path.relative(ROOT, outFile).split(path.sep).join('/') + '):');
    say(r.text.length > 6000 ? r.text.slice(0, 6000) + '\n... (дальше в файле)' : r.text);
    return;
  }
  say('НЕТ: ' + prov.label + ' не выполнил задание (' + r.kind + '). ' + r.hint);
  if (r.stderrTail) say(r.stderrTail.split(/\r?\n/).slice(-6).join('\n'));
  process.exitCode = 1;
}
function cmdUpdate() {
  if (Object.prototype.hasOwnProperty.call(flags, 'human-said')) fail('update не принимает --human-said: в главной папке сторож сообщений человека подключён всегда, «да» берётся из его записанных сообщений. Покажи человеку план обновления (update plan) и дождись его «да». Ничего не сделано.', 2);
  const overwrite = flags.overwrite ? flags.overwrite.split(',') : [];
  update.run(pos[1], { root: flags.root, kit: KIT, installed: INSTALLED, yes: !!flags.yes, overwrite }, say);
}
function cmdPathFix() {
  install.pathFix({ root: ROOT, yes: !!flags.yes, humanSaid: flags['human-said'], dryRun: !!flags['dry-run'] }, say);
}
function cmdInstall() {
  install.install(pos[1], { root: ROOT, yes: !!flags.yes, humanSaid: flags['human-said'], npm: !!flags.npm, dryRun: !!flags['dry-run'], force: !!flags.force }, say);
}

function main() {
  parse();
  const cmd = pos[0];
  if (!cmd || cmd === 'help') { say('Команды: recon, plan, init, update, install, path-fix, layout, hooks, config, gitignore, git-init, state, snapshot, verify, report, new-workspace, module, consent, adopt, backup, role, delegate. Описание: шапка core/cli/wp.js.'); return; }
  if (cmd === 'version') { say(((u.readText(path.join(KIT, 'VERSION')) || '?')).trim()); return; }
  if (ROOT_CMDS.has(cmd)) needRoot(cmd);
  switch (cmd) {
    case 'recon': return cmdRecon();
    case 'plan': return cmdPlan();
    case 'init': return cmdInit();
    case 'update': return cmdUpdate();
    case 'install': return cmdInstall();
    case 'path-fix': return cmdPathFix();
    case 'layout': return cmdLayout();
    case 'hooks': return cmdHooks();
    case 'config': return cmdConfig();
    case 'gitignore': return cmdGitignore();
    case 'git-init': return cmdGitInit();
    case 'state': return cmdState();
    case 'snapshot': return cmdSnapshot();
    case 'verify': return cmdVerify();
    case 'report': return cmdReport();
    case 'new-workspace': return cmdNewWorkspace();
    case 'module': return cmdModule();
    case 'consent': return cmdConsent();
    case 'adopt': return cmdAdopt();
    case 'backup': return cmdBackup();
    case 'role': return cmdRole();
    case 'delegate': return cmdDelegate();
    default: fail('Неизвестная команда ' + cmd + '. Команды: recon, plan, init, update, install, path-fix, layout, hooks, config, gitignore, git-init, state, snapshot, verify, report, new-workspace, module, consent, adopt, backup, role, delegate.', 2);
  }
}

function onError(e) {
  if (e instanceof u.WpError) { process.stderr.write(e.message + '\n'); process.exitCode = e.code; }
  else { process.stderr.write('Ошибка: ' + (e && e.message ? e.message : e) + '\n'); process.exitCode = 1; }
}
try { Promise.resolve(main()).catch(onError); } catch (e) { onError(e); }
