#!/usr/bin/env node
'use strict';
// Запуск тестов сторожей: node tests/unit/hooks/run.js [имя-хука ...]
// Каждый файл <хук>.test.js экспортирует { hook, cases }. Код выхода 0, если упавших нет.
const fs = require('fs');
const path = require('path');
const h = require('./_harness');

(async () => {
  const only = process.argv.slice(2);
  const files = fs.readdirSync(__dirname).filter((f) => /\.test\.js$/.test(f)).filter((f) => !only.length || only.includes(f.replace(/\.test\.js$/, ''))).sort();
  let total = 0, failed = 0;
  const started = Date.now();
  for (const f of files) {
    const mod = require(path.join(__dirname, f));
    const res = await h.runCases(mod.hook, mod.cases);
    const bad = res.filter((r) => !r.ok);
    total += res.length; failed += bad.length;
    console.log((bad.length ? 'ПАДЕНИЕ ' : 'ok       ') + f.replace(/\.test\.js$/, '').padEnd(22) + (res.length - bad.length) + '/' + res.length);
    for (const b of bad) { console.log('  - ' + b.name); for (const p of b.problems) console.log('      ' + p); }
  }
  h.cleanup();
  console.log('\nИтого: ' + (total - failed) + ' из ' + total + ', упавших ' + failed + ', ' + Math.round((Date.now() - started) / 1000) + ' с');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); try { h.cleanup(); } catch (_) { /* ничего */ } process.exit(2); });
