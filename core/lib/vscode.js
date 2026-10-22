'use strict';
// VS Code и его расширения: только чтение имён папок. Расширение Codex не считается консольным Codex (решение 21.10): здесь только факт «расширение есть».
const path = require('path');
const u = require('./util');

const EXT_ID_RE = /^(anthropic\.claude-code|openai\.chatgpt|openai\.codex[\w-]*|github\.copilot[\w-]*|ms-python\.python)-(\d+\.\d+[\w.]*)/i;

function extDirs() {
  const h = u.homeDir();
  return ['.vscode', '.vscode-insiders', '.cursor', '.windsurf', '.vscode-oss'].map((d) => path.join(h, d, 'extensions')).filter(u.exists);
}

// { 'anthropic.claude-code': [{version, dir, base}], ... }
function listExtensions() {
  const out = {};
  for (const base of extDirs()) {
    for (const n of u.listDir(base) || []) {
      const m = n.match(EXT_ID_RE);
      if (!m) continue;
      const id = m[1].toLowerCase();
      const rec = { version: m[2].replace(/-(win32|darwin|linux)-.*$/, ''), where: u.tilde(path.join(base, n)) };
      Object.defineProperty(rec, 'dir', { value: path.join(base, n), enumerable: false });   // абсолютный путь не попадает в JSON разведки
      (out[id] = out[id] || []).push(rec);
    }
  }
  for (const id of Object.keys(out)) out[id].sort((a, b) => u.cmpVer(b.version, a.version));
  return out;
}

function appCandidates() {
  const h = u.homeDir();
  if (u.IS_MAC) return ['/Applications/Visual Studio Code.app/Contents/Resources/app', path.join(h, 'Applications/Visual Studio Code.app/Contents/Resources/app')];
  if (u.IS_WIN) return [path.join(u.localAppData(), 'Programs/Microsoft VS Code/resources/app'), 'C:/Program Files/Microsoft VS Code/resources/app', 'C:/Program Files (x86)/Microsoft VS Code/resources/app'];
  return ['/usr/share/code/resources/app', '/opt/visual-studio-code/resources/app'];
}

function collect() {
  const r = { app: null, version: null, cli: null, cli_version: null, forks: [], extensions: listExtensions() };
  for (const c of appCandidates()) {
    const pj = u.readJson(path.join(c, 'package.json'));
    if (pj) { r.app = u.tilde(c.replace(/\/Contents\/Resources\/app$|\/resources\/app$/, '')); r.version = pj.version; break; }
  }
  const cli = u.findAll('code')[0];
  if (cli) {
    r.cli = u.tilde(cli.path);
    const v = u.versionOf(cli.path);
    r.cli_version = v.version;
    if (!r.version) r.version = v.version;
  }
  for (const f of ['Cursor', 'Windsurf', 'VSCodium']) {
    const p = u.IS_MAC ? '/Applications/' + f + '.app' : u.IS_WIN ? path.join(u.localAppData(), 'Programs', f) : null;
    if (p && u.exists(p)) r.forks.push(f);
  }
  return r;
}

module.exports = { extDirs, listExtensions, collect, EXT_ID_RE };
