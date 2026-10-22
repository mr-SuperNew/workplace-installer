'use strict';
// Гейт настоящей машины: снимок до и после прогона. Любое отличие делает прогон КРАСНЫМ.
// Только чтение: хеши файлов (содержимое не печатается), списки пакетов, версии программ. Секрет-файлы не читаются.
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');

const IS_WIN = process.platform === 'win32';
const HOME = os.homedir();

function sha(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch (_) { return 'ABSENT'; }
}
function vscodeSettings() {
  if (IS_WIN) return path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'Code', 'User', 'settings.json');
  if (process.platform === 'darwin') return path.join(HOME, 'Library', 'Application Support', 'Code', 'User', 'settings.json');
  return path.join(HOME, '.config', 'Code', 'User', 'settings.json');
}
function out(cmd, args, timeout) {
  // Настоящее окружение, команды только на чтение. На Windows .cmd запускаются через оболочку.
  const r = cp.spawnSync(cmd, args, { encoding: 'utf8', timeout: timeout || 60000, shell: IS_WIN, windowsHide: true, env: process.env });
  return (String(r.stdout || '') + (r.status === 0 ? '' : '\n[код ' + r.status + '] ' + String(r.stderr || '').trim().split(/\r?\n/)[0])).trim();
}

// Файлы: хеш или ABSENT. Папки-ловушки: не должны появиться в настоящем доме.
function files() {
  const f = {
    '~/.zshrc': path.join(HOME, '.zshrc'),
    '~/.bashrc': path.join(HOME, '.bashrc'),
    '~/.profile': path.join(HOME, '.profile'),
    '~/.claude/settings.json': path.join(HOME, '.claude', 'settings.json'),
    '~/.codex/config.toml': path.join(HOME, '.codex', 'config.toml'),
    'VS Code settings.json': vscodeSettings(),
  };
  const r = {};
  for (const [k, p] of Object.entries(f)) r[k] = sha(p);
  if (IS_WIN) {
    // PATH пользователя в реестре: установщики дописывают его, это изменение настоящей машины
    const q = cp.spawnSync('reg', ['query', 'HKCU\\Environment', '/v', 'Path'], { encoding: 'utf8', windowsHide: true });
    r['реестр: PATH пользователя (хеш)'] = q.status === 0 ? crypto.createHash('sha256').update(String(q.stdout)).digest('hex') : 'ABSENT';
  }
  for (const d of ['old-tmp', 'work', 'bin']) r['есть ли ~/' + d] = fs.existsSync(path.join(HOME, d)) ? 'EXISTS' : 'ABSENT';
  return r;
}
// Полный снимок: плюс списки пакетов и версии.
function snapshot(opts) {
  const s = { at: new Date().toISOString(), files: files() };
  if (!(opts && opts.quick)) {
    s.lists = {
      'npm ls -g --depth=0': out('npm', ['ls', '-g', '--depth=0']),
      'pip list': out('python', ['-m', 'pip', 'list', '--disable-pip-version-check']),
    };
    s.versions = { claude: out('claude', ['--version']), codex: out('codex', ['--version']) };
  }
  return s;
}
// Возвращает список отличий (пустой = без изменений). Сравниваются только общие разделы снимков.
function diff(a, b) {
  const d = [];
  for (const sec of ['files', 'lists', 'versions']) {
    if (!a[sec] || !b[sec]) continue;
    for (const k of Object.keys(a[sec])) {
      if (a[sec][k] === b[sec][k]) continue;
      if (sec === 'lists') {
        const A = new Set(String(a[sec][k]).split(/\r?\n/)), B = new Set(String(b[sec][k]).split(/\r?\n/));
        d.push({ section: sec, key: k, before: 'убрано: ' + ([...A].filter((x) => !B.has(x)).join('; ') || '-'), after: 'добавлено: ' + ([...B].filter((x) => !A.has(x)).join('; ') || '-') });
      } else d.push({ section: sec, key: k, before: shorten(a[sec][k]), after: shorten(b[sec][k]) });
    }
  }
  return d;
}
const shorten = (v) => (String(v).length > 120 ? String(v).slice(0, 117) + '...' : String(v));

module.exports = { snapshot, diff, vscodeSettings, HOME };
