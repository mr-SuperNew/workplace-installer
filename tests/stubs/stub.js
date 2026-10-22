'use strict';
// Заглушки для тестов: делают вид, что это codex, claude, git или python (первый аргумент: provider). Общие для tests/unit/skills, tests/matrix и tests/safety.
// git и python умеют только --version (и `git -C папка config user.*`, который пуст): этого хватает разведке; настоящие репозитории тесты делают настоящим git.
// Режим задаёт STUB_MODE:
//   smart  - читает файлы из задания, цитирует их и сверяет таблицу «выручка на сотрудника» с источником: неверная строка даёт RED с названием компании;
//   lazy   - цитирует верно, но всегда GREEN и ничего не находит (слепой по сути)
//   blind  - вердикт GREEN без цитат (файлов не читал)
//   hang | quota | auth | empty - сбои запуска
// STUB_VERDICT принудительно задаёт вердикт (для проверки режима --action). STUB_LOG: в этот файл дописывается строка JSON на каждый вызов.
// STUB_LOGIN: chatgpt | none | apikey (ответ `codex login status`); STUB_CLAUDE_LOGIN: ok | none.
// STUB_CODEX_WRITES=1: `codex --version` ведёт себя как настоящий Codex 0.163: если CODEX_HOME (по умолчанию ~/.codex) существует, создаёт в нём tmp/arg0-*/.lock;
// если не существует, пишет предупреждение в stderr и ничего не создаёт (разведка не должна менять ни байта, M1).
const fs = require('fs');
const path = require('path');
const provider = process.argv[2];
const argv = process.argv.slice(3);
const mode = process.env.STUB_MODE || 'smart';
if (process.env.STUB_LOG) fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ provider, argv, cwd: process.cwd() }) + '\n');

if (provider === 'git') {
  if (argv[0] === '--version') { process.stdout.write('git version 2.99.0.stub\n'); process.exit(0); }
  process.stderr.write('stub git: поддерживается только --version\n'); process.exit(1);
}
if (provider === 'python') {
  if (argv.includes('--version')) { process.stdout.write('Python 3.12.0\n'); process.exit(0); }
  process.stderr.write('stub python: поддерживается только --version\n'); process.exit(1);
}
if (argv[0] === '--version' && provider === 'codex' && process.env.STUB_CODEX_WRITES === '1') {
  const home = process.env.CODEX_HOME || path.join(require('os').homedir(), '.codex');
  if (fs.existsSync(home)) { fs.mkdirSync(path.join(home, 'tmp', 'arg0-stub'), { recursive: true }); fs.writeFileSync(path.join(home, 'tmp', 'arg0-stub', '.lock'), 'x'); }
  else process.stderr.write('WARNING: proceeding, even though we could not create PATH aliases: CODEX_HOME points to "' + home + '", but that path does not exist\n');
}
if (argv[0] === '--version') { process.stdout.write(provider === 'codex' ? 'codex-cli 0.0.0-stub\n' : '2.1.300 (Claude Code stub)\n'); process.exit(0); }
if (provider === 'codex' && argv[0] === 'login' && argv[1] === 'status') {
  const l = process.env.STUB_LOGIN || 'chatgpt';
  if (l === 'none') { process.stderr.write('Not logged in\n'); process.exit(1); }
  process.stderr.write(l === 'apikey' ? 'Logged in using an API key - sk-***\n' : 'Logged in using ChatGPT\n');
  process.exit(0);
}
if (provider === 'claude' && argv[0] === 'auth' && argv[1] === 'status') {
  const ok = (process.env.STUB_CLAUDE_LOGIN || 'ok') === 'ok';
  process.stdout.write(JSON.stringify({ loggedIn: ok, authMethod: ok ? 'claude.ai' : 'none' }) + '\n');
  process.exit(ok ? 0 : 1);
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  if (mode === 'hang') { setInterval(() => {}, 1000); return; }
  if (mode === 'auth') { process.stderr.write('Error: 401 Unauthorized: not logged in\n'); process.exit(1); }
  if (mode === 'quota') { process.stderr.write('Error: usage limit reached (429)\n'); process.exit(5); }
  let text = '';
  if (mode !== 'empty') text = answer(input);
  if (provider === 'codex') {
    const i = argv.indexOf('-o');
    if (i >= 0 && text) fs.writeFileSync(argv[i + 1], text);
    process.stdout.write('stub codex: done\n');
  } else {
    process.stdout.write(text);
  }
  process.exit(0);
});

function words(line, n) { return line.trim().split(/\s+/).slice(0, n).join(' '); }
function table(text) {
  const rows = [];
  for (const l of text.split(/\r?\n/)) {
    const c = l.split('|').map((x) => x.trim());
    if (c.length >= 4 && c[0] === '' && c[1] && !/^[-: ]+$/.test(c[1])) rows.push(c.slice(1, -1));
  }
  return rows;
}
function num(s) { return parseFloat(String(s).replace(',', '.').replace(/\s/g, '')); }
function fmt(x) { return (Math.round(x * 10) / 10).toFixed(1).replace('.', ','); }

function answer(prompt) {
  const files = [...prompt.matchAll(/^ {2}((?:result|source)\/\S+)$/gm)].map((m) => m[1]);
  const must = (prompt.match(/начинающуюся со слов «([^»]+)»/) || [])[1];
  const body = {};
  for (const f of files) { try { body[f] = fs.readFileSync(path.join(process.cwd(), f), 'utf8'); } catch (_) { body[f] = ''; } }
  const read = [];
  if (mode !== 'blind') {
    for (const f of files) {
      const lines = body[f].split(/\r?\n/);
      let line = lines.find((l) => l.trim().length > 8) || '';
      if (must) { const ml = lines.find((l) => l.startsWith(must)); if (ml) line = ml; }
      read.push('- ' + f + ': «' + words(line, 6) + '»');
    }
  }
  const findings = [];
  if (mode === 'smart') {
    const src = {};
    for (const f of files.filter((x) => x.startsWith('source/'))) for (const r of table(body[f])) if (r.length >= 3 && !isNaN(num(r[1])) && !isNaN(num(r[2])) && num(r[2]) > 0) src[r[0]] = num(r[1]) / num(r[2]);
    for (const f of files.filter((x) => x.startsWith('result/'))) for (const r of table(body[f])) {
      if (src[r[0]] !== undefined && !isNaN(num(r[1])) && Math.abs(num(r[1]) - src[r[0]]) > 0.05) findings.push((findings.length + 1) + '. Блокирующая. ' + f + ', строка «' + r[0] + '»: указано ' + r[1] + ', по источнику ' + fmt(src[r[0]]) + ' (' + r[0] + ': выручка делится на сотрудников).');
    }
  }
  let verdict = findings.length ? 'RED' : 'GREEN';
  if (process.env.STUB_VERDICT) verdict = process.env.STUB_VERDICT;
  return ['ВЕРДИКТ: ' + verdict, 'Прочитано:', ...read, 'Находки: ' + (findings.length ? '\n' + findings.join('\n') : 'нет'), 'Подтверждено: остальное совпало', 'Не проверено: ничего'].join('\n') + '\n';
}
