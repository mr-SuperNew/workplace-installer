#!/usr/bin/env node
'use strict';
// Готовит папку проверки checks/<id>/: копирует в input/ только перечисленные файлы (с маскированием почт и телефонов по умолчанию),
// пишет manifest.json (пути и sha256 оригиналов) и prompt.md. Принимает тексты и код (.md, .txt, .csv, .json, .js, .ts, .py, .sh и другие текстовые файлы).
// Не принимает: ключи и .env, бинарные файлы (Excel, Word, PDF, картинки), символические ссылки, файлы вне корня.
//
// Два режима:
//  - проверка результата: --task "что делал автор" --result a.js,b.md [--sources c.md]
//  - проверка намерения (ничего ещё не сделано): --action "что собираюсь сделать" [--result письмо.md,план.md] [--sources ...]
//    текст --action (план, письмо, команда) кладётся в input/result/action.md; проверяющий оценивает шаг до выполнения.
//
//   node prepare-check.js --name короткое-имя ... [--label selftest-good] [--must-quote "КОНТРОЛЬНАЯ СТРОКА"] [--unmasked] [--retry]
//        [--profile setup-review] [--known "что это не находка, одной строкой"] [--allow-secret-like]
// Корень определяется по расположению скрипта; --root и любые пути записи не принимаются. Пишет только в <корень>/checks/<дата-время-имя>/.
const fs = require('fs');
const path = require('path');
const lib = require('./lib');

let created = null;   // папка проверки удаляется, если подготовка не удалась
function die(m) { if (created) fs.rmSync(created, { recursive: true, force: true }); process.stderr.write(m + '\n'); process.exit(1); }

const parsed = lib.parseArgs(process.argv.slice(2), { bool: ['unmasked', 'retry', 'allow-secret-like'], value: ['name', 'task', 'result', 'sources', 'label', 'must-quote', 'profile', 'known', 'action'], positional: 0 });
if (parsed.error) die(parsed.error);
const args = parsed.args;
const rr = lib.resolveRoot();
if (rr.error) die(rr.error);
const root = rr.root;
const lc = lib.loadConfig(root);
if (lc.error) die(lc.error);
const reviewer = lc.reviewer;
const actionText = args.action !== undefined ? String(args.action) : null;
if (actionText !== null && !actionText.trim()) die('Пустой --action: опиши шаг, который собираешься сделать.');
if (actionText !== null && Buffer.byteLength(actionText, 'utf8') > 100 * 1024) die('Текст --action больше 100 КБ: положи длинное в файл и передай через --result, а в --action оставь одну фразу.');
const mode = actionText !== null ? 'action' : 'result';
const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
const results = list(args.result), sources = list(args.sources);
const task = args.task || (mode === 'action' ? 'Проверить намерение: ' + actionText.split(/\r?\n/)[0].trim().slice(0, 120) : '');
if (!task) die('Нужен --task "одна фраза: что делал автор" (или --action "что собираюсь сделать").');
if (mode === 'result' && !results.length) die('Нужен --result: хотя бы один файл результата (или --action для проверки намерения).');
if (results.length + sources.length > 30) die('Больше 30 файлов за одну проверку не берём: сузь список.');

// Решение человека о передаче персональных данных: checks/POLICY.md, строка «ПДн проверяющему: можно|нельзя ...» (прежняя запись «ПДн в Codex: ...» тоже читается)
let policy = 'не задано';
try {
  const m = fs.readFileSync(path.join(root, 'checks', 'POLICY.md'), 'utf8').match(/ПДн[^:\n]{0,40}:\s*(можно|нельзя)/i);
  if (m) policy = m[1].toLowerCase();
} catch (_) { /* нет файла */ }
if (args.unmasked && policy !== 'можно') die('Без маскирования можно только после решения человека: запиши в checks/POLICY.md строку «ПДн проверяющему: можно (кто решил, дата)». Сейчас: ' + policy + '.');
const mask = !args.unmasked;

const MAX_FILE = 400 * 1024, MAX_TOTAL = 1500 * 1024;
let total = 0;
const d = new Date();
const p2 = (n) => String(n).padStart(2, '0');
const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
const name = String(args.name || 'check').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'check';
const id = `${stamp}-${name}`;
const dir = path.join(root, 'checks', id);
if (fs.existsSync(dir)) die('Папка checks/' + id + ' уже есть: подожди секунду или смени --name.');
fs.mkdirSync(path.join(dir, 'input', 'result'), { recursive: true });
created = dir;
fs.mkdirSync(path.join(dir, 'input', 'source'), { recursive: true });

const files = [];
const used = new Set();
function secretsCheck(label, text) {
  const hits = lib.scanSecrets(text);
  if (hits.length && !args['allow-secret-like']) {
    die(label + ': похоже на ключ или пароль (' + hits.slice(0, 5).map((h) => 'строка ' + h.line + ': ' + h.kind).join('; ') + '). ' +
      'Проверяющему такое не отправляем. Убери секрет (замени заглушкой в копии).');
  }
  return hits;
}
function putCopy(role, base, text, ext, meta) {
  let masked = { emails: 0, phones: 0 };
  if (mask) { const r = lib.maskText(text, lib.CODE_EXT.has(ext)); text = r.text; masked = { emails: r.emails, phones: r.phones }; }
  let target = base, n = 2;
  while (used.has(role + '/' + target)) target = (n++) + '-' + base;
  used.add(role + '/' + target);
  fs.writeFileSync(path.join(dir, 'input', role, target), text);
  files.push(Object.assign({ role, input_copy: `${role}/${target}`, sha256_input: lib.sha256(Buffer.from(text, 'utf8')), masked_emails: masked.emails, masked_phones: masked.phones }, meta));
}
function addFile(p, role) {
  const abs = path.resolve(root, p);
  const relPath = lib.toPosix(path.relative(root, abs));
  if (!relPath || relPath.startsWith('..') || path.isAbsolute(path.relative(root, abs))) die('Файл вне главной папки не передаём: ' + p);
  const base = path.basename(abs);
  if (lib.isSecretName(base) || /(^|\/)\.git\//.test(relPath) || /^checks\//.test(relPath) || /(^|\/)node_modules\//.test(relPath) || /^\.workplace\/(snapshots|npm-cache|backup-update)\//.test(relPath)) die('Этот файл передавать нельзя (ключи, служебные папки): ' + relPath);
  let st;
  try { st = fs.lstatSync(abs); } catch (_) { die('Файла нет: ' + relPath); }
  if (st.isSymbolicLink()) die('Символическую ссылку не передаём (она может вести за пределы папки): ' + relPath);
  if (!st.isFile()) die('Это не файл: ' + relPath);
  const realRel = path.relative(fs.realpathSync(root), fs.realpathSync(abs));
  if (realRel.startsWith('..') || path.isAbsolute(realRel)) die('Файл вне главной папки не передаём: ' + p);
  if (st.size > MAX_FILE) die(relPath + ': больше 400 КБ. Передай нужный кусок отдельным файлом.');
  total += st.size;
  if (total > MAX_TOTAL) die('Всего больше 1,5 МБ: сузь список файлов.');

  const ext = path.extname(base).toLowerCase();
  if (lib.BINARY_RE.test(ext)) die(base + ': формат ' + ext + ' не передаётся (бинарный файл не замаскировать и проверяющий его не прочитает). Сохрани как .csv, .md или .txt.');
  const orig = fs.readFileSync(abs);
  const known = lib.CODE_EXT.has(ext) || lib.DOC_EXT.has(ext) || lib.NAMED_TEXT.has(base.toLowerCase());
  if (!lib.isTextBuffer(orig)) die(base + ': не текстовый файл (бинарный или не UTF-8). Сохрани как .md, .csv или .txt в кодировке UTF-8.');
  if (!known) process.stdout.write(`Предупреждение: ${relPath}: расширение «${ext || 'нет'}» не из списка, но файл текстовый: беру как текст.\n`);
  const text = orig.toString('utf8');
  const hits = secretsCheck(relPath, text);
  putCopy(role, base, text, ext, { path: relPath, sha256: lib.sha256(orig), secret_like_allowed: hits.length ? true : undefined });
}
if (mode === 'action') {
  secretsCheck('--action', actionText);
  putCopy('result', 'action.md', '# Что собирается сделать автор (шаг ещё не выполнен)\n\n' + actionText.trim() + '\n', '.md', { path: null, virtual: true, sha256: lib.sha256(Buffer.from(actionText, 'utf8')) });
}
results.forEach((p) => addFile(p, 'result'));
sources.forEach((p) => addFile(p, 'source'));

let kitVersion = null;
try { kitVersion = fs.readFileSync(path.join(root, '.workplace', 'VERSION'), 'utf8').trim() || null; } catch (_) { /* версия пакета неизвестна */ }
const manifest = {
  id, created: d.toISOString(), mode, label: args.label || null, task, status: 'prepared', reviewer: lc.cfg.reviewer, kit_version: kitVersion,
  masked: mask, policy, must_quote: args['must-quote'] || null, retry: !!args.retry, profile: args.profile || null, files,
};
if (mode === 'action') manifest.action = actionText.length > 500 ? actionText.slice(0, 500) + '…' : actionText;
fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

// Что в этой настройке сделано намеренно и не является находкой (убирает ложные RED).
const KNOWN_SETUP = [
  'Сторож секретов (secret-guard.js) подключён всегда: он закрывает чтение .env и запись строк, похожих на ключ или пароль.',
  'Сторожа читают флаги из .workplace/config.json (guards): выключенный флаг означает выбор человека, а не поломку.',
  'Сторож model-guard действует только у основного Claude Code: у Codex аналога нет, это намеренно.',
  'Сторож кросс-проверки останавливает необратимые команды, пока нет свежей принятой проверки: это и есть защита, а не ошибка.',
  'Хуки молчат при ошибке и при мусорном вводе и завершаются кодом 0 намеренно: хук не должен ломать работу.',
  'Чужие пути и имена пользователей в проверяемых файлах считай находкой; пути вида $CLAUDE_PROJECT_DIR и относительные пути это норма.',
];
const knownLines = [];
if (args.profile === 'setup-review') knownLines.push(...KNOWN_SETUP);
if (args.known) knownLines.push(String(args.known));

const fileLines = (role) => files.filter((f) => f.role === role).map((f) => '  ' + f.input_copy).join('\n') || '  (нет)';
const intro = `Ты проверяющий, не автор работы. Ничего не правь и не создавай файлы. Никого не вызывай и ничего не запускай, кроме чтения файлов.
Читай только файлы из текущей папки и её подпапок, перечисленные ниже. Не читай ничего выше и вне неё, не ищи другие файлы. Правила AGENTS.md и CLAUDE.md о вызове кросс-проверки к тебе не относятся: проверку делаешь ты, повторно её никто не проверяет.
${mask ? 'Почты и телефоны в файлах намеренно замаскированы (например i***@домен): это не ошибка автора, не включай это в находки.\n' : ''}${args.retry ? 'Это повторная проверка после правок автора.\n' : ''}${knownLines.length ? 'Сделано намеренно, это не находки:\n' + knownLines.map((l) => '- ' + l).join('\n') + '\n' : ''}
`;
const body = mode === 'action'
  ? `Режим: проверка намерения. Автор ещё НЕ выполнил шаг, а только собирается. Описание шага лежит в result/action.md${results.length ? '; материалы шага (текст письма, план, команда, список получателей) перечислены ниже' : ''}.
Задача автора: ${task}
Файлы шага (проверяй их):
${fileLines('result')}
Исходные данные и источники (сверяй с ними):
${fileLines('source')}
Что проверить: что именно произойдёт и кого или что затронет; необратимо ли это и есть ли откат; какие данные и кому уйдут; адресат и канал; цифры и факты в тексте против источников; пропущенное и лишнее; выдуманное (контакты, почты, должности, цифры без источника); соответствует ли шаг задаче автора.
Вердикт про намерение: GREEN можно выполнять; YELLOW можно с оговорками, их перечисли; RED выполнять нельзя, пока не исправлено.
`
  : `Задача автора: ${task}
Файлы результата (проверяй их):
${fileLines('result')}
Исходные данные и источники (сверяй с ними):
${fileLines('source')}
Что проверить: соответствие задаче; цифры и факты против источников; формулы и подсчёты; для кода: логические ошибки, неверные граничные случаи, вызовы несуществующих функций, небезопасная работа с данными и файлами; пропущенное; выдуманное (контакты, почты, должности, цифры без источника).
`;
const tail = `Находка должна опираться на то, что ты видишь в файлах. Не пиши находку про то, чего в переданных файлах не может быть по замыслу (другие файлы проекта, настройки вне папки).
${args['must-quote'] ? `В разделе «Прочитано» для файла с источниками процитируй дословно строку, начинающуюся со слов «${args['must-quote']}».\n` : ''}
Ответ по-русски, строго в таком порядке:
ВЕРДИКТ: GREEN или YELLOW или RED (первая строка)
Прочитано: для каждого файла его имя и одна дословная цитата до 10 слов, в кавычках «ёлочках»
Находки: нумерованный список; у каждой серьёзность (блокирующая или неблокирующая), место (файл, строка или ячейка), что не так, на чём основан вывод (дословная цитата из файла)
Подтверждено: что проверено и совпало
Не проверено: что проверить не удалось и почему
GREEN: находок нет. YELLOW: только неблокирующие. RED: есть блокирующая.
`;
fs.writeFileSync(path.join(dir, 'prompt.md'), intro + body + tail);

const r = lib.toPosix(path.relative(root, dir));
process.stdout.write(`Папка проверки: ${r}\nРежим: ${mode === 'action' ? 'проверка намерения' : 'проверка результата'}; проверяет: ${reviewer.label} (${reviewer.vendor})\nМаскирование ПДн: ${mask ? 'включено' : 'выключено (решение человека: ' + policy + ')'}\nФайлов: ${files.length}, всего ${Math.round(total / 1024)} КБ\n`);
files.forEach((f) => { if (f.masked_emails || f.masked_phones) process.stdout.write(`  ${f.path || f.input_copy}: замаскировано почт ${f.masked_emails}, телефонов ${f.masked_phones}\n`); });
process.stdout.write(`Запуск проверяющего (из главной папки):\nnode .workplace/core/skills/cross-check/scripts/run-check.js ${r}\n`);
