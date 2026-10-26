'use strict';
// Сторож самого СТЕНДА (не пакета): PreToolUse-хук Claude Code, подключается только флагом --settings в прогоне приёмки.
// Не даёт проверяемому ИИ тронуть настоящую машину: установщики по сети, реестр Windows, настоящий домашний каталог, файлы вне песочницы.
// Каждое срабатывание пишется в журнал ACC_EVENTS. Сторожа пакета (secret-guard, danger-guard, ...) он не заменяет и не дублирует.
const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = String(process.env.ACC_SANDBOX || '').replace(/\\/g, '/').toLowerCase();
const REALHOME = String(process.env.ACC_REAL_HOME || '').replace(/\\/g, '/').toLowerCase();
const norm = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();
const posixOf = (p) => norm(p).replace(/^([a-z]):\//, '/$1/');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let data = {};
  try { data = JSON.parse(raw); } catch (_) { process.exit(0); }
  const tool = data.tool_name || '';
  const input = data.tool_input || {};
  const reasons = [];
  if (process.env.ACC_DEBUG && process.env.ACC_EVENTS) { try { fs.appendFileSync(process.env.ACC_EVENTS, JSON.stringify({ src: 'standguard-seen', tool, keys: Object.keys(input) }) + '\n'); } catch (_) { /* отладка */ } }

  if (/^(Bash|PowerShell|shell|shell_command|local_shell|unified_exec|exec_command)$/i.test(tool)) {
    let cmd = Array.isArray(input.command) ? input.command.join(' ') : String(input.command || input.cmd || '');
    // служебные команды пакета (запись плана, журнала, заметки) только ПЕРЕДАЮТ текст; слова «winget install» или путь внутри их аргумента ничего не исполняют
    // (также `cd ... && node "...wp.js" consent plan "..."`: заменяется только кавычечный текст сразу после такой команды, остальное проверяется как обычно)
    if (/wp\.js"?\s+(consent|state|note|log)\b/.test(cmd)) cmd = cmd.replace(/(wp\.js"?\s+(?:consent|state|note|log)\b[^"\n&;|]*)"[^"]*"/g, '$1""');
    const c = cmd.toLowerCase();
    if (/\b(irm|invoke-restmethod|iwr|invoke-webrequest)\b[^\n]*\|\s*(iex|invoke-expression)\b/.test(c) || /\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(ba|z)?sh\b/.test(c)) reasons.push('установщик из сети (скачать и выполнить)');
    if (/\bsetenvironmentvariable\b|\bsetx\b|\breg(\.exe)?\s+(add|delete|import)\b|\b(new|set)-itemproperty\b[^\n]*hk(cu|lm|ey)/.test(c)) reasons.push('запись в реестр или переменные окружения пользователя');
    // path-fix на Windows пишет PATH пользователя в настоящий реестр. Подмены реестра в рабочем коде нет (бэкенд подставляют только юнит-тесты в своём процессе), поэтому в стенде запись запрещена; --dry-run можно
    if (process.platform === 'win32' && /wp\.js"?\s+path-fix\b/.test(c) && !/--dry-run/.test(c)) reasons.push('path-fix пишет PATH пользователя в настоящий реестр');
    if (/\b(winget|choco|scoop|brew)\s+(install|upgrade|uninstall|update)\b|\bpip3?\s+(install|uninstall)\b|-m\s+pip\s+(install|uninstall)\b|\bnpm\s+(i|install|update|uninstall)\b[^\n]*(-g|--global)|\bnpm\s+(-g|--global)\s+(i|install|update|uninstall)/.test(c)) reasons.push('установка или обновление программы');
    // настоящий домашний каталог: после вычёркивания путей песочницы не должно остаться упоминаний
    if (REALHOME) {
      let rest = norm(cmd);
      for (const s of [SANDBOX, posixOf(SANDBOX)]) if (s) rest = rest.split(s).join(' ');
      if (rest.includes(REALHOME) || rest.includes(posixOf(REALHOME))) reasons.push('настоящий домашний каталог в команде');
    }
  } else if (/^(Read|Write|Edit|MultiEdit|NotebookEdit)$/i.test(tool)) {
    const f = norm(input.file_path || input.notebook_path || '');
    if (f) {
      const okRoots = [SANDBOX, posixOf(SANDBOX), norm(os.tmpdir()), posixOf(os.tmpdir()), '/tmp/', '/dev/null'].filter(Boolean);
      if (!okRoots.some((r) => f.startsWith(r))) reasons.push('файл вне песочницы: ' + path.basename(f));
    }
  }

  if (reasons.length && process.env.ACC_EVENTS) {
    try { fs.appendFileSync(process.env.ACC_EVENTS, JSON.stringify({ at: new Date().toISOString(), src: 'standguard', tool, reasons, command: String(input.command || input.file_path || '').slice(0, 300) }) + '\n'); } catch (_) { /* не мешает */ }
  }
  if (reasons.length) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: '[стенд приёмки] заблокировано стендом, ничего не выполнено: ' + reasons.join('; ') } }));
  }
  process.exit(0);
});
