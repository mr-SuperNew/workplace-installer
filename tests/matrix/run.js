#!/usr/bin/env node
'use strict';
// Матрица 4 случая × 2 направления (G5): каждое сочетание гоняется отдельным процессом tests/matrix/case.js, по несколько одновременно.
//   node tests/matrix/run.js [--only случай:основной ...] [--jobs N]
// Засчитывается только полный набор из 8 сочетаний: прогон одного направления набором не считается (код 1). С --only набор неполный и тоже красный:
// фильтр нужен негативной проверке, а не человеку.
const path = require('path');
const H = require('../lib/harness');

const CASES = ['empty', 'claude-only', 'codex-only', 'scattered'];
const MAINS = ['claude', 'codex'];
const argv = process.argv.slice(2);
const only = [];
let jobs = Math.max(1, Math.min(4, (require('os').cpus() || []).length || 2));
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--only') only.push(argv[++i]);
  else if (argv[i] === '--jobs') jobs = Math.max(1, parseInt(argv[++i], 10) || 1);
  else { console.error('Неизвестный параметр ' + argv[i]); process.exit(2); }
}
const all = CASES.flatMap((c) => MAINS.map((m) => c + ':' + m));
const todo = only.length ? all.filter((x) => only.includes(x)) : all;
if (!todo.length) { console.error('По фильтру нет ни одного сочетания. Доступны: ' + all.join(', ')); process.exit(2); }

(async () => {
  const t0 = Date.now();
  const results = [];
  let next = 0;
  async function worker() {
    while (next < todo.length) {
      const item = todo[next++];
      const [c, m] = item.split(':');
      const r = await H.nodeAsync(path.join(__dirname, 'case.js'), [c, m], { cwd: __dirname, timeout: 900000 });
      const sum = r.out.match(/Проверок пройдено: (\d+), падений: (\d+)/);
      results.push({ item, code: r.code, pass: sum ? +sum[1] : 0, failed: sum ? +sum[2] : null, out: r.all });
      console.log((r.code === 0 ? 'ok       ' : 'ПАДЕНИЕ  ') + item.padEnd(20) + (sum ? sum[1] + ' проверок, падений ' + sum[2] : 'итога нет (код ' + r.code + ')'));
    }
  }
  await Promise.all(Array.from({ length: Math.min(jobs, todo.length) }, worker));
  results.sort((a, b) => (a.item < b.item ? -1 : 1));
  let bad = 0, pass = 0;
  for (const r of results) {
    pass += r.pass;
    if (r.code !== 0) { bad++; console.log('\n--- ' + r.item + ' (код ' + r.code + ')\n' + r.out.split('\n').filter((l) => /ПАДЕНИЕ|^    |^ - |Error|Traceback/.test(l)).slice(0, 40).join('\n')); }
  }
  const complete = todo.length === all.length;
  console.log('\nСочетаний: ' + results.length + ' из ' + all.length + (complete ? ' (оба направления, все 4 случая)' : ' (НЕПОЛНЫЙ набор по фильтру: не засчитывается)') + '. Проверок пройдено: ' + pass + ', падений: ' + bad + ' сочетаний с падениями (' + Math.round((Date.now() - t0) / 1000) + ' с)');
  const bothDirections = MAINS.every((m) => results.some((r) => r.item.endsWith(':' + m) && r.code === 0));
  if (!bothDirections) console.log('Направление не прошло ни разу: прогон одного направления не засчитывается.');
  process.exit(bad || !complete || !bothDirections ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
