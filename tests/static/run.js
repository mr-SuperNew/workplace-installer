#!/usr/bin/env node
'use strict';
// Статические проверки всего пакета (G4, G10): синтаксис каждого .js, стоп-фразы и запрещённые команды в любом файле, имена людей (по хеш-списку),
// окончания строк (LF везде, CRLF только в .cmd), исполняемые заглушки с shebang.
//   node tests/static/run.js
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const H = require('../lib/harness');
const { scanLine } = require(path.join(H.KIT, 'scripts', 'check-no-private.js'));

const S = new H.Suite('static');
const SKIP = new Set(['.git', 'node_modules', 'release', 'dist', '.playwright-mcp']);
const TEXT = /\.(js|md|json|tpl|yml|yaml|txt|cmd|sh)$/i;

const files = [];
(function walk(d) {
  for (const it of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, it.name);
    if (it.isDirectory()) { if (!SKIP.has(it.name)) walk(p); continue; }
    if (it.isFile()) files.push(p);
  }
})(H.KIT);
const rel = (p) => path.relative(H.KIT, p).split(path.sep).join('/');
const textFiles = files.filter((p) => TEXT.test(p) || ['LICENSE', 'VERSION'].includes(path.basename(p)) || ['codex', 'claude', 'git', 'python', 'python3'].includes(path.basename(p)));

S.section('синтаксис: node --check у каждого .js');
const js = files.filter((p) => /\.js$/.test(p));
for (const f of js) { const r = cp.spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' }); S.ok('node --check ' + rel(f), r.status === 0, r.stderr); }

S.section('G4: стоп-фразы и запрещённые команды (фразы собраны из частей: в самом тесте их нет)');
const STOP = [['с ', 'И', 'льёй'].join(''), 'без при' + 'смотра', 'сам ничего не ' + 'ставь', 'не входи в ' + 'аккаунт', 'на за' + 'нятии', 'git add ' + '-A', '--' + 'bare'];
for (const ph of STOP) {
  const hits = [];
  for (const f of textFiles) { const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/); lines.forEach((l, i) => { if (l.includes(ph)) hits.push(rel(f) + ':' + (i + 1)); }); }
  S.ok('в пакете нет «' + ph + '»', hits.length === 0, hits.slice(0, 6).join(', '));
}

S.section('G10: имена людей, личные почты, пути с именем пользователя (хеш-список check-no-private)');
const bad = [];
for (const f of textFiles) fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach((l, i) => { for (const [cls] of scanLine(l, rel(f), [])) bad.push(rel(f) + ':' + (i + 1) + ' ' + cls); });
S.ok('находок нет (' + textFiles.length + ' файлов)', bad.length === 0, bad.slice(0, 8).join('; '));

S.section('окончания строк и заглушки');
const crlf = textFiles.filter((f) => !/\.cmd$/i.test(f) && fs.readFileSync(f).includes(13)).map(rel);
S.ok('CRLF только в .cmd (остальное LF): иначе скрипты оболочки на Mac и Linux не запустятся', crlf.length === 0, crlf.slice(0, 8).join(', '));
const cmdLf = files.filter((f) => /\.cmd$/i.test(f) && !fs.readFileSync(f, 'utf8').includes('\r\n')).map(rel);
S.ok('у каждой .cmd-обёртки окончания CRLF', cmdLf.length === 0, cmdLf.join(', '));
for (const n of ['codex', 'claude', 'git', 'python', 'python3']) S.ok('tests/stubs/' + n + ': первая строка #!/bin/sh', fs.readFileSync(path.join(H.KIT, 'tests', 'stubs', n), 'utf8').startsWith('#!/bin/sh\n'));
S.ok('в пакете есть VERSION, INSTALL.md, README.md, LICENSE и ci.yml', ['VERSION', 'INSTALL.md', 'README.md', 'LICENSE', '.github/workflows/ci.yml'].every((n) => fs.existsSync(path.join(H.KIT, n))));
const ci = fs.readFileSync(path.join(H.KIT, '.github', 'workflows', 'ci.yml'), 'utf8');
S.ok('CI гоняет негативные мутации (tests/negative/run.js): ослабление наборов не пройдёт незамеченным (L10)', /tests\/negative\/run\.js/.test(ci));
S.ok('CI запускает node tests/run-all.js на macOS и Windows', /tests\/run-all\.js/.test(ci) && /macos-[\w.-]+/.test(ci) && /windows-latest/.test(ci));

process.exit(S.finish());
