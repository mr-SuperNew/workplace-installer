#!/usr/bin/env node
'use strict';
// Проверка перед публикацией: в дереве нет имён людей, личных контактов, почт, путей с именем пользователя и ключей.
// Только встроенные модули Node 18+. Ничего не пишет и не меняет.
//
//   node scripts/check-no-private.js <папка> [--extra-list файл]
//
// Код выхода: 0 находок нет; 1 есть находки; 2 неверные параметры.
// Значения находок не печатаются: только файл, строка, класс и первая буква.
//
// Список имён хранится как хеши (sha256 от основы слова), а не словами: репозиторий публичный, и сам стоп-лист не должен раскрывать то, что он ищет.
// Слово ловится, если его основа есть в начале любого слова текста (так находятся все падежные формы). Дополнительные слова: файл по одному слову в строке,
// который лежит ВНЕ репозитория (параметр --extra-list). Сравнение без учёта регистра.
//
// Контакт автора (ссылка на Telegram) разрешён только там, где он нужен людям: README.md, INSTALL.md, шаблон отчёта (core/lib/report.js) и тесты (tests/).
// Имя автора в падежах разрешено только в README.md.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

// [длина основы, sha256 основы]: имена людей и клиентов, названия клиентских проектов, ники.
const STEMS = [[7, '5884a62fb93522e33fc3ac8fc513f3e1a50be878d4673ff005eadae662e76cc5'], [5, '8487a6325840958d219d84329624176e86e78b218036e9e5ba36dda4c210cb4c'], [5, 'fec395c3e9736808325d39a4d07a1a9314786309f972b0bac2a35267c358c424'], [5, '5357b1d90022a3b3c68abde732bcb1aa18476e7762c2b73ee28844507c149b8e'], [5, 'd7188d9a8738d31f983e3400225522c460fffbfb802ded18bb375bcaa14205b7'], [8, '61faa6e24e3380cabfb3958446f61b6701a74781702b27419b4e97491540edd1'], [5, 'ee4f919315af330b03741548c4ef61677311086fa5af896c18e2a2651d4f1e39'], [8, '710c3906ca8b54f86c9e020d989792d03b9a0d8904d7b57b3f57e74ab1746625'], [5, '88fad78d3b4811cbb609689584dc64b7a04f4335ff292d4092a74a28ebd1a4c7'], [6, '0d30d1012747a35845a9007debfe8d030a814b424f57dd7cd3516dacf9162e37'], [6, 'f682e278f40604826afe7c3148fb1cefd2c7b7b2384376922b36a49ec3bca2dc']];
// Слова целиком (короткие формы, по основе дали бы ложные срабатывания). Разрешены в README.md.
const EXACT_README_OK = new Set(['00fb669b8cb44ff56b7400803d6b4302219cc6ca4023a7bafb2b34d159aa1a7a', '9ef469e079a87e49a29605ccb95451dc20450f6b12faa5bdf5827e8f3e6b5f41', '0272729506463ee943a5e98b684972bd4f365c5936ca239d38e8465922dd1859', '9083613b933f295f0725bc60ebb507ab76662f4e2a5eb5acf2e70b6d0d95ba1b', 'bf6871d5956e42f081fc359e35ef1110fdf28fd59f07669672b404654a757a0d', '97000f9414d725b0a0f0f83620f63ed4b95a89f116691a3fd9c6de68e3a3c767', '7a648297cac66208889f6ed5a4fa8e43516414ba83e5c4d98d05e8599eede6b5']);

const CONTACT_RE = /\b(?:https?:\/\/)?(?:t|telegram)\.me\/[A-Za-z0-9_]+/gi;
const CONTACT_OK = /^(?:https?:\/\/)?t\.me\/moneyBaires$/i;
// Файлы, где контакт разрешён (пути от корня проверки, с прямым слэшем). Каталог оканчивается на /.
const CONTACT_ALLOWED = ['README.md', 'INSTALL.md', 'core/lib/report.js', 'tests/'];
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const EMAIL_OK_DOMAIN = /@(?:example\.(?:com|org|net|invalid)|localhost|users\.noreply\.github\.com)$/i;
const HOMEPATH_RE = /(?:\/Users\/|\\Users\\|\/home\/)([^\/\\\s<>"'`|:*?]+)/g;
const HOMEPATH_OK = /^(?:ИМЯ|имя|name|user|username|USER|USERNAME|you|your-name|runner|runneradmin|Public|Default|Shared|\$.*|%.*|~.*|\{.*|\.\.\.|\*)$/i;
const CHATID_RE = new RegExp('chat' + '_id', 'i');
// Ключи: те же классы, что у сторожа секретов. В tests/ не ищутся: там вымышленные образцы для проверки самого сторожа.
const TOKEN_RES = [
  ['закрытый ключ', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['ключ sk-', /\bsk-[A-Za-z0-9_-]{20,}/],
  ['ключ AWS', /\bAKIA[0-9A-Z]{16}\b/],
  ['токен GitHub', /\bgh[pousr]_[A-Za-z0-9]{30,}/],
  ['токен GitHub (fine-grained)', /\bgithub_pat_[A-Za-z0-9_]{30,}/],
  ['токен бота Telegram', /\b\d{8,10}:[A-Za-z0-9_-]{34,}/],
  ['токен Slack', /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ['ключ Google', /\bAIza[0-9A-Za-z_-]{35}/],
];
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'release', '.playwright-mcp']);
const SKIP_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|tar|7z|woff2?|ttf|otf|mp[34]|mov|webm)$/i;
const MAX_BYTES = 2 * 1024 * 1024;

function mask(w) { return w.slice(0, 1) + '***'; }

function loadExtra(file) {
  if (!file) return [];
  let t;
  try { t = fs.readFileSync(file, 'utf8'); } catch (e) { console.error('Не прочитан файл со словами: ' + file); process.exit(2); }
  return t.split(/\r?\n/).map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith('#'));
}

function walk(root) {
  const out = [];
  (function w(d) {
    let items = [];
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const it of items.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(d, it.name);
      if (it.isSymbolicLink()) continue;
      if (it.isDirectory()) { if (!SKIP_DIRS.has(it.name)) w(p); continue; }
      if (it.isFile() && !SKIP_EXT.test(it.name)) out.push(p);
    }
  })(root);
  return out;
}

// Находки одной строки: [класс, фрагмент]
function scanLine(line, rel, extra) {
  const hits = [];
  const inTests = rel.startsWith('tests/');
  for (const m of line.matchAll(/[\p{L}\p{N}_]+/gu)) {
    const tok = m[0].toLowerCase().replace(/ё/g, 'ё');
    for (const [len, hash] of STEMS) if (tok.length >= len && sha(tok.slice(0, len)) === hash) { hits.push(['имя из стоп-листа', mask(m[0])]); break; }
    if (rel !== 'README.md' && EXACT_README_OK.has(sha(tok))) hits.push(['имя автора вне README.md', mask(m[0])]);
    for (const w of extra) if (tok.startsWith(w)) { hits.push(['слово из дополнительного списка', mask(m[0])]); break; }
  }
  for (const m of line.matchAll(EMAIL_RE)) if (!EMAIL_OK_DOMAIN.test(m[0])) hits.push(['почта', mask(m[0])]);
  for (const m of line.matchAll(HOMEPATH_RE)) if (!HOMEPATH_OK.test(m[1])) hits.push(['путь с именем пользователя', mask(m[1])]);
  if (CHATID_RE.test(line)) hits.push(['идентификатор чата', '***']);
  for (const m of line.matchAll(CONTACT_RE)) {
    const allowed = CONTACT_ALLOWED.some((a) => (a.endsWith('/') ? rel.startsWith(a) : rel === a));
    if (!(CONTACT_OK.test(m[0]) && allowed)) hits.push([CONTACT_OK.test(m[0]) ? 'контакт вне разрешённых файлов' : 'чужая ссылка t.me', mask(m[0].replace(/^.*\//, ''))]);
  }
  if (!inTests) for (const [name, re] of TOKEN_RES) if (re.test(line)) hits.push([name, '***']);
  return hits;
}

function main() {
  const argv = process.argv.slice(2);
  let dir = null, extraFile = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--extra-list') extraFile = argv[++i];
    else if (argv[i].startsWith('--')) { console.error('Неизвестный параметр ' + argv[i] + '. Использование: node scripts/check-no-private.js ПАПКА [--extra-list ФАЙЛ]'); process.exit(2); }
    else if (!dir) dir = argv[i];
    else { console.error('Лишний аргумент ' + argv[i]); process.exit(2); }
  }
  if (!dir) { console.error('Использование: node scripts/check-no-private.js ПАПКА [--extra-list ФАЙЛ]'); process.exit(2); }
  const root = path.resolve(dir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) { console.error('Нет такой папки: ' + dir); process.exit(2); }
  const extra = loadExtra(extraFile);
  let files = 0, found = 0;
  for (const f of walk(root)) {
    let st; try { st = fs.statSync(f); } catch (_) { continue; }
    if (st.size > MAX_BYTES) continue;
    const buf = fs.readFileSync(f);
    if (buf.includes(0)) continue;
    files++;
    const rel = path.relative(root, f).split(path.sep).join('/');
    // сам файл стоп-листа хранит только хеши, но имя файла проверяется как обычный текст
    const nameHits = scanLine(rel, rel, extra);
    for (const [cls, frag] of nameHits) { found++; console.log(rel + ': (имя файла): ' + cls + ' ' + frag); }
    buf.toString('utf8').split(/\r?\n/).forEach((line, i) => {
      for (const [cls, frag] of scanLine(line, rel, extra)) { found++; console.log(rel + ':' + (i + 1) + ': ' + cls + ' ' + frag); }
    });
  }
  if (found) { console.log('\nНайдено: ' + found + ' (файлов проверено: ' + files + '). Публиковать нельзя.'); process.exit(1); }
  console.log('Находок нет (файлов проверено: ' + files + ').');
}

if (require.main === module) main();
module.exports = { scanLine };
