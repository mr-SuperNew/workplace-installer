#!/usr/bin/env node
'use strict';
// Сторож секретов. PreToolUse, один скрипт для Claude Code и Codex.
//  1. Не даёт открыть, изменить и вывести файлы с ключами (.env, auth.json, закрытые ключи) и значения секретных переменных окружения.
//  2. Проверяет СОДЕРЖИМОЕ записи: Write, Edit, MultiEdit, NotebookEdit (Claude) и apply_patch (Codex), а также текст shell-команды.
//     Найден секрет (ключ sk-..., токен, закрытый ключ, password = "..." от 12 знаков): запись отклонена, названа категория, значение не показывается.
//  3. Не мешает установке: npm install -g, codex login, codex login status, command -v, git commit по своим путям, process.env в коде.
//  4. Не мешает работе программы с ключом: запуск скрипта, который сам читает .env (node script.js, python app.py, docker --env-file .env, source .env, dotenv run), проходит.
//     ИИ не открывает .env инструментом Read, не печатает его (cat, код на интерпретаторе, который читает файл и печатает) и не отправляет наружу (cp, curl @.env, git add).
//     Нужны только имена ключей: grep -o '^[A-Za-z_]*=' .env, cut -d= -f1, счёт и «есть/нет» (grep -c, -q, -l) значений не показывают и разрешены.
// Основа - env-guard.js из v3 (идея и регулярные выражения для .env), команды разбираются лексером shell-lex.js, а не регулярными выражениями по всему тексту.
// Честное ограничение: это фильтр по тексту, а не стена; обойти его можно хитрой командой. Ключи не лежат в чате, в checks/ и в git (.gitignore).
const hookIo = require('../lib/hook-io');
const cfgLib = require('../lib/config');
const scan = require('../lib/secrets-scan');
const common = require('./_common');
const sh = require('./_shell');

const MSG_FILE = 'Файл с ключами не открывается, не изменяется и не выводится. Нужно знать, есть ли ключ: ответь «есть» или «нет», значение не читай.';
const MSG_ENV = 'Значения секретных переменных окружения не выводятся. Нужно знать, задан ли ключ: ответь «есть» или «нет», значение не читай.';

// ---------- файлы с секретами ----------
// .env, .env.local, prod.env не считается (как в v3); .env.example и подобные шаблоны разрешены.
const ENV_RX = /(^|[\\/])\.env($|\.(?!(?:example|sample|template|dist|tpl)$)[\w.-]*$)/i;
const SECRET_BASE = [/^auth\.json$/i, /^\.credentials\.json$/i, /^\.git-credentials$/i, /^_?\.?netrc$/i, /^id_(rsa|ed25519|ecdsa|dsa)$/i, /\.(pem|key|p12|pfx|ppk|jks|keystore)$/i];
const PROC_ENVIRON = /[\\/]proc[\\/][^\\/]+[\\/]environ$/i;
function isSecretPath(p) {
  const s = String(p || '').trim();
  if (!s) return false;
  const base = s.replace(/\\/g, '/').split('/').pop();
  return ENV_RX.test(s) || SECRET_BASE.some((r) => r.test(base)) || PROC_ENVIRON.test(s);
}
// Для Grep/Glob: шаблон `**/.env*` тоже затрагивает файл.
const GLOB_ENV_RX = /(^|[\\/\s])\.env(?!\.(?:example|sample|template|dist|tpl)(?![\w-]))(?![\w-])/i;
// .env внутри кода интерпретатора (node -e, python -c): отдельное слово в кавычках или после пробела/слэша, но не process.env.
const INLINE_ENV_RX = /(^|[\s'"`(\/\\=])\.env(\.(?!(?:example|sample|template|dist|tpl)(?![\w-]))[\w.-]+)?(?=$|[\s'"`),;:\]}])/i;
const INLINE_OTHER_RX = /(^|[\s'"`(\/\\=])(auth\.json|\.credentials\.json|\.git-credentials|id_(rsa|ed25519|ecdsa))(?=$|[\s'"`),;:\]}])/i;

// ---------- секретные переменные ----------
const SECRET_VAR = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i;
const VAR_REF = /\$env:[A-Za-z_][A-Za-z0-9_]*|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|%[A-Za-z_][A-Za-z0-9_]*%/gi;
function refsSecretVar(t) { return (String(t).match(VAR_REF) || []).some((x) => SECRET_VAR.test(x)); }

const TEXT_ONLY = new Set(['echo', 'printf', 'write-output', 'write-host', 'print', 'say']);
// Команды, которые только проверяют наличие/метаданные: «есть ли .env» спросить можно.
const META_ONLY = new Set(['ls', 'dir', 'stat', 'test', '[', '[[', 'test-path', 'get-childitem', 'gci', 'get-item', 'gi', 'file', 'wc', 'chmod', 'touch', 'cd', 'pushd', 'popd', 'set-location', 'sl',
  'rm', 'del', 'erase', 'remove-item', 'ri', 'unlink', 'realpath', 'basename', 'dirname', 'readlink', 'which', 'where', 'where.exe', 'command', 'type.exe']);
const GREPS = new Set(['grep', 'egrep', 'fgrep', 'zgrep', 'rg', 'ag', 'ack', 'findstr', 'select-string', 'sls']);
const INTERPRETERS = new Set(['node', 'nodejs', 'python', 'python3', 'py', 'ruby', 'perl', 'php', 'deno', 'bun']);
const GIT_READ_SUBS = new Set(['add', 'diff', 'show', 'blame', 'apply', 'stash', 'restore', 'checkout', 'mv', 'cat-file', 'grep']);
const GREP_VALUED = new Set(['-f', '-m', '-A', '-B', '-C', '-g', '-t', '-T', '--glob', '--include', '--exclude', '--max-count', '--file', '--type', '-include', '-exclude']);
// Программы, которые запускают код: .env в их аргументах читает сама программа, а не ИИ. Код на интерпретаторе в командной строке (-e, -c) разбирается отдельно.
const RUNNERS = new Set(['node', 'nodejs', 'deno', 'bun', 'python', 'python3', 'py', 'ruby', 'php', 'perl', 'docker', 'docker-compose', 'make', 'npx', 'npm', 'pnpm', 'yarn', 'uv', 'poetry', 'pipenv',
  'dotenv', 'dotenvx', 'source', '.', 'bash', 'sh', 'zsh']);
// Только имена ключей: шаблон от начала строки из символов имени, значение (после «=») недостижимо.
const NAMES_ONLY_PAT = /^\^(?:(?:\[[A-Za-z0-9_:\-[\]]+\]|\\w)[*+]?)+=?$/;
const shortFlags = (rest) => rest.filter((w) => !w.q && /^-[A-Za-z]+$/.test(w.t)).map((w) => w.t.slice(1)).join('');
const longFlags = (rest) => rest.filter((w) => !w.q && /^--/.test(w.t)).map((w) => w.t);
function grepPattern(rest) {
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i];
    if (!w.q && /^(-e|--regexp|-pattern|-regexp)$/i.test(w.t) && rest[i + 1]) return rest[i + 1].t;
    if (!w.q && GREP_VALUED.has(w.t)) { i++; continue; }
    if (sh.isFlag(w)) continue;
    return w.t;
  }
  return null;
}
// grep, rg по .env, который не показывает значения: счёт, «есть/нет», имена файлов, либо -o с шаблоном только из имени ключа.
function grepValueFree(it) {
  const sf = shortFlags(it.rest), lf = longFlags(it.rest);
  if (/[ABC]/.test(sf) || lf.some((f) => /^--(context|after-context|before-context)/.test(f))) return false;
  if (/[cqlL]/.test(sf) || lf.some((f) => /^--(count|quiet|silent|files-with-matches|files-without-match)$/.test(f))) return true;
  if (/o/.test(sf) || lf.includes('--only-matching')) { const p = grepPattern(it.rest); return !!p && NAMES_ONLY_PAT.test(p); }
  return false;
}
// cut -d= -f1: первое поле до «=» это имя ключа.
function cutNamesOnly(rest) {
  const ts = rest.map((w) => w.t);
  const delim = ts.some((t, i) => t === '-d=' || (t === '-d' && ts[i + 1] === '='));
  const field1 = ts.some((t, i) => t === '-f1' || (t === '-f' && ts[i + 1] === '1'));
  return delim && field1 && !ts.includes('--complement');
}
// Код на интерпретаторе в командной строке или в heredoc.
const INLINE_FLAG = { node: /^(-e|-p|-pe|-ep|--eval|--print)$/, nodejs: /^(-e|-p|-pe|-ep|--eval|--print)$/, bun: /^(-e|-p|--eval|--print)$/, python: /^-c$/, python3: /^-c$/, py: /^-c$/,
  ruby: /^-[a-zA-Z]*e$/, perl: /^-[a-zA-Z]*[eE]$/, php: /^-r$/, deno: /^eval$/ };
const RAW_READ = /(readFileSync|readFile\b|read_text|read_bytes|\bopen\s*\(|file_get_contents|File\.read|IO\.read|createReadStream|Get-Content|dotenv_values|dotenv\.parse|\bparse\s*\()/i;
const OUTPUT_CALL = /(console\.(log|info|error|warn|dir|table)|process\.std(out|err)|\bprint\s*\(|\bprint\b|\bputs\b|\becho\b|println|printf|sys\.std(out|err)|System\.out|Write-Host|Write-Output)/i;
function inlineCode(it) {
  const flag = INLINE_FLAG[it.cmd];
  const hasFlag = flag && it.rest.some((w) => !w.q && flag.test(w.t));
  const heredoc = (it.here || []).map((h) => String(h.body || '')).filter(Boolean);
  if (!hasFlag && !heredoc.length) return null;
  return { code: it.rest.map((w) => w.t).concat(heredoc), printMode: it.rest.some((w) => !w.q && /^(-p|-pe|-ep|--print)$/.test(w.t)) };
}
// Код читает .env и печатает: значения попадут в чат. Загрузчик dotenv (load_dotenv, dotenv.config) без печати прочитанного это работа программы.
function inlineEnvPrints(ic) {
  const mentions = ic.code.some((c) => INLINE_ENV_RX.test(c) || INLINE_OTHER_RX.test(c));
  if (!mentions) return false;
  const blob = ic.code.join('\n');
  return RAW_READ.test(blob) && (ic.printMode || OUTPUT_CALL.test(blob));
}

function grepFiles(rest) {
  const files = [];
  let patternGiven = false;
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i];
    const t = w.t;
    if (!w.q && /^(-e|--regexp|-pattern|-regexp)$/i.test(t)) { patternGiven = true; i++; continue; }
    if (!w.q && /^(-path|-literalpath)$/i.test(t) && rest[i + 1]) { files.push(rest[i + 1].t); i++; continue; }
    if (!w.q && GREP_VALUED.has(t)) { i++; continue; }
    if (sh.isFlag(w)) continue;
    if (!patternGiven) { patternGiven = true; continue; }   // первое слово без флага - шаблон поиска, а не файл
    files.push(t);
  }
  return files;
}
function afterEq(t) { const i = t.indexOf('='); return i > 0 ? t.slice(i + 1) : t; }

// mode: 'sh' или 'ps'. В PowerShell `set` это Set-Variable, а слово "set" в кавычках - строка (идиома `if ($env:KEY) { "set" }` проверяет только наличие ключа), а не дамп окружения.
function checkItem(it, mode) {
  const cmd = it.cmd;
  // перенаправления: < .env, > .env
  for (const r of it.redirs || []) if (isSecretPath(r.target)) return MSG_FILE;
  if (!cmd) return null;

  // дамп окружения
  if (it.envDump) return MSG_ENV;
  const names = sh.positional(it.rest);
  if (cmd === 'printenv') {
    if (!names.length || names.some((w) => SECRET_VAR.test(w.t))) return MSG_ENV;
    return null;
  }
  if (cmd === 'set' && !it.rest.length && mode !== 'ps') return MSG_ENV;
  if (cmd === 'export' && (!it.rest.length || sh.hasFlag(it.rest, '-p'))) return MSG_ENV;
  if ((cmd === 'declare' || cmd === 'typeset') && it.rest.length && it.rest.every((w) => sh.isFlag(w)) && sh.hasFlag(it.rest, /^-[a-zA-Z]*[xp][a-zA-Z]*$/)) return MSG_ENV;
  if (cmd === 'compgen' && sh.hasFlag(it.rest, '-e', '-v')) return MSG_ENV;
  if (/^(get-childitem|gci|dir|ls|get-item|gi)$/.test(cmd)) {
    for (const w of it.rest) {
      const m = /^env:(.*)$/i.exec(w.t);
      if (m && (!m[1] || /[*?]/.test(m[1]) || SECRET_VAR.test(m[1]))) return MSG_ENV;
    }
  }
  if (it.rest.some((w) => /GetEnvironmentVariables\s*\(/i.test(w.t))) return MSG_ENV;
  if (TEXT_ONLY.has(cmd)) return it.rest.some((w) => refsSecretVar(w.t)) ? MSG_ENV : null;

  // хранилища ключей и печать токенов
  if (cmd === 'security' && names.some((w) => /^(find-generic-password|find-internet-password|dump-keychain|export)$/.test(w.t))) return MSG_FILE;
  if (cmd === 'gh' && names[0] && names[0].t === 'auth' && (names[1] && names[1].t === 'token' || sh.hasFlag(it.rest, '--show-token', '-t'))) return MSG_ENV;
  if (cmd === 'gcloud' && names.some((w) => /^print-(access|identity)-token$/.test(w.t))) return MSG_ENV;

  // файлы с секретами
  if (META_ONLY.has(cmd)) return null;
  if (cmd === 'git') {
    const g = sh.gitSub(it.rest);
    if (!GIT_READ_SUBS.has(g.sub)) return null;
    return g.args.some((w) => !sh.isFlag(w) && isSecretPath(w.t)) ? MSG_FILE : null;
  }
  if (GREPS.has(cmd)) return grepFiles(it.rest).some((f) => isSecretPath(f)) && !grepValueFree(it) ? MSG_FILE : null;
  if (cmd === 'cut' && cutNamesOnly(it.rest)) return null;
  // запуск программы: .env читает она сама. Код в командной строке (-e, -c, heredoc) читает и печатает вместе с ИИ, поэтому разбирается.
  if (INTERPRETERS.has(cmd)) {
    const ic = inlineCode(it);
    if (ic) return inlineEnvPrints(ic) ? MSG_FILE : null;
    const mod = it.rest.findIndex((w) => !w.q && w.t === '-m');
    const modName = mod >= 0 ? (it.rest[mod + 1] || {}).t || '' : '';
    if (modName === 'dotenv' && sh.positional(it.rest).some((w) => /^(list|ls|get|set)$/i.test(w.t))) return MSG_FILE;     // командная строка python-dotenv печатает значения
    if (/^(json\.tool|http\.server)$/.test(modName) && it.rest.some((w) => isSecretPath(w.t))) return MSG_FILE;
    return null;
  }
  if (cmd === 'dotenv' || cmd === 'dotenvx') return /^(list|ls|get|set|decrypt|encrypt|keypair)$/i.test((names[0] || {}).t || '') ? MSG_FILE : null;
  if (RUNNERS.has(cmd)) return null;
  for (const w of it.rest) {
    if (w.op) continue;
    const t = w.t.replace(/^@/, '');          // curl -d @.env, --data-binary @.env
    if (isSecretPath(t) || (t.includes('=') && isSecretPath(afterEq(t)))) return MSG_FILE;
  }
  return null;
}

function checkBash(cmd, data) {
  const cwd = common.shellCwd(data);
  const psOnly = /^powershell$/i.test(String(data.tool_name || ''));
  for (const { mode, items } of sh.flattenAll(cmd, { cwd, psOnly })) {
    for (const it of items) {
      const r = checkItem(it, mode);
      if (r) return r;
    }
  }
  return null;
}

// ---------- секрет в тексте ----------
// Строки с пометкой примера (# example, // пример) и строка сразу под такой пометкой не считаются: это документация.
const MARK = /(#|\/\/|;|--|<!--|\/\*)\s*(example|пример|sample)(?![A-Za-zА-Яа-яЁё])/i;
const MARK_ONLY = /^\s*(#|\/\/|;|--)\s*(example|пример|sample)(?![A-Za-zА-Яа-яЁё])[^\n]*$/i;
function scanText(text, shell) {
  const lines = common.clip(String(text)).split(/\r?\n/);
  const kept = lines.map((l, i) => (MARK.test(l) || (i > 0 && MARK_ONLY.test(lines[i - 1])) ? '' : l));
  return scan.scanSecrets(kept.join('\n'), { shell: !!shell });
}
function secretMessage(hits, where) {
  const kinds = Array.from(new Set(hits.map((h) => h.kind))).join(', ');
  const lines = hits.slice(0, 5).map((h) => h.line).join(', ');
  return 'Сторож секретов: ' + where + ' найден секрет (' + kinds + ', строка ' + lines + '). Значение не записывается ни в файл, ни в команду, и здесь не показывается. ' +
    'Запись остановлена. Скажи человеку, что запись остановлена, и не пробуй записать иначе: в другой файл, частями или командой. Настоящий ключ человек вводит сам.';
}

// Инструмент Grep по .env: режимы count и files_with_matches (по умолчанию) значений не показывают; content безопасен только как -o с шаблоном из имени ключа.
function grepToolValueFree(ti) {
  const mode = String(ti.output_mode || 'files_with_matches');
  if (mode === 'count' || mode === 'files_with_matches') return true;
  if (ti['-A'] || ti['-B'] || ti['-C'] || ti.context) return false;
  return ti['-o'] === true && NAMES_ONLY_PAT.test(String(ti.pattern || ''));
}

hookIo.run((data, ctx) => {
  if (!cfgLib.guardEnabled(ctx.config, 'secret_guard')) return null;
  const name = String(data.tool_name || '');
  const ti = common.obj(data.tool_input);

  // Чтение и запись файлов инструментами
  if (/^(read|edit|write|multiedit|notebookedit)$/i.test(name)) {
    const p = common.str(ti.file_path) || common.str(ti.notebook_path) || common.str(ti.path);
    if (isSecretPath(p)) return hookIo.deny(MSG_FILE);
  }
  if (/^grep$/i.test(name)) {
    if ([ti.path, ti.glob].some((x) => GLOB_ENV_RX.test(String(x || '')) || isSecretPath(x)) && !grepToolValueFree(ti)) return hookIo.deny(MSG_FILE);
  }
  // Glob возвращает только имена файлов (как `ls .env`: «есть ли .env» спросить можно), значений не показывает: не останавливается.

  // Запись: путь и содержимое
  const w = common.writeInfo(data);
  if (w) {
    if (w.paths.some((p) => isSecretPath(p))) return hookIo.deny(MSG_FILE);
    const hits = scanText(w.text);
    if (hits.length) return hookIo.deny(secretMessage(hits, 'в записываемом тексте'));
    return null;
  }

  // Shell: секрет в тексте команды и обращения к файлам и переменным
  const cmd = common.shellCommand(data);
  if (cmd) {
    const hits = scanText(cmd, true);
    if (hits.length) return hookIo.deny(secretMessage(hits, 'в тексте команды'));
    const r = checkBash(cmd, data);
    if (r) return hookIo.deny(r);
  }
  return null;
}, __dirname);
