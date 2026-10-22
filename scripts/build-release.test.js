#!/usr/bin/env node
'use strict';
// Проверка build-release.js: архив собирается, sha256 в файле равна настоящей, распаковка системной программой tar даёт тот же список файлов и те же суммы,
// сборка воспроизводима, INSTALL.md выпуска содержит сумму архива, а внутри архива суммы и заглушек-слов нет в адресах.
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
const zlib = require('zlib');

const PKG = path.resolve(__dirname, '..');
const SCRIPT = path.join(__dirname, 'build-release.js');
const SB = fs.mkdtempSync(path.join(process.env.WP_TEST_TMP || os.tmpdir(), 'wp-release-'));
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('[ok] ' + n); } else { fail++; console.log('[НЕТ] ' + n + (x ? '\n' + x : '')); } };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const build = (out, extra) => { const r = cp.spawnSync(process.execPath, [SCRIPT, '--out', out, ...(extra || [])], { encoding: 'utf8' }); return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }; };
function list(dir) {
  const o = new Map();
  (function w(d) { for (const it of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, it.name); if (it.isDirectory()) w(p); else o.set(path.relative(dir, p).split(path.sep).join('/'), sha(fs.readFileSync(p))); } })(dir);
  return o;
}

try {
  const version = fs.readFileSync(path.join(PKG, 'VERSION'), 'utf8').trim();
  const top = 'workplace-installer-' + version;
  // владелец в исходном INSTALL.md: заглушка OWNER (черновик) или уже вписанное имя (выпуск); тестовое имя подставляется только в первом случае
  const srcOwner = (/github\.com\/([A-Za-z0-9-]+)\/workplace-installer\//.exec(fs.readFileSync(path.join(PKG, 'INSTALL.md'), 'utf8')) || [])[1] || 'OWNER';
  const owner = srcOwner === 'OWNER' ? 'testowner' : srcOwner;
  const out1 = path.join(SB, 'rel1'), out2 = path.join(SB, 'rel2');
  let r = build(out1, ['--owner', owner]);
  ok('сборка: код 0', r.code === 0, r.out);
  const archive = path.join(out1, top + '.tar.gz');
  ok('созданы архив, файл суммы и INSTALL.md выпуска', fs.existsSync(archive) && fs.existsSync(archive + '.sha256') && fs.existsSync(path.join(out1, 'INSTALL.md')));
  const real = sha(fs.readFileSync(archive));
  ok('сумма в файле .sha256 равна настоящей сумме архива, формат «сумма  имя»', fs.readFileSync(archive + '.sha256', 'utf8') === real + '  ' + top + '.tar.gz\n');
  const inst = fs.readFileSync(path.join(out1, 'INSTALL.md'), 'utf8');
  // в уже собранном архиве ячейка суммы без заглушки (сумма указана в INSTALL.md выпуска): подставлять нечего, проверка применима только к исходному дереву
  if (!/\| SHA256_ПРИ_ВЫПУСКЕ \|/.test(fs.readFileSync(path.join(PKG, 'INSTALL.md'), 'utf8'))) console.log('[пропущено] INSTALL.md выпуска: в этом дереве (распакованный архив) в таблице нет заглушки суммы');
  else ok('INSTALL.md выпуска: в таблице сумма архива, адреса с владельцем, заглушек в таблице нет', inst.includes('| ' + real + ' |') && inst.includes('github.com/' + owner + '/workplace-installer/releases/download/v' + version) && !/\| SHA256_ПРИ_ВЫПУСКЕ \|/.test(inst) && !/github\.com\/OWNER\//.test(inst));

  // распаковка системной программой tar (на Windows 10 и новее это bsdtar)
  const ex = path.join(SB, 'extract'); fs.mkdirSync(ex);
  fs.copyFileSync(archive, path.join(SB, path.basename(archive)));   // короткие относительные имена: GNU tar не понимает «C:» как часть пути
  const t = cp.spawnSync('tar', ['-xzf', path.basename(archive), '-C', 'extract'], { encoding: 'utf8', cwd: SB });
  ok('системный tar распаковывает архив без ошибок', t.status === 0, String(t.stderr));
  const got = list(path.join(ex, top));
  // ожидаемый список: файлы пакета, кроме служебных папок
  const SKIP = new Set(['.git', 'node_modules', 'dist', 'release', '.playwright-mcp']);
  const want = new Map();
  (function w(d) { for (const it of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, it.name); if (it.isDirectory()) { if (!SKIP.has(it.name)) w(p); } else if (it.isFile() && !/^(\.DS_Store|Thumbs\.db|desktop\.ini)$|\.tmp-\d+$/.test(it.name)) want.set(path.relative(PKG, p).split(path.sep).join('/'), true); } })(PKG);
  const missing = [...want.keys()].filter((k) => !got.has(k)), extra = [...got.keys()].filter((k) => !want.has(k));
  ok('список файлов после распаковки совпадает со списком пакета (' + want.size + ' файлов)', !missing.length && !extra.length, 'нет: ' + missing.slice(0, 5) + '; лишние: ' + extra.slice(0, 5));
  const SKIP_HASH = /\.md$/i;   // md-файлы при --owner правятся, их сверяем отдельно
  const diff = [...want.keys()].filter((k) => !SKIP_HASH.test(k) && got.get(k) !== sha(fs.readFileSync(path.join(PKG, k))));
  ok('содержимое не-md файлов не изменилось (сумма каждого совпадает)', !diff.length, diff.slice(0, 5).join(', '));
  const innerInstall = fs.readFileSync(path.join(ex, top, 'INSTALL.md'), 'utf8');
  ok('INSTALL.md внутри архива: владелец вписан, суммы архива нет, пояснение есть', new RegExp('github\\.com/' + owner + '/').test(innerInstall) && !/\| SHA256_ПРИ_ВЫПУСКЕ \|/.test(innerInstall) && /указана в INSTALL\.md выпуска/.test(innerInstall) && !innerInstall.includes(real));
  ok('в архиве нет служебных папок (.git, node_modules, release)', ![...got.keys()].some((k) => /^(\.git|node_modules|release|dist)\//.test(k)));

  // права файлов: заглушки и скрипты оболочки 0755, остальное 0644 (на Mac и Linux без бита заглушки не запустятся)
  const { readTar, modeOf } = require('./build-release.js');
  const tarEntries = readTar(zlib.gunzipSync(fs.readFileSync(archive)));
  const modeIn = (rel) => (tarEntries.find(([n]) => n === top + '/' + rel) || [])[2];
  const STUBS = ['codex', 'claude', 'git', 'python', 'python3'];
  ok('заглушки tests/stubs/codex, claude, git, python, python3 лежат в архиве с правами 0755', STUBS.every((n) => modeIn('tests/stubs/' + n) === 0o755), STUBS.map((n) => n + ':' + (modeIn('tests/stubs/' + n) || 0).toString(8)).join(' '));
  ok('обёртки .cmd, stub.js, документы и конфиги лежат с правами 0644', ['tests/stubs/codex.cmd', 'tests/stubs/stub.js', 'README.md', 'VERSION', 'core/templates/config.json'].every((p) => modeIn(p) === 0o644), ['tests/stubs/codex.cmd', 'tests/stubs/stub.js', 'README.md', 'VERSION'].map((p) => p + ':' + (modeIn(p) || 0).toString(8)).join(' '));
  ok('любой *.sh получает 0755, даже без shebang; файл без shebang и не .sh получает 0644', modeOf('tools/run.sh', Buffer.from('echo 1\n')) === 0o755 && modeOf('a.txt', Buffer.from('echo 1\n')) === 0o644 && modeOf('x', Buffer.from('#!/bin/sh\n')) === 0o755);
  if (process.platform !== 'win32') ok('системный tar сохранил бит исполнения у заглушек', STUBS.every((n) => (fs.statSync(path.join(ex, top, 'tests', 'stubs', n)).mode & 0o111) !== 0));
  else console.log('[пропущено] бит исполнения после распаковки tar проверяется только на Mac и Linux (на Windows прав нет); права в самом архиве проверены выше');

  // воспроизводимость и черновик
  r = build(out2, ['--owner', owner]);
  ok('вторая сборка даёт ту же сумму (воспроизводимость)', r.code === 0 && sha(fs.readFileSync(path.join(out2, top + '.tar.gz'))) === real, r.out);
  const out3 = path.join(SB, 'rel3');
  r = build(out3);
  const draft = fs.readFileSync(path.join(out3, 'INSTALL.md'), 'utf8');
  ok('без --owner: владелец не задан, адреса в INSTALL.md остаются как в исходнике', r.code === 0 && /владелец не задан/.test(r.out) && new RegExp('github\\.com/' + srcOwner + '/').test(draft));
  r = build(path.join(SB, 'rel4'), ['--owner', 'bad owner!']);
  ok('--owner с недопустимыми символами: отказ (код 2)', r.code === 2, r.out);
  r = build(path.join(SB, 'rel5'), ['--nope']);
  ok('неизвестный параметр: отказ (код 2)', r.code === 2, r.out);
  ok('сборка не пишет в пакет: папки release рядом со скриптами нет, если не просили', !fs.existsSync(path.join(PKG, 'release')));
} finally {
  try { fs.rmSync(SB, { recursive: true, force: true }); } catch (_) { /* не критично */ }
}
console.log('\nПройдено ' + pass + ', не прошло ' + fail + '.');
process.exit(fail ? 1 : 0);
