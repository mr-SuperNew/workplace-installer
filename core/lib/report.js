'use strict';
// install-report.md: отчёт собирается из состояния, а не из пересказа (К33). Основа - report() из v3.
// Дополнения по итогам первой обкатки на Mac:
//  - при повторном запуске устаревшие замечания (с привязкой к этапу, который теперь проходит) переносятся в «Снятые»;
//  - строки этапа и итога о живой проверке входа берутся из ОДНОГО результата проверки и не противоречат друг другу;
//  - ~/.codex/auth.json меняется при каждом использовании Codex: это штатная запись (класс B), не тревога.
// В отчёте нет почт, токенов, путей с именем пользователя (~ вместо домашней папки); в конце контакт.
const path = require('path');
const u = require('./util');
const rootLib = require('./root');
const state = require('./state');
const recon = require('./recon');
const checks = require('./checks');
const snapshot = require('./snapshot');
const mask = require('./mask');
const providers = require('../providers');
const config = require('./config');
const { makeGuard } = require('./fsguard');

const CONTACT = 'https://t.me/moneyBaires';
const ST = { done: 'прошёл', failed: 'УПАЛ', skipped: 'пропущен', todo: 'не дошли', optional: 'не выбран', 'needs-install': 'ждёт «да» на установку', 'needs-human': 'ждёт шага человека' };
const AC = { present: 'уже было', installed: 'поставлено установщиком', manual: 'сделано руками', created: 'создано' };
const SKIP_IN_FINAL = ['P0.recon', 'P5.report'];

function cell(s) { return String(s === null || s === undefined ? '' : s).replace(/\|/g, '/').replace(/\r?\n/g, ' '); }

// o: { live }. Возвращает { file, problems, text }.
function build(root, o) {
  o = o || {};
  const p = rootLib.paths(root);
  const g = makeGuard(root);
  const s = state.need(root);
  const cfg = config.load(root);
  const before = u.readJson(p.reconBefore);
  const after = recon.collect({ scan: false });
  const results = checks.runAll(root, state.STAGE_IDS.filter((id) => id !== 'P5.report'), { live: !!o.live });
  // внешняя сверка: снимок «после» и сравнение с «до»
  const snapBefore = snapshot.load(root, 'before');
  let diff = null, stampBefore = null;
  if (snapBefore) {
    const snapAfter = snapshot.take(root, 'after');
    diff = snapshot.diff(snapBefore, snapAfter, { declared: s.declared, installs: s.installs.length });
    stampBefore = snapBefore.taken;
  }
  const main = providers.get(cfg.main), rev = providers.get(cfg.reviewer);
  const L = [];
  L.push('# Отчёт об установке рабочего места', '');
  L.push('Дата: ' + u.today() + '. Пакет v' + s.kit_version + '. Система: ' + after.os.name + ' ' + after.os.version + ' (' + (after.os.machine || after.os.arch) + '). Главная папка: ' + s.root + '.');
  L.push('Направление: основной ' + main.label + ', проверяет ' + rev.label + (cfg.reviewer_model ? ' (модель ' + cfg.reviewer_model + ')' : '') + '. Случай при разведке: ' + (recon.CASE_TITLE[s.case] || s.case || 'не определён') + '.');
  if (u.exists(p.report)) L.push('Это повторная сборка отчёта: сведения ниже актуальны на ' + u.hhmm() + ', замечания, которые больше не подтверждаются проверкой, перенесены в «Снятые».');
  L.push('');
  // что было и что стало
  L.push('## Что было и что стало', '', '| Что | Было | Стало |', '|---|---|---|');
  const bmap = new Map(((before && before.plan) || []).map((x) => [x.item, x.state]));
  for (const x of after.plan.filter((y) => !/^Твои проекты/.test(y.item))) L.push('| ' + cell(x.item) + ' | ' + cell(bmap.get(x.item) || 'нет данных') + ' | ' + cell(x.state) + ' |');
  L.push('');
  if (before && before.warnings && before.warnings.length) { L.push('Замечания разведки на момент установки (до неё):'); before.warnings.forEach((w) => L.push('- ' + w)); L.push(''); }
  // этапы
  L.push('## Этапы', '', '| Этап | Результат | Как | Заметка |', '|---|---|---|---|');
  for (const [id, title] of state.STAGES) {
    const x = s.stages[id];
    if (!x) continue;
    const r = results[id];
    let res = id === 'P5.report' ? 'этот отчёт' : (ST[x.status] || x.status);
    let note = x.note || '';
    if (r) {
      if (x.status === 'done' && !r.ok) res = 'записан как пройденный, НО проверка не подтвердила';
      if (['done', 'failed', 'needs-human', 'needs-install', 'todo'].includes(x.status) && r.detail && /login/.test(id)) note = r.detail;   // строка входа: тот же текст, что в итоговой проверке
      else if (!note && r.detail) note = r.detail;
    }
    L.push('| ' + cell(id + ' ' + title) + ' | ' + cell(res) + ' | ' + cell(x.action ? AC[x.action] || x.action : '') + ' | ' + cell(note) + ' |');
  }
  L.push('');
  if (s.installs.length) {
    L.push('Что поставил установщик:', '');
    for (const i of s.installs) L.push('- ' + i.id + (i.version ? ' ' + i.version : '') + ': ' + (i.ok ? 'поставлено' : 'НЕ поставлено') + ' (' + cell(i.how) + '; ' + cell(i.command) + ')' + (i.confirmation ? '; «да»: ' + cell(i.confirmation.via) + (i.confirmation.verified === false && i.confirmation.claimedByAi ? ' (слова, которые передал ИИ, пакет не проверял: «' + cell(i.confirmation.claimedByAi) + '»)' : '') : ''));
    L.push('');
  }
  // руками
  L.push('## Что делали руками', '');
  if (s.manual.length) s.manual.forEach((m) => L.push('- ' + m.text + ' (со слов, записано ' + m.at.slice(0, 16).replace('T', ' ') + ')'));
  else L.push('- (ничего не записано)');
  for (const [id] of state.STAGES) { const x = s.stages[id]; if (x && x.action === 'manual' && x.status === 'done') L.push('- этап ' + id + ' сделан человеком' + (x.note ? ': ' + x.note : '')); }
  L.push('');
  // вне корня
  L.push('## Изменения вне новой папки', '');
  if (!diff) L.push('- Сверка не проводилась: снимок «до» не снят (snapshot before).');
  else if (!diff.total) L.push('- Ни один отслеживаемый файл вне главной папки не изменён и нового, кроме журналов и кэша программ, не появилось (снимок «до» от ' + stampBefore.slice(0, 16).replace('T', ' ') + '; отслеживаются профили оболочки, настройки git, ~/.claude, ~/.codex, настройки VS Code).');
  else {
    L.push('Три класса записей (снимок «до» от ' + stampBefore.slice(0, 16).replace('T', ' ') + '). Значения ключей и содержимое секретных файлов не показываются.', '');
    L.push('| Класс | Файл | Что случилось |', '|---|---|---|');
    for (const cls of ['A', 'D', 'C', 'B']) for (const x of diff.classes[cls]) L.push('| ' + cls + ': ' + snapshot.CLASS_TITLE[cls] + ' | ' + cell(x.id) + ' | ' + cell(x.kind + (x.note ? ' (' + x.note + ')' : '')) + ' |');
    L.push('');
    if (diff.alarm) L.push('Есть записи класса A: их никто не объявлял. Показать человеку дословно, ничего не откатывать без «да».');
    if (diff.classes.C.length) L.push('По классу C человеку задан вопрос «это вы меняли?».');
  }
  L.push('', 'Штатные записи самих программ (не установщика): Claude Code пишет историю чатов в `~/.claude/projects/` и отметку о доверии к папке в `~/.claude.json`; Codex при каждом запуске пишет сессии, журналы и кэш в `~/.codex/`, а файл входа `~/.codex/auth.json` меняется при каждом использовании.', '');
  // замечания
  const live = [], gone = [];
  for (const n of s.notes) {
    if (n.stage && results[n.stage] && results[n.stage].ok) gone.push(n); else live.push(n);
  }
  L.push('## Вопросы и замечания', '');
  if (live.length) live.forEach((n) => L.push('- ' + n.text)); else L.push('- (нет)');
  if (gone.length) { L.push('', 'Снятые замечания (этап теперь проходит, больше не актуальны):'); gone.forEach((n) => L.push('- ' + n.text + (n.stage ? ' (' + n.stage + ')' : ''))); }
  L.push('');
  // итог
  L.push('## Итоговая проверка', '');
  for (const id of state.STAGE_IDS) {
    if (SKIP_IN_FINAL.includes(id)) continue;
    const r = results[id];
    const x = s.stages[id];
    const pending = x && ['needs-install', 'needs-human', 'optional', 'skipped'].includes(x.status);
    L.push('- [' + (r.ok ? 'ок' : (pending ? ST[x.status] : 'НЕТ')) + '] ' + id + ': ' + r.detail);
  }
  L.push('');
  // время
  const t = state.timingSummary(s);
  L.push('## Время', '', 'Всего: ' + t.total_min + ' мин. Без ожидания человека: ' + t.without_waits_min + ' мин (ожидание: ' + t.wait_min + ' мин).', '');
  // обновления
  if (s.updates.length) {
    const last = s.updates[s.updates.length - 1];
    L.push('## Обновление ' + last.to, '');
    L.push('Дата: ' + last.at.slice(0, 10) + '. Пакет ' + (s.updates[0].from || '?') + ' -> ' + last.to + '. Файлов пакета: создано ' + last.counts.new + ', обновлено ' + last.counts.update + ', без изменений ' + last.counts.same + ', не тронуто из-за правок человека ' + (last.counts.custom_kept || 0) + '. Копии прежних файлов: `' + last.backup + '`.', '');
  }
  L.push('---', 'Не получилось или что-то странное: пришлите этот файл в Telegram: ' + CONTACT);
  let text = mask.maskReport(L.join('\n') + '\n');
  const problems = mask.reportProblems(text);
  return { text, problems, results, diff, state: s };
}

function write(root, o) {
  const r = build(root, o);
  const g = makeGuard(root);
  const p = rootLib.paths(root);
  g.guard(p.report);
  try { if (require('fs').lstatSync(p.report).isSymbolicLink()) throw new u.WpError('install-report.md в корне это ссылка, а не файл: запись отменена.', 3); } catch (e) { if (e instanceof u.WpError) throw e; if (e.code !== 'ENOENT') throw e; }
  g.wf(p.report, r.text);
  const s = state.need(root);
  if (!s.timing.finished_at) s.timing.finished_at = new Date().toISOString();
  state.setStage(s, 'P5.report', 'done', 'created', 'install-report.md');
  state.save(root, s);
  state.log(root, 'отчёт записан: install-report.md');
  return { file: p.report, problems: r.problems };
}

module.exports = { build, write, CONTACT };
