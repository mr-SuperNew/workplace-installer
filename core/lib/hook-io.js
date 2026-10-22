'use strict';
// Обвязка сторожей-хуков, одинаковая для Claude Code и Codex: JSON на stdin, ответ JSON в stdout, код выхода 0.
// Любая ошибка внутри хука и мусорный ввод = тихий выход без вывода (хук не должен ломать работу).
// Отказ: permissionDecision "deny" (у Codex `ask` в PreToolUse не поддержан, поэтому везде deny + просьба спросить человека).
const root = require('./root');
const config = require('./config');

const STDIN_TIMEOUT_MS = 3000;

// handler(data, ctx) -> объект ответа или null. ctx = { root, config } (root может быть null вне рабочего места).
// scriptDir: __dirname хука, по нему надёжнее всего находится корень.
function run(handler, scriptDir) {
  let input = '';
  const timer = setTimeout(() => process.exit(0), STDIN_TIMEOUT_MS);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { input += c; });
  process.stdin.on('error', () => process.exit(0));
  process.stdin.on('end', () => {
    clearTimeout(timer);
    try {
      let data = {};
      try { data = input.trim() ? JSON.parse(input) : {}; } catch (_) { data = {}; }
      if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
      const r = root.resolveRoot({ scriptDir, cwd: data.cwd });
      const ctx = { root: r, config: r ? config.load(r) : config.defaults() };
      const out = handler(data, ctx);
      if (out) process.stdout.write(JSON.stringify(out));
    } catch (_) { /* тихо */ }
    process.exitCode = 0;
  });
}

function deny(reason) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: String(reason) } };
}
// eventName: SessionStart | UserPromptSubmit | PostToolUse ...
function context(eventName, text) {
  return { hookSpecificOutput: { hookEventName: eventName, additionalContext: String(text) } };
}

// Имя инструмента одним словом: Codex присылает shell под разными именами (Bash, shell, shell_command, local_shell, unified_exec).
const SHELL_TOOL_RX = /^(bash|shell|shell_command|local_shell|unified_exec|powershell)$/i;
function isShellTool(name) { return SHELL_TOOL_RX.test(String(name || '')); }
function isPatchTool(name) { return /^apply_patch$/i.test(String(name || '')); }

// Пути файлов из патча Codex (`*** Add File: <путь>`, `*** Update File: <путь>`) и добавленный текст (строки с «+»).
function parsePatch(text) {
  const files = [];
  const added = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/);
    if (m) { files.push(m[1].trim()); continue; }
    if (line.startsWith('+') && !line.startsWith('+++')) added.push(line.slice(1));
  }
  return { files, added: added.join('\n') };
}

module.exports = { run, deny, context, isShellTool, isPatchTool, parsePatch, STDIN_TIMEOUT_MS };
