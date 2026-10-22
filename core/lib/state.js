'use strict';
// Состояние установки: `<корень>/.workplace/state.json` (машинное) и `<корень>/STATE.md` (журнал, читают люди и ИИ).
// Пароли и ключи в журнал не попадают: текст проходит проверку secrets-scan.
const fs = require('fs');
const path = require('path');
const u = require('./util');
const rootLib = require('./root');
const secrets = require('./secrets-scan');

const STATE_VERSION = 4;

// Статусы этапа:
//  todo          ещё не делали
//  needs-install не хватает, ставится ПОСЛЕ «да» человека (в v3 это называлось skipped)
//  needs-human   шаг делает человек сам (вход в аккаунт, пароль, системное окно)
//  optional      по выбору
//  done | failed
//  skipped       осознанно не нужен или человек отказался (с причиной в note)
const STATUSES = ['todo', 'needs-install', 'needs-human', 'optional', 'done', 'failed', 'skipped'];
const OPEN = ['todo', 'needs-install', 'needs-human', 'failed'];
// как: present (уже было) | installed (поставил установщик после «да») | manual (сделал человек)
const ACTIONS = ['present', 'installed', 'manual', 'created'];

// [id, название, начальный статус]
const STAGES = [
  ['P0.recon', 'Разведка', 'todo'],
  ['P1.root', 'Главная папка создана', 'todo'],
  ['P1.node', 'Node.js 18 или новее', 'todo'],
  ['P1.python', 'Python', 'todo'],
  ['P1.git', 'git (по «да»)', 'optional'],
  ['P1.main', 'Основной ИИ: программа', 'todo'],
  ['P1.reviewer', 'Проверяющий ИИ: программа', 'todo'],
  ['P1.main-login', 'Вход в основной ИИ', 'todo'],
  ['P1.reviewer-login', 'Вход в проверяющий ИИ', 'todo'],
  ['P1.vscode', 'VS Code (по выбору, модуль vscode)', 'optional'],
  ['P2.core', 'Раскладка: правила, память, навыки', 'todo'],
  ['P2.hooks', 'Сторожа подключены', 'todo'],
  ['P2.git', 'git главной папки', 'optional'],
  ['P3.hooks-test', 'Сторожа отвечают на тестовые вводы', 'todo'],
  ['P3.selftest', 'Самопроверка с вшитой ошибкой', 'todo'],
  ['P5.report', 'Отчёт install-report.md', 'todo'],
];
const STAGE_IDS = STAGES.map((s) => s[0]);

function file(root) { return rootLib.paths(root).state; }

function newState(o) {
  const stages = {};
  for (const [id, title, st] of STAGES) stages[id] = { title, status: st, action: null, note: '', at: null };
  return {
    version: STATE_VERSION,
    kit_version: o.kit_version || null,
    created: new Date().toISOString(),
    updated: null,
    platform: process.platform,
    root: u.tilde(o.root),
    case: o.case || null,
    direction: { main: o.main, reviewer: o.reviewer },
    choices: {},
    stages,
    manual: [],      // [{at, text}]: что человек делал руками
    notes: [],       // [{at, text, stage?}]: вопросы и замечания; с полем stage снимаются, когда этап пройден
    installs: [],    // [{at, id, how, command, ok, declared:[путь...]}]: что поставил установщик
    declared: [],    // пути вне корня, запись в которые объявлена заранее (профили оболочки от официальных установщиков)
    modules: [],     // [{name, version, files:{путь: sha256}}]
    updates: [],
    timing: { started_at: new Date().toISOString(), finished_at: null, human_wait_ms: 0, wait_open_at: null },
    last_checks: {},
  };
}

function load(root) { return u.readJson(file(root)); }
function need(root) {
  const s = load(root);
  if (!s) throw new u.WpError('Нет .workplace/state.json в ' + root + ': установка здесь не начиналась (wp.js init).', 3);
  return migrate(s);
}
// Старый (неполный) файл дополняется новыми полями: этапы, добавленные позже, не ломают чтение.
function migrate(s) {
  for (const [id, title, st] of STAGES) if (!s.stages[id]) s.stages[id] = { title, status: st, action: null, note: '', at: null };
  for (const k of ['manual', 'notes', 'installs', 'declared', 'modules', 'updates']) if (!Array.isArray(s[k])) s[k] = [];
  if (!s.timing) s.timing = { started_at: s.created, finished_at: null, human_wait_ms: 0, wait_open_at: null };
  if (!s.last_checks) s.last_checks = {};
  if (!s.choices) s.choices = {};
  return s;
}
function save(root, s) {
  s.updated = new Date().toISOString();
  fs.mkdirSync(path.dirname(file(root)), { recursive: true });
  u.writeAtomic(file(root), JSON.stringify(s, null, 2) + '\n');
}

function setStage(s, id, status, action, note) {
  if (!s.stages[id]) throw new u.WpError('Нет такого этапа: ' + id + '. Этапы: ' + STAGE_IDS.join(', '), 2);
  if (!STATUSES.includes(status)) throw new u.WpError('Статус: ' + STATUSES.join(' | '), 2);
  if (action && !ACTIONS.includes(action)) throw new u.WpError('--action: ' + ACTIONS.join(' | '), 2);
  const x = s.stages[id];
  s.stages[id] = Object.assign(x, { status, action: action || (status === 'done' ? x.action : null) || null, note: note !== undefined && note !== null ? String(note) : x.note, at: new Date().toISOString() });
  return s.stages[id];
}
// Первый незавершённый этап по порядку.
function next(s) {
  for (const [id, title] of STAGES) {
    const x = s.stages[id];
    if (x && OPEN.includes(x.status)) return { id, title, status: x.status, note: x.note };
  }
  return null;
}
function addManual(s, text) { s.manual.push({ at: new Date().toISOString(), text: scrub(text) }); }
function addNote(s, text, stage) {
  const n = { at: new Date().toISOString(), text: scrub(text) };
  if (stage) n.stage = stage;
  s.notes.push(n);
}
function addInstall(s, rec) { s.installs.push(Object.assign({ at: new Date().toISOString() }, rec)); for (const d of rec.declared || []) if (!s.declared.includes(d)) s.declared.push(d); }

// Время установки (К34): всего и без ожиданий человека.
function waitBegin(s) { if (!s.timing.wait_open_at) s.timing.wait_open_at = new Date().toISOString(); }
function waitEnd(s) {
  if (!s.timing.wait_open_at) return;
  s.timing.human_wait_ms += Math.max(0, Date.now() - new Date(s.timing.wait_open_at).getTime());
  s.timing.wait_open_at = null;
}
function timingSummary(s) {
  const t = s.timing;
  const end = t.finished_at ? new Date(t.finished_at).getTime() : Date.now();
  const total = Math.max(0, end - new Date(t.started_at).getTime());
  let wait = t.human_wait_ms || 0;
  if (t.wait_open_at) wait += Math.max(0, end - new Date(t.wait_open_at).getTime());
  return { total_min: Math.round(total / 60000), without_waits_min: Math.max(0, Math.round((total - wait) / 60000)), wait_min: Math.round(wait / 60000) };
}

// Секреты в журнал не пишем.
function scrub(text) {
  const t = String(text);
  if (secrets.hasSecret(t, { allowPlaceholders: false }) || secrets.looksSecret(t)) return '[текст скрыт: похоже на ключ или пароль]';
  return t.replace(/\r?\n/g, ' ').slice(0, 600);
}
// Запись в журнал STATE.md (дописывание строки). Папку корня создаёт init.
function log(root, text) {
  const f = rootLib.paths(root).stateMd;
  const line = '- ' + u.hhmm() + ' - ' + scrub(text) + '\n';
  let cur = u.readText(f);
  if (cur === null) cur = '# Журнал установки\n\n';
  if (!cur.endsWith('\n')) cur += '\n';
  fs.writeFileSync(f, cur + line);
}

module.exports = { STATE_VERSION, STATUSES, OPEN, ACTIONS, STAGES, STAGE_IDS, newState, load, need, save, migrate, setStage, next, addManual, addNote, addInstall, waitBegin, waitEnd, timingSummary, scrub, log, file };
