'use strict';
// Старт сессии: роли из config.json, незавершённая установка, записка передачи контекста, tasks/MEMORY, подстраховка AGENTS.md, без вызова claude у Codex-основного.
const fs = require('fs');
const path = require('path');
const h = require('./_harness');

const start = (cwd, extra) => Object.assign({ hook_event_name: 'SessionStart', source: 'startup', cwd }, extra || {});
const ev = (o, extra) => start(o.projectDir, extra);
const mk = (files, config) => () => ({ projectDir: h.makeRoot({ files, config }) });
const IMPORT = '@AGENTS.md\n';

function state(stages) { return JSON.stringify({ version: 4, stages }); }
function handoff(sections) { return sections.map(([t, body]) => '## ' + t + '\n' + body).join('\n'); }

const cases = [];

cases.push({ name: 'роли: основной Claude Code, проверяет Codex', input: ev, expect: 'context', make: mk({ 'CLAUDE.md': IMPORT }), has: ['Claude Code делает', 'Codex проверяет', 'кросс-чек'] });
cases.push({ name: 'роли: основной Codex, проверяет Claude Code', input: ev, expect: 'context', make: mk({}, { main: 'codex', reviewer: 'claude' }), has: ['Codex делает', 'Claude Code проверяет'] });
cases.push({ name: 'политика моделей: у основного Claude есть', input: ev, expect: 'context', make: mk({ 'CLAUDE.md': IMPORT }), has: 'Политика моделей включена' });
cases.push({ name: 'политика моделей: у основного Codex нет', input: ev, expect: 'context', make: mk({}, { main: 'codex', reviewer: 'claude' }), hasNot: 'Политика моделей' });
cases.push({ name: 'политика моделей: выключена флагом -> нет', input: ev, expect: 'context', make: mk({ 'CLAUDE.md': IMPORT }, { guards: { model_guard: false } }), hasNot: 'Политика моделей' });
cases.push({ name: 'незавершённая установка: этапы todo/failed/needs-install названы', input: ev, expect: 'context',
  make: mk({ 'CLAUDE.md': IMPORT, '.workplace/state.json': state({ 'P1.node': { status: 'done' }, 'P1.python': { status: 'needs-install' }, 'P2.hooks': { status: 'failed' }, 'P3.selftest': { status: 'todo' } }) }),
  has: ['Установка рабочего места не завершена', 'P1.python', 'P2.hooks', 'P3.selftest', 'state next'], hasNot: 'P1.node' });
cases.push({ name: 'установка завершена (все done/optional) -> без напоминания', input: ev, expect: 'context',
  make: mk({ 'CLAUDE.md': IMPORT, '.workplace/state.json': state({ 'P1.node': { status: 'done' }, 'P1.vscode': { status: 'optional' }, 'P5.report': { status: 'done' } }) }), hasNot: 'не завершена' });
cases.push({ name: 'needs-human до отчёта P5 попадает в список', input: ev, expect: 'context',
  make: mk({ 'CLAUDE.md': IMPORT, '.workplace/state.json': state({ 'P1.reviewer-login': { status: 'needs-human' }, 'P5.report': { status: 'todo' } }) }), has: 'P1.reviewer-login' });
cases.push({ name: 'неинтерактивный запуск: напоминания об установке нет', input: ev, expect: 'context',
  make: () => Object.assign(mk({ 'CLAUDE.md': IMPORT, '.workplace/state.json': state({ 'P1.python': { status: 'todo' } }) })(), { env: { CLAUDE_CODE_SESSION_ATTENDED: '0' } }), hasNot: 'не завершена' });

// записка передачи контекста
cases.push({ name: 'записка: по дате в имени, а не по mtime', input: ev, expect: 'context',
  make: () => {
    const projectDir = h.makeRoot({ files: { 'CLAUDE.md': IMPORT, 'handoffs/HANDOFF-2026-10-20.md': 'СТАРАЯ-ЗАПИСКА', 'handoffs/HANDOFF-2026-10-21.md': 'НОВАЯ-ЗАПИСКА' } });
    const old = new Date(Date.now() + 3600000);   // у старой по имени mtime позже
    fs.utimesSync(path.join(projectDir, 'handoffs', 'HANDOFF-2026-10-20.md'), old, old);
    return { projectDir };
  }, has: 'НОВАЯ-ЗАПИСКА', hasNot: 'СТАРАЯ-ЗАПИСКА' });
cases.push({ name: 'записка длиннее лимита: целые разделы по приоритету, «что дальше» входит', input: ev, expect: 'context',
  make: mk({ 'CLAUDE.md': IMPORT, 'handoffs/HANDOFF-2026-10-21.md': '# Передача\nкраткая шапка\n' + handoff([['История', 'ИСТОРИЯ-МУСОР '.repeat(300)], ['Что дальше', 'СДЕЛАТЬ-СЛЕДУЮЩИМ-ШАГОМ'], ['Решения', 'РЕШЕНО-ДЕЛАТЬ-ТАК']]) }),
  has: ['СДЕЛАТЬ-СЛЕДУЮЩИМ-ШАГОМ', 'РЕШЕНО-ДЕЛАТЬ-ТАК', 'ещё разделов'], hasNot: 'ИСТОРИЯ-МУСОР' });
cases.push({ name: 'записка старше 14 дней помечена как старая', input: ev, expect: 'context', make: mk({ 'CLAUDE.md': IMPORT, 'handoffs/HANDOFF-2020-01-01.md': 'древность' }), has: 'старая' });
cases.push({ name: 'tasks.md, MEMORY.md (хвост) и intent.md попадают в контекст', input: ev, expect: 'context',
  make: mk({ 'CLAUDE.md': IMPORT, 'tasks.md': 'ЗАДАЧА-ОДИН', 'MEMORY.md': 'a'.repeat(3000) + 'ХВОСТ-ПАМЯТИ', 'intent.md': 'ЦЕЛЬ-РАБОТЫ' }), has: ['ЗАДАЧА-ОДИН', 'ХВОСТ-ПАМЯТИ', 'ЦЕЛЬ-РАБОТЫ'] });
cases.push({ name: 'рабочая подпапка со своим AGENTS.md: берутся её tasks.md (Codex-режим, без CLAUDE_PROJECT_DIR)',
  input: (o) => start(path.join(o.root, 'workspaces', 'site')), expect: 'context',
  make: () => ({ root: h.makeRoot({ files: { 'CLAUDE.md': IMPORT, 'workspaces/site/AGENTS.md': '# site', 'workspaces/site/tasks.md': 'ЗАДАЧИ-САЙТА', 'tasks.md': 'ЗАДАЧИ-КОРНЯ' } }) }), has: ['ЗАДАЧИ-САЙТА', 'workspaces/site'], hasNot: 'ЗАДАЧИ-КОРНЯ' });
cases.push({ name: 'разросшийся MEMORY.md -> предупреждение', input: ev, expect: 'context', make: mk({ 'CLAUDE.md': IMPORT, 'MEMORY.md': 'строка\n'.repeat(260) }), has: 'разросся' });
cases.push({ name: 'вывод не длиннее лимита (огромный MEMORY.md и tasks.md)', input: ev, expect: 'context', make: mk({ 'CLAUDE.md': IMPORT, 'MEMORY.md': 'x'.repeat(50000), 'tasks.md': 'y'.repeat(9000) }) });
cases.push({ name: 'config.json с ошибкой: предупреждение, работают умолчания', input: ev, expect: 'context', make: () => ({ projectDir: h.makeRoot({ files: { 'CLAUDE.md': IMPORT }, config: { reviewer: 'claude' } }) }), has: 'config.json' });

// подстраховка текстом AGENTS.md и вызов claude --version
const oldStub = h.makeClaudeStub('2.1.100');
const newStub = h.makeClaudeStub('2.1.300');
const cStub = h.makeClaudeStub('2.1.300');
cases.push({ name: 'CLAUDE.md с импортом: текст AGENTS.md не вставляется, claude --version не вызывается', input: ev, expect: 'context',
  make: () => ({ projectDir: h.makeRoot({ files: { 'CLAUDE.md': IMPORT, 'AGENTS.md': 'ПРАВИЛА-ИЗ-AGENTS' } }), path: newStub.dir }), hasNot: 'ПРАВИЛА-ИЗ-AGENTS', after: () => (newStub.called() ? 'claude --version вызван при CLAUDE.md с импортом' : null) });
cases.push({ name: 'нет импорта, Claude старше 2.1.277: AGENTS.md вставляется', input: ev, expect: 'context',
  make: () => ({ projectDir: h.makeRoot({ files: { 'AGENTS.md': 'ПРАВИЛА-ИЗ-AGENTS' } }), path: oldStub.dir }), has: 'ПРАВИЛА-ИЗ-AGENTS', after: () => (oldStub.called() ? null : 'claude --version не вызван') });
cases.push({ name: 'нет импорта, Claude новее: AGENTS.md не вставляется', input: ev, expect: 'context',
  make: () => ({ projectDir: h.makeRoot({ files: { 'AGENTS.md': 'ПРАВИЛА-ИЗ-AGENTS' } }), path: cStub.dir }), hasNot: 'ПРАВИЛА-ИЗ-AGENTS' });
const codexStub = h.makeClaudeStub('2.1.100');
cases.push({ name: 'основной Codex: claude --version НЕ вызывается и AGENTS.md не дублируется', input: ev, expect: 'context',
  make: () => ({ projectDir: h.makeRoot({ files: { 'AGENTS.md': 'ПРАВИЛА-ИЗ-AGENTS' }, config: { main: 'codex', reviewer: 'claude' } }), path: codexStub.dir }), hasNot: 'ПРАВИЛА-ИЗ-AGENTS', after: () => (codexStub.called() ? 'claude --version вызван у основного Codex' : null) });
cases.push({ name: 'inject_agents_md=always у Claude: вставляется', input: ev, expect: 'context', make: () => ({ projectDir: h.makeRoot({ files: { 'CLAUDE.md': IMPORT, 'AGENTS.md': 'ПРАВИЛА-ИЗ-AGENTS' }, config: { inject_agents_md: 'always' } }) }), has: 'ПРАВИЛА-ИЗ-AGENTS' });

// границы
cases.push({ name: 'флаг guards.session_start=false -> молчит', input: ev, expect: 'silent', make: mk({ 'CLAUDE.md': IMPORT }, { guards: { session_start: false } }) });
cases.push({ name: 'вне рабочего места -> молчит', input: (o) => start(o.cwd), expect: 'silent', make: () => ({ cwd: h.makeBare() }) });
cases.push({ name: 'источник compact/resume тоже отвечает', input: (o) => ev(o, { source: 'compact' }), expect: 'context', make: mk({ 'CLAUDE.md': IMPORT }), has: 'Роли' });

module.exports = { hook: 'session-start', cases };
