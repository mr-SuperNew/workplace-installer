'use strict';
// Политика моделей: субагент без model, opus без пометки -> deny; sonnet, opus с пометкой -> пропуск; haiku -> напоминание. Только у основного Claude.
const h = require('./_harness');

const call = (tool_input, tool_name) => (o) => h.tool(tool_name || 'Agent', tool_input, { cwd: o.projectDir });
const root = (files, config) => () => ({ projectDir: h.makeRoot({ files, config }) });
const AGENT = (model) => '---\nname: reviewer-x\ndescription: x\nmodel: ' + model + '\n---\nтекст\n';

const cases = [
  { name: 'без model -> deny с подсказкой', input: call({ description: 'разбор', prompt: 'p', subagent_type: 'general-purpose' }), expect: 'deny', make: root(), has: ['sonnet', 'Политика моделей'] },
  { name: 'model: inherit -> deny', input: call({ description: 'разбор', prompt: 'p', model: 'inherit' }), expect: 'deny', make: root() },
  { name: 'без subagent_type и model -> deny', input: call({ description: 'x', prompt: 'p' }), expect: 'deny', make: root() },
  { name: 'opus без пометки -> deny', input: call({ description: 'разбор', prompt: 'p', model: 'opus' }), expect: 'deny', make: root(), has: '[opus: причина]' },
  { name: 'claude-opus-… без пометки -> deny', input: call({ description: 'разбор', prompt: 'p', model: 'claude-opus-4-8' }), expect: 'deny', make: root() },
  { name: 'opus с пометкой [opus: причина] -> пропуск', input: call({ description: '[opus: развилка проектирования] выбор схемы', prompt: 'p', model: 'opus' }), expect: 'silent', make: root() },
  { name: 'sonnet -> пропуск', input: call({ description: 'правки', prompt: 'p', model: 'sonnet' }), expect: 'silent', make: root() },
  { name: 'haiku -> напоминание, не отказ', input: call({ description: 'запуск', prompt: 'p', model: 'haiku' }), expect: 'context', make: root(), has: 'Haiku годится' },
  { name: 'модель закреплена в .claude/agents/<тип>.md -> пропуск', input: call({ description: 'x', prompt: 'p', subagent_type: 'reviewer-x' }), expect: 'silent', make: root({ '.claude/agents/reviewer-x.md': AGENT('sonnet') }) },
  { name: 'в .claude/agents/<тип>.md стоит inherit -> deny', input: call({ description: 'x', prompt: 'p', subagent_type: 'reviewer-x' }), expect: 'deny', make: root({ '.claude/agents/reviewer-x.md': AGENT('inherit') }) },
  { name: 'явный model перекрывает закреплённый', input: call({ description: 'x', prompt: 'p', subagent_type: 'reviewer-x', model: 'sonnet' }), expect: 'silent', make: root({ '.claude/agents/reviewer-x.md': AGENT('inherit') }) },
  { name: 'старое имя инструмента Task тоже проверяется', input: call({ description: 'x', prompt: 'p' }, 'Task'), expect: 'deny', make: root() },
  { name: 'основной Codex: хук молчит (у Codex аналога нет)', input: call({ description: 'x', prompt: 'p' }), expect: 'silent', make: root({}, { main: 'codex', reviewer: 'claude' }) },
  { name: 'флаг guards.model_guard=false -> молчит', input: call({ description: 'x', prompt: 'p' }), expect: 'silent', make: root({}, { guards: { model_guard: false } }) },
  { name: 'другой инструмент (Bash) -> молчит', input: (o) => h.bash('ls', { cwd: o.projectDir }), expect: 'silent', make: root() },
  { name: 'имя агента с недопустимыми знаками не ищется как файл', input: call({ description: 'x', prompt: 'p', subagent_type: '../../etc/passwd' }), expect: 'deny', make: root() },
];

module.exports = { hook: 'model-guard', cases };
