#!/usr/bin/env node
'use strict';
// Самопроверка кросс-проверки одной командой: проверяющий должен уметь краснеть. Два запуска проверяющего, данные вымышленные.
//   1. верная копия (selftest/result.md)            -> принято, GREEN (YELLOW допустим)
//   2. копия с вшитой ошибкой (Бета 4,0 вместо 2,0) -> принято, RED, в находках названы Бета и 4,0
// Те же шаги, что в SKILL.md (selftest-setup, prepare-check, run-check, finalize-check), вызываются по очереди. Платных ключей не использует:
// проверяющий работает по подписке, но два запуска тратят его лимит.
//   node selftest-run.js [--timeout 540]
// Код выхода 0: обе проверки приняты. 1: нет. Что делать при провале, написано в выводе.
const cp = require('child_process');
const path = require('path');
const lib = require('./lib');

const parsed = lib.parseArgs(process.argv.slice(2), { bool: [], value: ['timeout'], positional: 0 });
if (parsed.error) { process.stderr.write(parsed.error + '\n'); process.exit(1); }
const timeout = String(Math.max(5, parseInt(parsed.args.timeout || '540', 10) || 540));
const rr = lib.resolveRoot();
if (rr.error) { process.stderr.write(rr.error + '\n'); process.exit(1); }
const root = rr.root;
const lc = lib.loadConfig(root);
if (lc.error) { process.stderr.write(lc.error + '\n'); process.exit(1); }

function node(script, argv) {
  const r = cp.spawnSync(process.execPath, [path.join(__dirname, script), ...argv], { cwd: root, encoding: 'utf8', env: process.env, timeout: (parseInt(timeout, 10) + 60) * 1000 });
  return { code: r.status, out: String(r.stdout || '') + String(r.stderr || '') };
}
const say = (s) => process.stdout.write(s + '\n');
const dirOf = (out) => (out.match(/Папка проверки:\s*(checks\/\S+)/) || [])[1] || null;

say('Самопроверка кросс-проверки: ' + lc.main.label + ' делает, ' + lc.reviewer.label + ' проверяет. Вторая копия заведомо неверная: она нужна, чтобы убедиться, что проверяющий ловит ошибки.');
let r = node('selftest-setup.js', []);
if (r.code !== 0) { say(r.out.trim()); process.exit(1); }

function one(label, resultFile, finalizeArgs, okVerdicts) {
  say('--- ' + label + ' ---');
  let p = node('prepare-check.js', ['--name', label, '--label', label, '--task', 'Посчитать выручку на сотрудника по каждой компании', '--result', resultFile, '--sources', 'selftest/input.md', '--must-quote', 'КОНТРОЛЬНАЯ СТРОКА']);
  if (p.code !== 0) { say('prepare-check не удался: ' + p.out.trim()); return false; }
  const dir = dirOf(p.out);
  if (!dir) { say('Не найдена папка проверки в выводе prepare-check.'); return false; }
  p = node('run-check.js', [dir, '--timeout', timeout]);
  say(p.out.trim());
  if (p.code !== 0) return false;
  p = node('finalize-check.js', [dir, ...finalizeArgs]);
  say(p.out.trim());
  if (p.code !== 0) return false;
  const m = p.out.match(/ВЕРДИКТ (GREEN|YELLOW|RED)/);
  if (!m || !okVerdicts.includes(m[1])) { say('Вердикт ' + (m ? m[1] : '?') + ' не тот, что нужен (' + okVerdicts.join(' или ') + ').'); return false; }
  return true;
}
const good = one('selftest-good', 'selftest/result.md', [], ['GREEN', 'YELLOW']);
const bad = one('selftest-bad', 'selftest/result-with-error.md', ['--expect-mention', 'Бета|4,0', '--expect-verdict', 'RED'], ['RED']);
say('');
if (good && bad) {
  say('Самопроверка пройдена: верная копия принята (GREEN или YELLOW), копия с ошибкой принята как RED с названной ошибкой.');
  say('Отметка этапа: node .workplace/core/cli/wp.js state set P3.selftest done --action created');
  process.exit(0);
}
say('Самопроверка НЕ пройдена (' + (good ? '' : 'верная копия не принята; ') + (bad ? '' : 'копия с ошибкой не принята или не покраснела') + '). Проверка слепая: ей нельзя доверять. Дальше не идти, показать человеку, что именно не сработало (checks/*/manifest.json, review.log). Файлы selftest/ не удалять.');
process.exit(1);
