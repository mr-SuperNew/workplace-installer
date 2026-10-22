'use strict';
// Мусорный ввод на stdin: код выхода 0 и молчание у каждого хука (хук не должен ломать работу).
const h = require('./_harness');

const HOOKS = ['secret-guard', 'session-start', 'danger-guard', 'feedback-reminder', 'cross-check-guard', 'model-guard', 'human-message'];
const JUNK = [
  ['пустой ввод', ''],
  ['только пробелы', '   \n  '],
  ['не JSON', 'не json{{'],
  ['пустой объект', '{}'],
  ['массив', '[1,2]'],
  ['null', 'null'],
  ['строка', '"текст"'],
  ['число', '123'],
  ['обрезанный JSON', '{"tool_name":"Bash","tool_input":{"command":"rm -rf /'],
  ['tool_input не объект', JSON.stringify({ tool_name: 'Bash', tool_input: 5 })],
  ['tool_input null', JSON.stringify({ tool_name: 'Write', tool_input: null })],
  ['неизвестное событие', JSON.stringify({ hook_event_name: 'Nope', tool_name: 'Nope', tool_input: {} })],
];

const root = h.makeRoot();
const cases = [];
for (const hook of HOOKS) {
  for (const [what, input] of JUNK) {
    cases.push({ name: hook + ': ' + what, hook, input, expect: 'silent', opts: { projectDir: root } });
  }
  // и вне рабочего места
  cases.push({ name: hook + ': мусор вне рабочего места', hook, input: 'не json{{', expect: 'silent', make: () => ({ cwd: h.makeBare() }) });
}

module.exports = { hook: 'junk', cases };
