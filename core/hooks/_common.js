'use strict';
// Общие мелочи сторожей. Не хук: файлы с «_» не подключаются. Только встроенные модули Node.
// Один скрипт работает и под Claude Code, и под Codex: здесь имена инструментов и форма tool_input приводятся к одному виду.
const fs = require('fs');
const path = require('path');
const hookIo = require('../lib/hook-io');

const MAX_SCAN = 2 * 1024 * 1024;

function str(x) { return typeof x === 'string' ? x : ''; }
function obj(x) { return x && typeof x === 'object' && !Array.isArray(x) ? x : {}; }

function quoteWord(w) { return /^[\w@%+=:,.\/\\-]+$/.test(w) ? w : "'" + w.replace(/'/g, "'\\''") + "'"; }
// Codex присылает команду строкой или списком слов (['bash','-lc','...']): для «оболочка -c скрипт» берётся сам скрипт, иначе слова склеиваются.
function argvToText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    const a = c.map(String);
    if (a.length >= 3 && /^(-[a-z]*c|-command|\/c)$/i.test(a[a.length - 2])) return a[a.length - 1];
    return a.map(quoteWord).join(' ');
  }
  return null;
}

// Текст shell-команды или null, если инструмент не оболочка. Bash|shell|shell_command|local_shell|unified_exec|PowerShell.
function shellCommand(data) {
  if (!hookIo.isShellTool(data.tool_name)) return null;
  const ti = data.tool_input;
  if (typeof ti === 'string') return ti;
  const t = obj(ti);
  const c = t.command !== undefined ? t.command : (t.cmd !== undefined ? t.cmd : t.script);
  return argvToText(c);
}
// Папка запуска команды: workdir (Codex) или cwd из входа.
function shellCwd(data) {
  const t = obj(data.tool_input);
  return str(t.workdir) || str(t.cwd) || str(data.cwd) || process.cwd();
}

// Что записывает инструмент: { paths: [путь...], text: добавляемый текст } или null (не запись).
// Claude: Write (content), Edit (new_string), MultiEdit (edits[].new_string), NotebookEdit (new_source). Codex: apply_patch (патч в tool_input.command).
function writeInfo(data) {
  const name = String(data.tool_name || '');
  const t = obj(data.tool_input);
  if (/^write$/i.test(name)) return { paths: [str(t.file_path) || str(t.path)], text: str(t.content) };
  if (/^edit$/i.test(name)) return { paths: [str(t.file_path)], text: str(t.new_string) };
  if (/^multiedit$/i.test(name)) return { paths: [str(t.file_path)], text: (Array.isArray(t.edits) ? t.edits : []).map((e) => str(obj(e).new_string)).join('\n') };
  if (/^notebookedit$/i.test(name)) return { paths: [str(t.notebook_path) || str(t.file_path)], text: str(t.new_source) };
  if (hookIo.isPatchTool(name)) {
    const raw = typeof data.tool_input === 'string' ? data.tool_input : (str(t.command) || str(t.input) || str(t.patch));
    const p = hookIo.parsePatch(raw);
    return { paths: p.files, text: p.added };
  }
  return null;
}
function clip(text) { return text.length > MAX_SCAN ? text.slice(0, MAX_SCAN) : text; }

function readText(file, max) {
  try {
    const t = fs.readFileSync(file, 'utf8');
    return max && t.length > max ? t.slice(0, max) : t;
  } catch (_) { return null; }
}
function inside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
function rel(root, p) { return path.relative(root, p).split(path.sep).join('/') || '.'; }

// Ближайшая вверх от cwd папка с AGENTS.md (не выше корня); по умолчанию корень.
function findWorkspace(root, cwd) {
  let cur = path.resolve(cwd || root);
  if (!inside(cur, root)) return root;
  for (;;) {
    if (fs.existsSync(path.join(cur, 'AGENTS.md'))) return cur;
    if (cur === root) return root;
    const up = path.dirname(cur);
    if (up === cur || !inside(up, root)) return root;
    cur = up;
  }
}

// Название ИИ для текстов: из providers (одно место, где живёт различие направлений); при сбое берётся имя.
function label(name) {
  try { return require('../providers').get(name).label; } catch (_) { return String(name); }
}

module.exports = { MAX_SCAN, str, obj, argvToText, shellCommand, shellCwd, writeInfo, clip, readText, inside, rel, findWorkspace, label };
