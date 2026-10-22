#!/usr/bin/env node
'use strict';
// Принимает вердикт проверяющего или отклоняет его как «НЕ ПРОВЕРЕНО». Обновляет checks/<id>/manifest.json. Не зависит от того, Codex это или Claude.
// Код возврата проверяющего ничего не доказывает, поэтому проверяем сам вердикт:
//  1. verdict.md не пуст, первая строка «ВЕРДИКТ: GREEN|YELLOW|RED»;
//  2. нет сплошных «???» вместо русских букв;
//  3. в разделе «Прочитано» для КАЖДОГО файла из input/ есть дословная цитата из этого файла;
//  4. (если задано --must-quote в prepare) цитата с контрольной строкой есть и верна;
//  5. оригиналы не менялись с момента подготовки (хеш совпадает; текст --action хранится в манифесте и не сверяется с диском);
//  6. (если задано --expect-mention "Бета|4,0") проверяющий назвал заведомую ошибку: иначе проверка «слепая»;
//  7. (если задано --expect-verdict RED) вердикт именно такой: GREEN при названной ошибке тоже слепая проверка;
//  8. рядом лежит run.json от run-check.js: проверяющий (provider) равен reviewer из config.json и манифеста, код выхода 0, хеши verdict.md и prompt.md совпали,
//     время запуска после подготовки проверки. Рукописный verdict.md без запуска проверяющего принят не будет (core/lib/runproof.js).
//
//   node finalize-check.js checks/<id> [--expect-mention "токен1|токен2"] [--expect-verdict RED]
// Корень определяется по расположению скрипта; --root и любые пути записи не принимаются.
const fs = require('fs');
const path = require('path');
const lib = require('./lib');

function die(m) { process.stderr.write(m + '\n'); process.exit(1); }
const parsed = lib.parseArgs(process.argv.slice(2), { bool: [], value: ['expect-mention', 'expect-verdict'], positional: 1 });
if (parsed.error) die(parsed.error);
const args = parsed.args;
const target = parsed.positional[0] || null;
if (!target) die('Укажи папку проверки: node finalize-check.js checks/<id>');
if (args['expect-verdict'] && !/^(GREEN|YELLOW|RED)$/.test(args['expect-verdict'])) die('--expect-verdict: GREEN, YELLOW или RED.');

const rr = lib.resolveRoot();
if (rr.error) die(rr.error);
const root = rr.root;
const rd = lib.resolveCheckDir(root, target);
if (rd.error) die(rd.error);
const dir = rd.dir;
const linked = lib.linkedEntries(dir, ['manifest.json', 'verdict.md', 'input']);
if (linked.length) die('В папке проверки есть ссылки вместо файлов (' + linked.join(', ') + '): запись отменена.');
const mf = path.join(dir, 'manifest.json');
if (!fs.existsSync(mf)) die('Нет manifest.json в ' + target);
const manifest = JSON.parse(fs.readFileSync(mf, 'utf8'));

const reasons = [];
const lc = lib.loadConfig(root);
if (lc.error) die(lc.error);
const proof = lib.runproof.verifyRun(dir, manifest, lc.cfg.reviewer);
if (!proof.ok) for (const p of proof.problems) reasons.push('нет доказательства запуска проверяющего: ' + p);
for (const f of manifest.files) {
  if ((!f.virtual && !lib.insideDir(root, f.path)) || !lib.insideDir(path.join(dir, 'input'), f.input_copy)) die('В manifest.json путь вне главной папки (' + (f.path || f.input_copy) + '): проверка отклонена.');
}
let verdictText = '';
try { verdictText = fs.readFileSync(path.join(dir, 'verdict.md'), 'utf8'); } catch (_) { /* пусто */ }
let verdict = null;

if (!verdictText.trim()) reasons.push('verdict.md пуст или не создан (смотри review.log)');
else {
  const first = verdictText.split(/\r?\n/).find((l) => l.trim());
  const m = first && first.replace(/[*#_`>]/g, '').match(/^\s*ВЕРДИКТ:\s*(GREEN|YELLOW|RED)\b/i);
  if (!m) reasons.push('первая строка не «ВЕРДИКТ: GREEN, YELLOW или RED»');
  else verdict = m[1].toUpperCase();
  if (/\?{3,}/.test(verdictText)) reasons.push('в тексте «???» вместо русских букв (кодировка)');

  const section = lib.readSection(verdictText);
  if (!section) reasons.push('нет раздела «Прочитано»');
  else {
    const quotes = lib.extractQuotes(section);
    const inputs = {};
    for (const f of manifest.files) {
      try { inputs[f.input_copy] = lib.norm(fs.readFileSync(path.join(dir, 'input', f.input_copy), 'utf8')); } catch (_) { inputs[f.input_copy] = ''; }
    }
    for (const f of manifest.files) {
      if (!quotes.some((q) => inputs[f.input_copy].includes(q))) reasons.push('в «Прочитано» нет верной цитаты из ' + f.input_copy + ' (файл не прочитан или цитата выдумана)');
    }
    if (manifest.must_quote) {
      const ok = quotes.some((q) => q.includes(lib.norm(manifest.must_quote)) && Object.values(inputs).some((t) => t.includes(q)));
      if (!ok) reasons.push('нет верной цитаты с контрольной строкой «' + manifest.must_quote + '»');
    }
  }
}

for (const f of manifest.files) {
  if (f.virtual) continue;
  let cur = null;
  try { cur = lib.sha256File(path.join(root, f.path)); } catch (_) { /* файл удалён */ }
  if (cur !== f.sha256) reasons.push('файл ' + f.path + ' изменился после подготовки проверки: проверка относится к старой версии');
}

if (args['expect-mention'] && verdictText) {
  const tokens = args['expect-mention'].split('|').map((s) => s.trim()).filter(Boolean);
  const findings = (verdictText.split(/^[\s#*_>-]*Находки(?![а-яёА-ЯЁ\w])/im)[1] || verdictText).split(/^[\s#*_>-]*(?:Подтверждено|Не проверено)(?![а-яёА-ЯЁ\w])/im)[0];
  // число могут записать через точку или запятую: «4,0» и «4.0» одно и то же
  const missing = tokens.filter((t) => !findings.includes(t) && !(/\d[,.]\d/.test(t) && findings.includes(t.replace(',', '.'))) && !(/\d[,.]\d/.test(t) && findings.includes(t.replace('.', ','))));
  if (missing.length) reasons.push('проверяющий не назвал заведомую ошибку (нет в находках: ' + missing.join(', ') + '): проверка слепая');
  manifest.expect_mention = tokens;
}
if (args['expect-verdict'] && verdict && verdict !== args['expect-verdict']) reasons.push('вердикт ' + verdict + ', а при заведомой ошибке ожидался ' + args['expect-verdict'] + ': проверка слепая');
if (args['expect-verdict']) manifest.expect_verdict = args['expect-verdict'];

manifest.checked_at = new Date().toISOString();
if (reasons.length) {
  delete manifest.run_proof;
  manifest.status = 'not_checked';
  manifest.verdict = verdict;
  manifest.reasons = reasons;
  fs.writeFileSync(mf, JSON.stringify(manifest, null, 2) + '\n');
  process.stdout.write('РЕЗУЛЬТАТ: НЕ ПРОВЕРЕНО\n' + reasons.map((r) => '- ' + r).join('\n') + '\n');
  process.exit(3);
}
manifest.status = 'checked';
manifest.verdict = verdict;
manifest.run_proof = { provider: lc.cfg.reviewer, verdict_sha256: lib.sha256File(path.join(dir, 'verdict.md')), run_json_sha256: lib.sha256File(path.join(dir, 'run.json')) };
delete manifest.reasons;
fs.writeFileSync(mf, JSON.stringify(manifest, null, 2) + '\n');
process.stdout.write('РЕЗУЛЬТАТ: принято, ВЕРДИКТ ' + verdict + '\nМанифест: ' + lib.toPosix(path.relative(root, mf)) + '\n');
