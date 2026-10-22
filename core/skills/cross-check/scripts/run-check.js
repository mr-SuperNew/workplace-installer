#!/usr/bin/env node
'use strict';
// Запускает проверяющего (того, кто указан в .workplace/config.json как reviewer: Codex или Claude Code) на подготовленной папке проверки
// и кладёт ответ в verdict.md. Одинаково работает на Mac и Windows.
//   node run-check.js checks/<id> [--timeout 900] [--in-place]
// Корень определяется по расположению скрипта; --root и любые пути записи не принимаются.
//
// Что делает:
//  - копирует checks/<id>/input/ в checks/<id>/run-copy/ (ВНУТРИ корня; временной папки ОС скрипт не использует) и запускает проверяющего оттуда:
//    он видит только копии. В конце run-copy/ удаляется (только внутри checks/<id>/); --in-place запускает прямо в checks/<id>/input;
//  - сам запуск (команда, режим «только чтение», вход, таймаут, убийство дерева процессов) делает core/providers/<reviewer>.review():
//    различие Codex и Claude живёт только там; модель берётся из config.json (reviewer_model), по умолчанию не задана;
//  - ход работы проверяющего пишется в review.log, итог запуска в run.json (проверяющий, код выхода, время начала и конца, хеши prompt.md и verdict.md):
//    это доказательство настоящего запуска, без него finalize-check.js вердикт не принимает (core/lib/runproof.js);
//  - код возврата проверяющего ничего не доказывает: принимает проверку finalize-check.js.
const fs = require('fs');
const path = require('path');
const lib = require('./lib');

function die(m, code) { process.stderr.write(m + '\n'); process.exit(code || 1); }
const parsed = lib.parseArgs(process.argv.slice(2), { bool: ['in-place'], value: ['timeout'], positional: 1 });
if (parsed.error) die(parsed.error);
const args = parsed.args;
const target = parsed.positional[0] || null;
if (!target) die('Укажи папку проверки: node run-check.js checks/<id>');

const rr = lib.resolveRoot();
if (rr.error) die(rr.error);
const root = rr.root;
const lc = lib.loadConfig(root);
if (lc.error) die(lc.error);
const reviewer = lc.reviewer;
const rd = lib.resolveCheckDir(root, target);
if (rd.error) die(rd.error);
const dir = rd.dir;
const linked = lib.linkedEntries(dir, ['input', 'run-copy', 'prompt.md', 'verdict.md', 'review.log', 'run.json', 'manifest.json']);
if (linked.length) die('В папке проверки есть ссылки вместо файлов (' + linked.join(', ') + '): запись отменена.');
for (const f of ['manifest.json', 'prompt.md']) if (!fs.existsSync(path.join(dir, f))) die('Нет ' + f + ' в ' + target + ': сначала prepare-check.js');
const timeoutSec = Math.max(5, parseInt(args.timeout || '540', 10) || 540);

// Рабочая копия только внутри checks/<id>/run-copy. Остаток прошлого сбоя (настоящая папка, не ссылка: ссылки отсёк linkedEntries) убираем перед запуском.
const copyDir = path.join(dir, 'run-copy');
function removeCopy() { fs.rmSync(copyDir, { recursive: true, force: true }); }
let workDir, madeCopy = false;
if (args['in-place']) workDir = path.join(dir, 'input');
else {
  try {
    removeCopy();
    fs.cpSync(path.join(dir, 'input'), copyDir, { recursive: true });
    madeCopy = true;
    workDir = copyDir;
  } catch (e) { try { removeCopy(); } catch (_) { /* не критично */ } die('Не удалось создать рабочую копию checks/' + path.basename(dir) + '/run-copy (' + e.message + '). Повтори с --in-place.'); }
}

const verdictPath = path.join(dir, 'verdict.md');
const logPath = path.join(dir, 'review.log');
const prompt = fs.readFileSync(path.join(dir, 'prompt.md'), 'utf8');
let manifestId = null;
try { manifestId = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).id || null; } catch (_) { /* finalize скажет */ }
process.stdout.write('Проверяет: ' + reviewer.label + (lc.cfg.reviewer_model ? ' (модель ' + lc.cfg.reviewer_model + ')' : ' (модель по умолчанию)') + '\n');

(async () => {
  try { fs.rmSync(verdictPath, { force: true }); } catch (_) { /* нет файла */ }   // вердикт прошлого запуска не должен сойти за новый
  try { fs.rmSync(path.join(dir, 'run.json'), { force: true }); } catch (_) { /* нет файла */ }
  const startedAt = new Date();
  let r;
  try {
    r = await reviewer.review({ dir: workDir, prompt, outFile: verdictPath, timeoutMs: timeoutSec * 1000, model: lc.cfg.reviewer_model || undefined, logFile: logPath });
  } catch (e) { r = { ok: false, kind: 'failed', hint: 'Запуск не состоялся: ' + e.message, code: null, durationMs: 0 }; }
  if (madeCopy) { try { removeCopy(); } catch (_) { /* не критично */ } }
  const finishedAt = new Date();
  const size = fs.existsSync(verdictPath) ? fs.statSync(verdictPath).size : 0;
  const sec = Math.round((r.durationMs || 0) / 1000);
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({
    check_id: manifestId, provider: lc.cfg.reviewer, reviewer: lc.cfg.reviewer, model: lc.cfg.reviewer_model || null, kind: r.kind, ok: !!r.ok,
    exit_code: r.code === undefined ? null : r.code, timed_out: r.kind === 'timeout', started_at: startedAt.toISOString(), finished_at: finishedAt.toISOString(), seconds: sec,
    prompt_sha256: lib.sha256(Buffer.from(prompt, 'utf8')), verdict_bytes: size, verdict_sha256: size ? lib.sha256File(verdictPath) : null, in_place: !!args['in-place'],
  }, null, 2) + '\n');
  process.stdout.write(`${reviewer.label} завершил: итог ${r.kind}, ${sec} с, verdict.md ${size} байт.\n`);
  if (r.hint) process.stdout.write('Подсказка: ' + r.hint + '\n');
  if (!r.ok || !size) {
    process.stdout.write('Проверка НЕ ПРОВЕРЕНО: ответа нет. Журнал: ' + lib.toPosix(path.relative(root, logPath)) + '\n');
    process.exit(2);
  }
  process.stdout.write('Дальше: node .workplace/core/skills/cross-check/scripts/finalize-check.js ' + lib.toPosix(path.relative(root, dir)) + '\n');
  process.exit(0);
})();
