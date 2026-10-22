'use strict';
// Общий config.json рабочего места (`<корень>/.workplace/config.json`): направление проверки, модель проверяющего, флаги сторожей.
// Источник значений по умолчанию - templates/config.json (один файл на всё). Условного `if (claude)` вне core/providers/ быть не должно:
// шаблоны, session-start, cross-check и doctor читают поля main и reviewer отсюда.
const fs = require('fs');
const path = require('path');
const u = require('./util');

const PROVIDERS = ['claude', 'codex'];
const TEMPLATE = path.join(__dirname, '..', 'templates', 'config.json');
const GUARD_NAMES = ['secret_guard', 'session_start', 'danger_guard', 'feedback_reminder', 'cross_check_guard', 'model_guard'];

function defaults() {
  const d = u.readJson(TEMPLATE);
  if (d) return JSON.parse(JSON.stringify(d));
  return { schema: 1, main: 'claude', reviewer: 'codex', reviewer_model: null, guards: { secret_guard: true, session_start: true, danger_guard: true, feedback_reminder: true, cross_check_guard: true, model_guard: true }, cross_check_ttl_min: 120 };
}
function other(p) { return p === 'claude' ? 'codex' : 'claude'; }

// Слияние с умолчаниями; незнакомые ключи сохраняются (файл могут править руками и модули).
function merge(cur) {
  const d = defaults();
  const c = cur && typeof cur === 'object' && !Array.isArray(cur) ? cur : {};
  const out = Object.assign({}, d, c);
  out.guards = Object.assign({}, d.guards, c.guards && typeof c.guards === 'object' ? c.guards : {});
  return out;
}
// Проблемы значений (пусто = верно).
function validate(cfg) {
  const p = [];
  if (!PROVIDERS.includes(cfg.main)) p.push('main должен быть claude или codex');
  if (!PROVIDERS.includes(cfg.reviewer)) p.push('reviewer должен быть claude или codex');
  if (PROVIDERS.includes(cfg.main) && cfg.main === cfg.reviewer) p.push('reviewer должен отличаться от main: проверяет другой ИИ');
  if (cfg.reviewer_model !== null && cfg.reviewer_model !== undefined && (typeof cfg.reviewer_model !== 'string' || !/^[A-Za-z0-9._:\/-]{1,80}$/.test(cfg.reviewer_model))) p.push('reviewer_model: строка из букв, цифр и . _ : / - либо null');
  for (const g of Object.keys(cfg.guards || {})) if (typeof cfg.guards[g] !== 'boolean') p.push('guards.' + g + ' должен быть true или false');
  if (!(Number.isFinite(cfg.cross_check_ttl_min) && cfg.cross_check_ttl_min > 0)) p.push('cross_check_ttl_min: положительное число минут');
  return p;
}
function file(root) { return path.join(root, '.workplace', 'config.json'); }
// Чтение для хуков и скриптов: битый или отсутствующий файл не ломает работу (берутся умолчания с признаком _broken).
function load(root) {
  const cur = u.readJson(file(root));
  const cfg = merge(cur);
  if (cur === null) cfg._missing = true;
  else if (validate(cfg).length) cfg._invalid = validate(cfg);
  return cfg;
}
function strip(cfg) { const c = Object.assign({}, cfg); delete c._missing; delete c._invalid; return c; }
function save(root, cfg) {
  const bad = validate(cfg);
  if (bad.length) throw new u.WpError('config.json не записан: ' + bad.join('; '), 2);
  u.writeAtomic(file(root), JSON.stringify(strip(cfg), null, 2) + '\n');
}
// Включён ли сторож. model_guard работает только у основного Claude (у Codex аналога нет).
function guardEnabled(cfg, name) {
  if (!cfg || !cfg.guards) return true;
  if (cfg.guards[name] === false) return false;
  if (name === 'model_guard' && cfg.main !== 'claude') return false;
  return true;
}
function get(cfg, dotted) { return String(dotted).split('.').reduce((a, k) => (a && typeof a === 'object' ? a[k] : undefined), cfg); }
function parseValue(s) { if (s === 'true') return true; if (s === 'false') return false; if (s === 'null') return null; if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s); return s; }
function set(cfg, dotted, value) {
  const keys = String(dotted).split('.');
  if (['schema'].includes(keys[0])) throw new u.WpError('Поле ' + keys[0] + ' менять нельзя.', 2);
  let cur = cfg;
  for (let i = 0; i < keys.length - 1; i++) { if (typeof cur[keys[i]] !== 'object' || cur[keys[i]] === null) cur[keys[i]] = {}; cur = cur[keys[i]]; }
  cur[keys[keys.length - 1]] = typeof value === 'string' ? parseValue(value) : value;
  return cfg;
}

module.exports = { PROVIDERS, GUARD_NAMES, defaults, other, merge, validate, load, save, strip, file, guardEnabled, get, set };
