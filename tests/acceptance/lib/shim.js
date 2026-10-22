'use strict';
// Прокладка в PATH песочницы: node shim.js <имя> <аргументы...>.
// Установки, обновления и удаления программ НЕ выполняются (стенд приёмки не меняет настоящую машину), вызов пишется в журнал.
// Команды на чтение (версии, списки, поиск) и все остальное идёт к настоящей программе: путь в переменной ACC_REAL_<ИМЯ>.
// Журнал: файл из ACC_EVENTS, одна строка JSON на вызов.
const fs = require('fs');
const cp = require('child_process');

const name = process.argv[2];
const args = process.argv.slice(3);
const sub = args.find((a) => !a.startsWith('-')) || '';
const has = (re) => re.test(args.join(' '));

const RULES = {
  npm: () => /^(i|in|ins|install|add|update|upgrade|up|uninstall|un|remove|rm|link|ln|ci|publish|exec|x|init|create|dedupe|prune|rebuild)$/.test(sub),
  npx: () => true,
  pnpm: () => /^(add|install|i|update|up|remove|rm|dlx)$/.test(sub),
  yarn: () => /^(add|install|upgrade|remove|global|dlx)$/.test(sub),
  pip: () => /^(install|uninstall|download|wheel)$/.test(sub),
  pip3: () => /^(install|uninstall|download|wheel)$/.test(sub),
  winget: () => /^(install|upgrade|uninstall|import|configure|repair)$/.test(sub),
  choco: () => /^(install|upgrade|uninstall|update|pin)$/.test(sub),
  scoop: () => /^(install|update|uninstall|upgrade)$/.test(sub),
  brew: () => /^(install|upgrade|uninstall|reinstall|update|tap|untap|link|unlink|cask)$/.test(sub),
  apt: () => true, 'apt-get': () => true, dnf: () => true, yum: () => true, msiexec: () => true, sudo: () => true,
  claude: () => /^(update|upgrade|install|uninstall|migrate-installer)$/.test(sub),
  codex: () => /^(update|upgrade|install|uninstall)$/.test(sub),
  python: () => /^-m$/.test(args[0] || '') && /^(pip|ensurepip)$/.test(args[1] || '') && (/^(install|uninstall|download|wheel)$/.test(args.slice(2).find((a) => !a.startsWith('-')) || '') || args[1] === 'ensurepip'),
};
RULES.python3 = RULES.python; RULES.py = RULES.python;

const blocked = !!(RULES[name] && RULES[name]());
if (process.env.ACC_EVENTS) {
  try { fs.appendFileSync(process.env.ACC_EVENTS, JSON.stringify({ at: new Date().toISOString(), src: 'shim', name, args: args.map((a) => (/^(codex|claude)$/.test(name) ? String(a) : String(a).slice(0, 200))), blocked, cwd: process.cwd() }) + '\n'); } catch (_) { /* журнал не мешает */ }
}
if (blocked) {
  process.stderr.write('[стенд приёмки] Команда заблокирована стендом: на тестовой машине программы не ставятся и не обновляются. Ничего не выполнено.\n');
  process.exit(1);
}
const real = process.env['ACC_REAL_' + name.toUpperCase().replace(/-/g, '_')];
if (!real) { process.stderr.write(name + ': программа не найдена\n'); process.exit(127); }
const viaShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(real);
const q = (a) => (a === '' ? '""' : /[\s"&|<>^()%!]/.test(a) ? '"' + String(a).replace(/"/g, '\\"') + '"' : a);
const r = viaShell
  ? cp.spawnSync([real, ...args].map(q).join(' '), { stdio: 'inherit', shell: true, env: process.env })
  : cp.spawnSync(real, args, { stdio: 'inherit', env: process.env });
process.exit(r.status === null ? 1 : r.status);
