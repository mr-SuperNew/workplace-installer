'use strict';
// Тестовая обёртка: запускает wp.js в ЭТОМ же процессе, предварительно поставив бэкенд PATH пользователя - файл вместо реестра.
//   node tests/lib/wp-with-backend.js <путь к wp.js> <файл PATH> <настройки JSON> <аргументы wp.js...>
// Рабочий код выбор бэкенда из окружения или файлов не знает: единственная точка входа - __setUserPathBackendForTests в модуле install.js, и вызывает её только эта обёртка.
// Файл PATH должен лежать во временной папке теста. Рядом: <файл>.kind (тип значения), <файл>.calls (журнал вызовов бэкенда: read, write, notify).
// Настройки: { notify: true|false|'throw' (итог рассылки), corrupt: true (запись портит значение), failWrite: true (запись не удалась) }.
const fs = require('fs');
const path = require('path');

const wp = path.resolve(process.argv[2] || '');
const file = path.resolve(process.argv[3] || '');
const opts = JSON.parse(process.argv[4] || '{}');
const args = process.argv.slice(5);
if (!process.argv[2] || !process.argv[3]) { process.stderr.write('wp-with-backend: нужны путь к wp.js и файл PATH\n'); process.exit(64); }

const install = require(path.join(path.dirname(wp), '..', 'lib', 'install.js'));
const kf = file + '.kind';
const calls = file + '.calls';
const note = (x) => fs.appendFileSync(calls, x + '\n');
install.__setUserPathBackendForTests({
  kind: 'test-file',
  read() {
    note('read');
    const kind = fs.existsSync(kf) ? fs.readFileSync(kf, 'utf8').trim() : 'ExpandString';
    return { user: fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\r?\n$/, '') : '', machine: '', kind: ['String', 'ExpandString'].includes(kind) ? kind : 'ExpandString' };
  },
  write(value, kind) {
    note('write');
    if (opts.failWrite) return { ok: false };
    fs.writeFileSync(file, (opts.corrupt ? value + ';C:\\Лишнее' : value) + '\n');
    fs.writeFileSync(kf, kind + '\n');
    return { ok: true };
  },
  notify() {
    note('notify');
    if (opts.notify === 'throw') throw new Error('рассылка упала (тест)');
    return opts.notify === false ? { notified: false, why: 'тест: система вернула ноль' } : { notified: true };
  },
});
process.argv = [process.argv[0], wp, ...args];
require(wp);
