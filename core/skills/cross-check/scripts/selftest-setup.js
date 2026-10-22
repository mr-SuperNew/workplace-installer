#!/usr/bin/env node
'use strict';
// Кладёт в selftest/ вымышленные данные для живого теста кросс-проверки:
// input.md (источник с контрольной строкой), result.md (верный результат), result-with-error.md (с вшитой ошибкой: Бета 4,0 вместо 2,0).
const fs = require('fs');
const path = require('path');
const lib = require('./lib');

// Параметров нет: корень определяется по расположению скрипта, путей записи задать нельзя.
if (process.argv.length > 2) { process.stderr.write('selftest-setup.js не принимает параметров (корень определяется по расположению скрипта). Ничего не записано.\n'); process.exit(1); }
const rr = lib.resolveRoot();
if (rr.error) { process.stderr.write(rr.error + '\n'); process.exit(1); }
const root = rr.root;
if (lib.linkedEntries(root, ['selftest']).length) { process.stderr.write('selftest/ в корне ссылка, а не папка: запись отменена.\n'); process.exit(1); }
const src = path.join(__dirname, '..', 'fixtures', 'selftest');
const dst = path.join(root, 'selftest');
fs.mkdirSync(dst, { recursive: true });
for (const f of fs.readdirSync(src)) {
  const to = path.join(dst, f);
  if (fs.existsSync(to)) { process.stdout.write('уже есть: selftest/' + f + '\n'); continue; }
  fs.copyFileSync(path.join(src, f), to);
  process.stdout.write('создан: selftest/' + f + '\n');
}
