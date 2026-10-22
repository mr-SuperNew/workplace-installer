#!/usr/bin/env node
'use strict';
// Проверка самого check-no-private.js: чистая папка даёт 0 находок, подставленные файлы с именем, почтой, путём, чужим контактом и ключом дают находки.
// Образцы собираются из кусков во время работы: в файле нет ни одного настоящего имени (репозиторий публичный).
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const SCRIPT = path.join(__dirname, 'check-no-private.js');
const SB = fs.mkdtempSync(path.join(process.env.WP_TEST_TMP || os.tmpdir(), 'wp-private-'));
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('[ok] ' + n); } else { fail++; console.log('[НЕТ] ' + n + (x ? '\n' + x : '')); } };
const run = (dir, extra) => { const r = cp.spawnSync(process.execPath, [SCRIPT, dir, ...(extra || [])], { encoding: 'utf8' }); return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }; };
const put = (d, f, t) => { const p = path.join(d, f); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); };
const at = String.fromCharCode(64);
const HANDLE = 'money' + 'Baires';
const USERS = '/Us' + 'ers/';
// Образцы имён из кодов букв, чтобы не писать слова в файле
const w = (...c) => String.fromCharCode(...c);
const STEM_NAME = w(0x410, 0x43d, 0x442, 0x43e, 0x43d);
const AUTHOR = w(0x418, 0x43b, 0x44c, 0x44f);

try {
  const clean = path.join(SB, 'clean');
  put(clean, 'README.md', 'Обычный текст. Контакт: https://t.me/' + HANDLE + '\n');
  put(clean, 'docs/a.md', 'Пример пути: %USERPROFILE%/workplace и ' + USERS + 'ИМЯ/workplace, почта test' + at + 'example.com\n');
  put(clean, 'INSTALL.md', 'Контакт: https://t.me/' + HANDLE + '\n');
  let r = run(clean);
  ok('чистая папка: 0 находок, код 0', r.code === 0 && /Находок нет/.test(r.out), r.out);

  const dirty = (name, file, text, cls) => {
    const d = path.join(SB, name);
    put(d, file, text);
    const x = run(d);
    ok(name + ': находка «' + cls + '», код 1, значение не напечатано', x.code === 1 && x.out.includes(cls) && !x.out.includes(text.trim()), x.out);
  };
  dirty('name', 'docs/b.md', 'Вчера ' + STEM_NAME + 'а попросили поставить.\n', 'имя из стоп-листа');
  dirty('author', 'docs/c.md', 'Спросите ' + AUTHOR + '.\n', 'имя автора вне README.md');
  dirty('mail', 'docs/d.md', 'Пишите на ivan.petrov' + at + 'mail.ru\n', 'почта');
  dirty('home', 'docs/e.md', 'Файл лежит в ' + USERS + 'vasya/projects\n', 'путь с именем пользователя');
  dirty('contact', 'docs/f.md', 'Пишите: https://t.me/' + HANDLE + '\n', 'контакт вне разрешённых файлов');
  dirty('other-link', 'README.md', 'Пишите: https://t.me/' + 'someone_else' + '\n', 'чужая ссылка t.me');
  dirty('chat', 'docs/g.md', 'chat' + '_id = 1\n', 'идентификатор чата');
  dirty('token', 'docs/h.md', 'key = ghp_' + 'a'.repeat(36) + '\n', 'токен GitHub');

  const readme = path.join(SB, 'readme-name');
  put(readme, 'README.md', 'Автор: ' + AUTHOR + '.\n');
  r = run(readme);
  ok('имя автора в README.md разрешено', r.code === 0, r.out);

  const nameInPath = path.join(SB, 'fname');
  put(nameInPath, STEM_NAME.toLowerCase() + '-notes.md', 'пусто\n');
  r = run(nameInPath);
  ok('имя в названии файла тоже находка', r.code === 1 && /имя файла/.test(r.out), r.out);

  const extraList = path.join(SB, 'extra.txt');
  fs.writeFileSync(extraList, '# слова вне репозитория\nsecretproject\n');
  const ex = path.join(SB, 'extra'); put(ex, 'docs/x.md', 'Проект SecretProject в работе\n');
  r = run(ex, ['--extra-list', extraList]);
  ok('слово из дополнительного списка находится', r.code === 1 && /дополнительного списка/.test(r.out), r.out);
  r = run(ex);
  ok('без дополнительного списка то же слово не находится', r.code === 0, r.out);

  r = run(path.join(SB, 'нет-такой'));
  ok('несуществующая папка: код 2', r.code === 2, r.out);
  r = cp.spawnSync(process.execPath, [SCRIPT, clean, '--out', 'x'], { encoding: 'utf8' });
  ok('неизвестный параметр: код 2', r.status === 2);
} finally {
  try { fs.rmSync(SB, { recursive: true, force: true }); } catch (_) { /* не критично */ }
}
console.log('\nПройдено ' + pass + ', не прошло ' + fail + '.');
process.exit(fail ? 1 : 0);
