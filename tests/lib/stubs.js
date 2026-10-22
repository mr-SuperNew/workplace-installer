'use strict';
// Заглушки codex, claude, git, python для тестов: копия tests/stubs в отдельную папку с исполняемым битом.
// Исполняемый бит нужен на Mac и Linux (в git и в архиве выпуска он может не сохраниться); копия получает его сама, поэтому CI не зависит от прав исходных файлов.
// На Windows работают обёртки .cmd. Сами заглушки запускают `node stub.js <имя> ...`: тесты не зависят от оболочки sh.
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'stubs');
const ALL = ['codex', 'claude', 'git', 'python', 'python3'];

// dir: куда класть копию; names: какие заглушки нужны (по умолчанию codex и claude). Возвращает dir.
function prepare(dir, names) {
  names = names || ['codex', 'claude'];
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(SRC, 'stub.js'), path.join(dir, 'stub.js'));
  for (const n of names) {
    if (!ALL.includes(n)) throw new Error('нет заглушки ' + n);
    fs.copyFileSync(path.join(SRC, n), path.join(dir, n));
    fs.chmodSync(path.join(dir, n), 0o755);
    if (fs.existsSync(path.join(SRC, n + '.cmd'))) fs.copyFileSync(path.join(SRC, n + '.cmd'), path.join(dir, n + '.cmd'));
    else if (n === 'python3') fs.copyFileSync(path.join(SRC, 'python.cmd'), path.join(dir, 'python3.cmd'));
  }
  return dir;
}

module.exports = { SRC, ALL, prepare };
