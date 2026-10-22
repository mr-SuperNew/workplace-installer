#!/usr/bin/env node
'use strict';
// SessionStart: даёт ИИ контекст рабочей папки. Один скрипт для Claude Code и Codex. Основа - session-start.js из v3.
//  - роли берёт из .workplace/config.json (main делает, reviewer проверяет только чтением, человек принимает); названия ИИ - из core/providers;
//  - незавершённая установка (.workplace/state.json): какие этапы не сделаны и чем продолжить;
//  - свежая записка передачи контекста (возраст по дате в имени файла, не по mtime; не влезает - берутся целые разделы по приоритету),
//    intent.md, tasks.md и хвост MEMORY.md текущей папки;
//  - подстраховка для Claude Code: если в корне нет CLAUDE.md с импортом @AGENTS.md и версия Claude Code старше 2.1.277 (или неизвестна),
//    вставляется текст AGENTS.md. У Codex-основного `claude --version` не вызывается: Codex читает AGENTS.md сам;
//  - политика моделей «главная сессия пишет задание, субагенты делают» (только у основного Claude, флаг guards.model_guard);
//  - предупреждение, если AGENTS.md или MEMORY.md разрослись.
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const hookIo = require('../lib/hook-io');
const cfgLib = require('../lib/config');
const rootLib = require('../lib/root');
const common = require('./_common');

const LIMIT = 8000;            // предел вывода хука у Claude Code 10 000 символов; запас на служебное
const MIN_VERSION = [2, 1, 277];
const AGENTS_MAX_LINES = 150, AGENTS_MAX_BYTES = 12000;
const MEMORY_MAX_LINES = 200, MEMORY_MAX_BYTES = 20000;
const HANDOFF_BUDGET = 2500;

function attended() { return process.env.CLAUDE_CODE_SESSION_ATTENDED !== '0' && !process.env.CODEX_NONINTERACTIVE; }

function versionAtLeast(v, min) {
  for (let i = 0; i < 3; i++) { if (v[i] > min[i]) return true; if (v[i] < min[i]) return false; }
  return true;
}
function claudeVersionOk() {
  try {
    const out = cp.execFileSync('claude', ['--version'], { timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'], shell: process.platform === 'win32', windowsHide: true }).toString();
    const m = out.match(/(\d+)\.(\d+)\.(\d+)/);
    return m ? versionAtLeast([+m[1], +m[2], +m[3]], MIN_VERSION) : false;
  } catch (_) { return false; }   // версию не узнали: вставляем текст на всякий случай
}

// Дата записки: из имени (2026-10-21, 20261021), иначе mtime. Сортировка по дате, при равенстве по mtime.
function nameDate(name) {
  let m = name.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) m = name.match(/(?:^|[^\d])(20\d{2})(\d{2})(\d{2})(?!\d)/);
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  return Number.isFinite(t) ? t : null;
}
function newestHandoff(dirs) {
  for (const d of dirs) {
    let files = [];
    try {
      files = fs.readdirSync(d).filter((f) => f.toLowerCase().endsWith('.md')).map((f) => {
        const p = path.join(d, f);
        const mt = fs.statSync(p).mtimeMs;
        return { p, mt, date: nameDate(f) };
      });
    } catch (_) { continue; }
    if (files.length) { files.sort((a, b) => ((b.date || b.mt) - (a.date || a.mt)) || (b.mt - a.mt)); return files[0]; }
  }
  return null;
}
// Не влезает: целые разделы (по заголовкам #) в порядке важности, пока есть место. Раздел входит целиком или не входит.
const PRIORITY = [/intent|цел[ьи]|задач|результат/i, /дальше|следующ|next|что делать/i, /решени|принят|decid/i, /состояни|остановил|статус|status|итог/i];
function pickSections(text, budget) {
  if (text.length <= budget) return text;
  const lines = text.split('\n');
  const secs = [];
  let cur = { title: '', body: [] };
  for (const l of lines) {
    if (/^#{1,3}\s/.test(l) && (cur.body.length || cur.title)) { secs.push(cur); cur = { title: l, body: [] }; }
    else if (/^#{1,3}\s/.test(l)) cur.title = l;
    cur.body.push(l);
  }
  secs.push(cur);
  const rank = (s) => { const i = PRIORITY.findIndex((r) => r.test(s.title)); return i < 0 ? 9 : i; };
  const order = secs.map((s, i) => ({ s, i, r: i === 0 ? -1 : rank(s) })).sort((a, b) => a.r - b.r || a.i - b.i);
  const chosen = [];
  let used = 0;
  for (const o of order) {
    const t = o.s.body.join('\n');
    if (used + t.length + 1 <= budget) { chosen.push(o); used += t.length + 1; }
  }
  if (!chosen.length) return text.slice(0, budget - 40) + '\n[... записка обрезана ...]';
  chosen.sort((a, b) => a.i - b.i);
  const skipped = secs.length - chosen.length;
  return chosen.map((o) => o.s.body.join('\n')).join('\n') + (skipped ? '\n[... ещё разделов: ' + skipped + ', открой файл целиком ...]' : '');
}

function sizeWarn(file, label, maxLines, maxBytes, out) {
  try {
    const st = fs.statSync(file);
    const lines = fs.readFileSync(file, 'utf8').split('\n').length;
    if (lines > maxLines || st.size > maxBytes) out.push('Предупреждение: ' + label + ' разросся (' + lines + ' строк, ' + Math.round(st.size / 1024) + ' КБ). Предложи человеку сжать файл, не теряя решений.');
  } catch (_) { /* нет файла */ }
}

// Незавершённые этапы установки из state.json (todo, failed, needs-install; needs-human - пока нет отчёта P5).
function pendingStages(root) {
  try {
    const s = JSON.parse(fs.readFileSync(rootLib.paths(root).state, 'utf8'));
    const st = s.stages || {};
    const reportDone = st['P5.report'] && st['P5.report'].status === 'done';
    return Object.keys(st).filter((k) => st[k] && (['todo', 'failed', 'needs-install'].includes(st[k].status) || (!reportDone && st[k].status === 'needs-human')));
  } catch (_) { return null; }
}

function claudeMdImportsAgents(root) {
  const t = common.readText(path.join(root, 'CLAUDE.md'), 4000);
  return !!(t && /^\s*@AGENTS\.md\s*$/m.test(t));
}

hookIo.run((data, ctx) => {
  if (!cfgLib.guardEnabled(ctx.config, 'session_start')) return null;
  const root = ctx.root;
  if (!root) return null;                                  // вне рабочего места молчим
  if (!Object.keys(data).length) return null;              // пустой или мусорный ввод
  if ((data.hook_event_name && data.hook_event_name !== 'SessionStart') || data.tool_name || data.prompt) return null;   // не событие старта сессии
  const cfg = ctx.config;
  const ws = common.findWorkspace(root, data.cwd);
  const wsRel = common.rel(root, ws);
  const parts = [];

  parts.push('[Рабочее место] Роли: ' + common.label(cfg.main) + ' делает, ' + common.label(cfg.reviewer) + ' проверяет только чтением (команда /cross-check или слово «кросс-чек»: по просьбе человека и перед необратимым или наружным шагом, не на каждом шаге), человек принимает. ' +
    'Общаться по-русски, просто. Текущая папка: ' + wsRel + '.');

  if (cfgLib.guardEnabled(cfg, 'model_guard')) {
    parts.push('Политика моделей включена: главная сессия (самая сильная модель вашего тарифа) формулирует задание и принимает результат, исполнение отдаёт субагентам с явным model: "sonnet" (haiku только для запуска готовой команды; opus только с пометкой [opus: причина] в description). Короткое (до трёх шагов, до трёх файлов) делай сам.');
  }
  if (cfg._invalid) parts.push('В .workplace/config.json есть ошибки (' + cfg._invalid.join('; ') + '): работают значения по умолчанию. Проверка: node .workplace/core/cli/wp.js config validate.');

  const pend = pendingStages(root);
  if (pend && pend.length && attended()) {
    parts.push('Установка рабочего места не завершена. Не сделаны этапы: ' + pend.join(', ') +
      '. Если человек написал «продолжи установку» или просит починить, продолжай с первого незавершённого этапа: node .workplace/core/cli/wp.js state next.');
  }

  const intent = common.readText(path.join(ws, 'intent.md'), 1200);
  if (intent) parts.push('intent.md (' + wsRel + '):\n' + intent);

  const h = newestHandoff([path.join(ws, 'handoffs'), path.join(root, 'handoffs')]);
  if (h) {
    const ageDays = Math.floor((Date.now() - (h.date || h.mt)) / 86400000);
    const txt = pickSections(common.readText(h.p) || '', HANDOFF_BUDGET);
    parts.push('Свежая записка передачи контекста (' + common.rel(root, h.p) + (ageDays > 14 ? ', старая: ' + ageDays + ' дн.' : '') + '):\n' + txt);
  }

  const tasks = common.readText(path.join(ws, 'tasks.md'), 1800);
  if (tasks) parts.push('tasks.md (' + wsRel + '):\n' + tasks);
  const memFile = path.join(ws, 'MEMORY.md');
  const mem = common.readText(memFile);
  if (mem) parts.push('MEMORY.md (' + wsRel + ', последнее):\n' + (mem.length > 2000 ? '...' + mem.slice(-2000) : mem));

  const warns = [];
  new Set([path.join(root, 'AGENTS.md'), path.join(ws, 'AGENTS.md')]).forEach((f) => sizeWarn(f, common.rel(root, f), AGENTS_MAX_LINES, AGENTS_MAX_BYTES, warns));
  sizeWarn(memFile, common.rel(root, memFile), MEMORY_MAX_LINES, MEMORY_MAX_BYTES, warns);
  if (warns.length) parts.push(warns.join('\n'));

  // подстраховка текстом AGENTS.md: только у основного Claude Code
  const mode = String(cfg.inject_agents_md || 'auto');
  let inject = false;
  if (cfg.main === 'claude' && mode !== 'never') inject = mode === 'always' || (!claudeMdImportsAgents(root) && !claudeVersionOk());
  if (inject) {
    const rootText = common.readText(path.join(root, 'AGENTS.md'), 4500);
    if (rootText) parts.push('Подстраховка: AGENTS.md мог не загрузиться сам. Его текст (правила обязательны):\n' + rootText);
    if (ws !== root) {
      const wsText = common.readText(path.join(ws, 'AGENTS.md'), 2000);
      if (wsText) parts.push('AGENTS.md папки ' + wsRel + ':\n' + wsText);
    }
  }

  let text = parts.join('\n\n');
  if (text.length > LIMIT) text = text.slice(0, LIMIT - 60) + '\n[... вывод хука обрезан по лимиту ...]';
  return hookIo.context('SessionStart', text);
}, __dirname);
