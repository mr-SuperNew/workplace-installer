'use strict';
// Корень рабочего места = папка, в которой лежит метка `.workplace/` (с config.json или state.json внутри).
// Корень ищется вверх от переданной папки. Хуки Codex запускаются из подпапки, переменной CLAUDE_PROJECT_DIR у Codex нет, поэтому поиск вверх обязателен.
const fs = require('fs');
const path = require('path');

const MARK = '.workplace';

function isRoot(dir) {
  try {
    const m = path.join(dir, MARK);
    if (!fs.statSync(m).isDirectory()) return false;
    return fs.existsSync(path.join(m, 'config.json')) || fs.existsSync(path.join(m, 'state.json'));
  } catch (_) { return false; }
}

// Ближайший корень вверх от start (включая саму папку) или null.
function findRoot(start) {
  let cur = path.resolve(start || process.cwd());
  for (;;) {
    if (isRoot(cur)) return cur;
    const up = path.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}

// Для хуков и скриптов навыков: сначала по расположению самого скрипта (<корень>/.workplace/core/...: надёжнее всего),
// потом CLAUDE_PROJECT_DIR, потом cwd из входа хука, потом текущая папка.
function resolveRoot(o) {
  o = o || {};
  const tries = [];
  if (o.scriptDir) tries.push(o.scriptDir);
  if (process.env.CLAUDE_PROJECT_DIR) tries.push(process.env.CLAUDE_PROJECT_DIR);
  if (o.cwd) tries.push(o.cwd);
  tries.push(process.cwd());
  for (const t of tries) { const r = findRoot(t); if (r) return r; }
  return null;
}

// Пути внутри корня в одном месте: на них опираются хуки, навыки и тесты.
function paths(root) {
  const wp = path.join(root, MARK);
  return {
    root,
    mark: wp,
    config: path.join(wp, 'config.json'),
    state: path.join(wp, 'state.json'),
    stateMd: path.join(root, 'STATE.md'),
    core: path.join(wp, 'core'),
    hooks: path.join(wp, 'core', 'hooks'),
    lib: path.join(wp, 'core', 'lib'),
    cli: path.join(wp, 'core', 'cli', 'wp.js'),
    modules: path.join(wp, 'modules'),
    version: path.join(wp, 'VERSION'),
    snapshots: path.join(wp, 'snapshots'),
    backupUpdate: path.join(wp, 'backup-update'),
    npmCache: path.join(wp, 'npm-cache'),
    reconBefore: path.join(wp, 'recon-before.json'),
    claudeSettings: path.join(root, '.claude', 'settings.json'),
    codexHooks: path.join(root, '.codex', 'hooks.json'),
    claudeSkills: path.join(root, '.claude', 'skills'),
    agentsSkills: path.join(root, '.agents', 'skills'),
    checks: path.join(root, 'checks'),
    workspaces: path.join(root, 'workspaces'),
    handoffs: path.join(root, 'handoffs'),
    report: path.join(root, 'install-report.md'),
  };
}

module.exports = { MARK, isRoot, findRoot, resolveRoot, paths };
