#!/usr/bin/env node
'use strict';
// Сборка выпуска: архив tar.gz пакета, файл с контрольной суммой sha256 и INSTALL.md выпуска с вписанной суммой.
// Только встроенные модули Node 18+, без внешних программ. Ничего не публикует и не отправляет.
//
//   node scripts/build-release.js [--out ПАПКА] [--owner ИМЯ_НА_GITHUB]
//
// В ПАПКУ (по умолчанию release/ рядом со скриптами) кладёт:
//   workplace-installer-ВЕРСИЯ.tar.gz          архив; верхняя папка внутри workplace-installer-ВЕРСИЯ
//   workplace-installer-ВЕРСИЯ.tar.gz.sha256   строка вида «сумма  имя файла» (формат shasum)
//   INSTALL.md                                 INSTALL.md выпуска: OWNER и SHA256_ПРИ_ВЫПУСКЕ заменены. Его выкладывают отдельным файлом выпуска.
// В самом архиве INSTALL.md лежит с вписанным OWNER, но без суммы архива: сумма зависит от содержимого архива, и вписать её внутрь нельзя.
// Права: 0755 у скриптов (первая строка начинается с #!, а также любой *.sh: заглушки tests/stubs/codex, claude, git, python и скрипты оболочки), у остальных файлов 0644,
// у папок 0755. Так исполняемый бит доживает до Mac и Linux, куда архив распаковывают системным tar. Тесты на CI всё равно ставят бит на своей копии заглушек.
// Архив воспроизводим: порядок файлов, права, время и владельцы заданы, байт ОС в заголовке gzip зафиксирован. Сумма совпадает при сборке той же версией Node.
// Параметр --owner необязателен: без него OWNER остаётся как есть и выпуск считается черновиком.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const PKG = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'release', '.playwright-mcp']);
const SKIP_FILES = /^(\.DS_Store|Thumbs\.db|desktop\.ini)$|\.tmp-\d+$/;
const FIXED_MTIME = 1704067200;   // 2024-01-01T00:00:00Z
const SHA_TOKEN = 'SHA256_ПРИ_ВЫПУСКЕ';
const SHA_IN_ARCHIVE = 'указана в INSTALL.md выпуска (внутрь архива её вписать нельзя)';

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
function die(s, code) { process.stderr.write(s + '\n'); process.exit(code || 1); }

function parseArgs(argv) {
  const o = { out: path.join(PKG, 'release'), owner: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') o.out = path.resolve(argv[++i] || die('У --out нет значения', 2));
    else if (argv[i] === '--owner') o.owner = argv[++i] || die('У --owner нет значения', 2);
    else die('Неизвестный параметр ' + argv[i] + '. Использование: node scripts/build-release.js [--out ПАПКА] [--owner ИМЯ]', 2);
  }
  if (o.owner && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(o.owner)) die('--owner: имя на GitHub, латиница, цифры и дефис.', 2);
  return o;
}

// Файлы пакета: [путь с прямым слэшем, абсолютный путь], по алфавиту (побайтно).
function collect(outDir) {
  const files = [];
  (function walk(d) {
    for (const it of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, it.name);
      if (it.isSymbolicLink()) die('В пакете символическая ссылка: ' + path.relative(PKG, p) + '. Ссылки в архив не кладутся.', 3);
      if (it.isDirectory()) { if (SKIP_DIRS.has(it.name) || path.resolve(p) === outDir) continue; walk(p); continue; }
      if (it.isFile() && !SKIP_FILES.test(it.name)) files.push([path.relative(PKG, p).split(path.sep).join('/'), p]);
    }
  })(PKG);
  files.sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])));
  return files;
}

// ---------- tar (ustar) ----------
function octal(n, len) { return n.toString(8).padStart(len - 1, '0') + '\0'; }
function header(name, size, type, mode) {
  const nb = Buffer.from(name, 'utf8');
  let prefix = '', base = name;
  if (nb.length > 100) {
    const cut = name.lastIndexOf('/', name.length - 2);
    base = cut >= 0 ? name.slice(cut + 1) : name;
    prefix = cut >= 0 ? name.slice(0, cut) : '';
    if (Buffer.byteLength(base) > 100 || Buffer.byteLength(prefix) > 155) die('Слишком длинный путь для tar: ' + name, 3);
  }
  const h = Buffer.alloc(512);
  h.write(base, 0, 'utf8'); h.write(octal(mode, 8), 100, 'ascii'); h.write(octal(0, 8), 108, 'ascii'); h.write(octal(0, 8), 116, 'ascii');
  h.write(octal(size, 12), 124, 'ascii'); h.write(octal(FIXED_MTIME, 12), 136, 'ascii');
  h.write('        ', 148, 'ascii'); h.write(type, 156, 'ascii');
  h.write('ustar\0', 257, 'ascii'); h.write('00', 263, 'ascii'); h.write('root', 265, 'ascii'); h.write('root', 297, 'ascii');
  h.write(prefix, 345, 'utf8');
  let sum = 0; for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return h;
}
// Права файла в архиве: 0755 у скриптов (shebang или *.sh), иначе 0644.
function modeOf(rel, data) { return /\.sh$/i.test(rel) || (data.length > 2 && data[0] === 0x23 && data[1] === 0x21) ? 0o755 : 0o644; }
function buildTar(top, entries) {
  const parts = [];
  const dirs = new Set([top]);
  for (const [rel] of entries) { const segs = rel.split('/'); for (let i = 1; i < segs.length; i++) dirs.add(top + '/' + segs.slice(0, i).join('/')); }
  const names = [...dirs].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const all = [...names.map((d) => ({ name: d + '/', dir: true })), ...entries.map(([rel, data]) => ({ name: top + '/' + rel, data }))]
    .sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
  for (const e of all) {
    if (e.dir) { parts.push(header(e.name, 0, '5', 0o755)); continue; }
    parts.push(header(e.name, e.data.length, '0', modeOf(e.name, e.data)), e.data);
    const pad = (512 - (e.data.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}
// Разбор tar обратно: список [имя, sha256 содержимого] (для самопроверки и тестов)
function readTar(buf) {
  const out = [];
  let i = 0;
  while (i + 512 <= buf.length) {
    const h = buf.subarray(i, i + 512);
    if (h.every((b) => b === 0)) break;
    const str = (a, b) => h.subarray(a, b).toString('utf8').replace(/\0.*$/, '');
    const name = (str(345, 500) ? str(345, 500) + '/' : '') + str(0, 100);
    const size = parseInt(str(124, 136).trim() || '0', 8);
    const type = String.fromCharCode(h[156]);
    i += 512;
    const mode = parseInt(str(100, 108).trim() || '0', 8);
    if (type === '0') out.push([name, sha(buf.subarray(i, i + size)), mode]);
    i += Math.ceil(size / 512) * 512;
  }
  return out;
}

// OWNER заменяется только в адресах (/OWNER/), сумма только в ячейке таблицы «Выпуск»: слова в пояснениях остаются как есть.
function stamp(text, owner, shaText) {
  let t = text;
  if (owner) t = t.replace(/\/OWNER\//g, '/' + owner + '/');
  if (shaText) t = t.replace('| ' + SHA_TOKEN + ' |', '| ' + shaText + ' |');
  return t;
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const version = (fs.readFileSync(path.join(PKG, 'VERSION'), 'utf8')).trim();
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?$/.test(version)) die('VERSION не похож на номер версии: ' + version, 3);
  const installSrc = fs.readFileSync(path.join(PKG, 'INSTALL.md'), 'utf8');
  const head = installSrc.split(/\r?\n/)[0];
  if (!head.includes(version)) die('В заголовке INSTALL.md нет версии из VERSION (' + version + '): «' + head + '». Выпуск не собран.', 3);
  if (!installSrc.includes('v' + version + '/workplace-installer-' + version + '.tar.gz')) die('Ссылка на архив в INSTALL.md не соответствует версии ' + version + '. Выпуск не собран.', 3);
  if (!installSrc.includes(SHA_TOKEN)) die('В INSTALL.md нет места для суммы (' + SHA_TOKEN + '). Выпуск не собран.', 3);

  const files = collect(o.out);
  const top = 'workplace-installer-' + version;
  const entries = files.map(([rel, abs]) => {
    let data = fs.readFileSync(abs);
    if (/\.md$/i.test(rel) && o.owner) data = Buffer.from(stamp(data.toString('utf8'), o.owner, null), 'utf8');
    if (rel === 'INSTALL.md') data = Buffer.from(stamp(installSrc, o.owner, SHA_IN_ARCHIVE), 'utf8');
    return [rel, data];
  });
  const tar = buildTar(top, entries);
  const gz = zlib.gzipSync(tar, { level: 9 });
  gz[4] = gz[5] = gz[6] = gz[7] = 0;   // время в заголовке gzip
  gz[9] = 3;                           // ОС: Unix, одинаково на Mac и Windows
  const digest = sha(gz);

  // самопроверка: распаковка в памяти даёт тот же список файлов и те же суммы
  const back = readTar(zlib.gunzipSync(gz)).filter(([n]) => !n.endsWith('/'));
  const want = entries.map(([rel, data]) => [top + '/' + rel, sha(data), modeOf(rel, data)]);
  if (JSON.stringify(back) !== JSON.stringify(want)) die('Самопроверка архива не прошла: список файлов после распаковки не совпал. Выпуск не собран.', 1);

  fs.mkdirSync(o.out, { recursive: true });
  const archive = path.join(o.out, top + '.tar.gz');
  fs.writeFileSync(archive, gz);
  fs.writeFileSync(archive + '.sha256', digest + '  ' + path.basename(archive) + '\n');
  fs.writeFileSync(path.join(o.out, 'INSTALL.md'), stamp(installSrc, o.owner, digest));
  console.log('Версия: ' + version + (o.owner ? ', владелец: ' + o.owner : ', владелец не задан (черновик: OWNER остался в тексте)'));
  console.log('Файлов в архиве: ' + entries.length);
  console.log('Архив: ' + archive);
  console.log('sha256: ' + digest);
  console.log('INSTALL.md выпуска: ' + path.join(o.out, 'INSTALL.md'));
}

if (require.main === module) main();
module.exports = { readTar, buildTar, modeOf };
