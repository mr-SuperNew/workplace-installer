#!/usr/bin/env node
'use strict';
process.noDeprecation = true;
// Приёмочный стенд установщика: живое поведение ИИ у «чужого человека» по договору (CONTRACT.md, «Приёмка: 12 просьб»).
// Запуск ручной, тратит лимит подписки; в tests/run-all.js не входит.
//   node tests/acceptance/run.js --main claude|codex [--only 1,3,12] [--out <папка>] [--timeout 180] [--max-turns 10] [--model haiku] [--keep]
//   node tests/acceptance/run.js --main claude|codex --install [--case empty|claude-only|codex-only|scattered]   (сухой прогон установки до первого «да»)
// Что делает: для каждой просьбы раскладывает свежую песочницу (фейковый дом с фикстурами + главная папка через wp.js init/layout/hooks wire/git-init),
// запускает проверяемого ИИ в чистом окружении (lib/sandbox.js, lib/drive.js), оценивает результат (requests.js) и сверяет настоящую машину до и после (lib/gate.js).
// Выход: <out>/<прогон>/results-<main>.json, report-<main>.md, answers-<main>.md. Код выхода: 0 гейт чист; 1 гейт настоящей машины показал изменение (КРАСНЫЙ); 2 ошибка стенда.
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('./lib/sandbox');
const D = require('./lib/drive');
const G = require('./lib/gate');
const { REQUESTS, OTHER, needsSecondTurn } = require('./requests');
const J = require('./lib/judge');

const argv = process.argv.slice(2);
const opt = { main: null, only: null, out: null, timeout: 180, maxTurns: 10, model: 'haiku', keep: false, install: false, caseId: null, runId: null };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--main') opt.main = argv[++i];
  else if (a === '--only') opt.only = argv[++i].split(',').map((x) => parseInt(x, 10)).filter(Boolean);
  else if (a === '--out') opt.out = argv[++i];
  else if (a === '--timeout') opt.timeout = parseInt(argv[++i], 10);
  else if (a === '--max-turns') opt.maxTurns = parseInt(argv[++i], 10);
  else if (a === '--model') opt.model = argv[++i];
  else if (a === '--run-id') opt.runId = argv[++i];
  else if (a === '--case') opt.caseId = argv[++i];
  else if (a === '--install') opt.install = true;
  else if (a === '--keep') opt.keep = true;
  else { console.error('Неизвестный параметр ' + a); process.exit(2); }
}
if (!['claude', 'codex'].includes(opt.main)) { console.error('Нужен --main claude|codex'); process.exit(2); }
const reviewer = OTHER[opt.main];
// Песочницы лежат во временной папке, а не под ~/.claude: Claude Code считает любой путь с .claude «чувствительным» и сам останавливает удаление и правку (ложный тупик).
const outRoot = opt.out || path.join(os.tmpdir(), 'wp-acc');
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
const runId = opt.runId || (stamp + '-' + opt.main + (opt.install ? '-install' : ''));
const runDir = path.join(outRoot, runId);
fs.mkdirSync(runDir, { recursive: true });

const cell = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' <br> ');
const firstLines = (t, n, max) => String(t || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, n).join(' / ').slice(0, max || 420);

// Ход целиком: ответ, ходы, статус и КАЖДЫЙ вызов инструмента со входом и выходом без обрезки.
const turnRecord = (t) => ({ answer: t.answer, turns: t.turns, subtype: t.subtype, isError: t.isError, ms: t.ms, timedOut: t.timedOut, code: t.code, stderr: t.stderr, tools: (t.tools || []).map((x) => ({ name: x.name, input: x.input || {}, result: x.result == null ? null : x.result, exit: x.exit })) });

function scrubLogin(sb) { for (const f of [path.join(sb.cfg, '.credentials.json'), path.join(sb.codexHome, 'auth.json')]) { try { fs.rmSync(f, { force: true }); } catch (_) { /* уже нет */ } } }

async function runRequest(req, gateBefore) {
  const t0 = Date.now();
  const sb = S.build({ runDir, n: req.n, main: opt.main, reviewer, setup: req.setup });
  fs.writeFileSync(sb.events, '');
  const before = S.stateMap(sb);
  const ctx = { sb, main: opt.main, req };
  ctx.p0 = req.probe ? req.probe(sb) : {};
  ctx.leakBase = J.leakMap(sb);   // где значение ключа лежит до просьбы (.env и то, что положил сам стенд); всё новое после просьбы - утечка
  const prompt = req.prompt(sb, opt.main);
  ctx.t1 = await D.turn(sb, { prompt, timeoutMs: opt.timeout * 1000, maxTurns: Math.max(opt.maxTurns, req.maxTurns || 0), model: opt.model, tag: 't1' });
  ctx.p1 = req.probe ? req.probe(sb) : {};
  fs.writeFileSync(path.join(sb.out, 'answer-t1.txt'), ctx.t1.answer || '');
  // Второй ход («да», «нет») стенд даёт, только если ИИ действительно задал вопрос: у чужого человека подсказки нет.
  ctx.asked = needsSecondTurn(req, ctx.t1);
  if (req.second && ctx.asked) {
    ctx.t2 = await D.turn(sb, { prompt: req.second, cont: true, timeoutMs: opt.timeout * 1000, maxTurns: Math.max(opt.maxTurns, req.maxTurns || 0), model: opt.model, tag: 't2' });
    ctx.p2 = req.probe ? req.probe(sb) : {};
    fs.writeFileSync(path.join(sb.out, 'answer-t2.txt'), ctx.t2.answer || '');
  } else ctx.p2 = ctx.p1;
  ctx.events = S.events(sb);
  const allEvents = ctx.events;
  const after = S.stateMap(sb);
  let verdict;
  try {
    verdict = await req.judge(ctx);
    if (req.second && !ctx.asked) verdict.notes = (verdict.notes || []).concat(['второй ход («' + req.second + '») не давался: ИИ не задал вопроса']);
    if (verdict.verdict === 'ТУПИК' && [ctx.t1, ctx.t2].some((t) => t && (t.subtype === 'error_max_turns' || t.timedOut))) {
      verdict.why = ['лимит ходов или время (' + opt.maxTurns + ' ходов, ' + opt.timeout + ' с) исчерпан до результата; не тупик, а незавершённая работа: ' + verdict.why.join('; ')];
      verdict.verdict = 'БЕЗ ОТВЕТА';
    }
  } catch (e) { verdict = { verdict: 'ОШИБКА СТЕНДА', why: [String(e && e.stack || e).slice(0, 500)], notes: [] }; }
  scrubLogin(sb);
  const changed = [];
  for (const [k, v] of after) if (!before.has(k)) changed.push('+' + k); else if (before.get(k) !== v) changed.push('~' + k);
  for (const k of before.keys()) if (!after.has(k)) changed.push('-' + k);
  const gateNow = G.snapshot({ quick: true });
  const gateDiff = G.diff(gateBefore, gateNow);
  const res = {
    n: req.n, title: req.title, prompt, second: req.second || null, verdict: verdict.verdict, why: verdict.why, notes: verdict.notes,
    asked: ctx.asked,
    t1: turnRecord(ctx.t1),
    t2: ctx.t2 ? turnRecord(ctx.t2) : null,
    changedInSandbox: changed, events: ctx.events.filter((e) => e.src === 'standguard' || e.blocked || (e.src === 'shim' && !/^--?v(ersion)?$/.test(e.args[0] || ''))),
    gateDiff, seconds: Math.round((Date.now() - t0) / 1000), dir: sb.dir,
  };
  fs.writeFileSync(path.join(sb.out, 'result.json'), JSON.stringify(res, null, 2));
  // Доказательства целиком: полные ответы, входы и выходы всех инструментов обоих ходов, журнал стенда без отбора, состояние до и после, список изменённого без обрезки.
  const evDir = path.join(runDir, 'evidence-' + opt.main); fs.mkdirSync(evDir, { recursive: true });
  fs.writeFileSync(path.join(evDir, 'r' + req.n + '.json'), JSON.stringify({ n: req.n, title: req.title, prompt, second: req.second || null, asked: ctx.asked, verdict, t1: turnRecord(ctx.t1), t2: ctx.t2 ? turnRecord(ctx.t2) : null, probes: { p0: ctx.p0, p1: ctx.p1, p2: ctx.p2 }, events: allEvents, changedInSandbox: changed, leakBase: ctx.leakBase, rawLogs: { t1: path.join(sb.out, 't1.raw.jsonl'), t2: ctx.t2 ? path.join(sb.out, 't2.raw.jsonl') : null } }, null, 2));
  return res;
}

function writeReports(results, gate, meta) {
  const tup = results.filter((r) => r.verdict === 'ТУПИК').length, vio = results.filter((r) => r.verdict === 'НАРУШЕНИЕ').length;
  const part = results.filter((r) => r.verdict === 'ЧАСТИЧНО').length, noans = results.filter((r) => r.verdict === 'БЕЗ ОТВЕТА' || r.verdict === 'ОШИБКА СТЕНДА').length;
  const unver = results.filter((r) => r.verdict === 'НЕ ПРОВЕРЕНО').length, okn = results.filter((r) => r.verdict === 'OK').length;
  const total = opt.install ? results.length : REQUESTS.length;
  const skipped = !opt.install && !opt.only && opt.main === 'codex' ? ' (просьбы 4 и 5 для Codex не прогонялись, причина в lib/drive.js)' : '';
  const line = 'ТУПИКОВ ' + tup + ', НАРУШЕНИЙ ' + vio + ' из ' + (opt.only ? results.length + ' прогнанных (из ' + total + ')' : (skipped ? results.length + ' прогнанных (из ' + total + ')' + skipped : total)) + ' (OK ' + okn + ', НЕ ПРОВЕРЕНО ' + unver + (part || noans ? ', частично ' + part + ', без ответа/ошибка ' + noans : '') + ')';
  const md = [];
  md.push('# Приёмка v4: основной ' + opt.main + (opt.install ? ' (установка)' : ''), '');
  md.push('**' + line + '**', '');
  md.push(gate.clean ? 'Настоящая машина: без изменений (гейт до/после).' : '**ГЕЙТ НАСТОЯЩЕЙ МАШИНЫ КРАСНЫЙ: ' + gate.diff.map((d) => d.key + ' [' + d.before + ' -> ' + d.after + ']').join('; ') + '**', '');
  md.push('Модель: ' + (opt.main === 'claude' ? opt.model : 'Codex по умолчанию') + '; ходов не больше ' + opt.maxTurns + '; таймаут ' + opt.timeout + ' с. Пакет: ' + meta.pkgHash + '. Прогон: `' + runId + '`.', '');
  md.push('| № | Просьба | Вердикт | Первые строки ответа | Что сработало |', '|---|---|---|---|---|');
  for (const r of results) {
    const what = r.why.concat(r.notes).join('; ') + (r.second ? ' [второй ход: «' + r.second + '»]' : '');
    md.push('| ' + [r.n, cell(r.title), '**' + r.verdict + '**', cell(firstLines(r.t1.answer, 3, 380) || '(пусто)'), cell(what)].join(' | ') + ' |');
  }
  fs.writeFileSync(path.join(runDir, 'report-' + opt.main + '.md'), md.join('\n') + '\n');
  const ans = ['# Дословные ответы (основной ' + opt.main + ')', ''];
  for (const r of results) {
    ans.push('## ' + r.n + '. ' + r.title + ' — ' + r.verdict, '', '**Просьба:** ' + r.prompt, '', '**Ответ, ход 1** (' + r.t1.ms + ' мс, ходов ' + r.t1.turns + (r.t1.timedOut ? ', ТАЙМАУТ' : '') + '):', '', '```', String(r.t1.answer || '(пусто)'), '```', '');
    if (r.t2) ans.push('**Второй ход стенда:** «' + r.second + '»', '', '**Ответ, ход 2:**', '', '```', String(r.t2.answer || '(пусто)'), '```', '');
    const tl = (t, k) => (t && t.tools || []).map((x) => x.name + ': ' + JSON.stringify(x.input || {}) + (x.result != null ? ' => ' + String(x.result).replace(/s+/g, ' ') : '')).map((x) => '- ' + x);
    ans.push('Вызовы инструментов, ход 1 (полностью; все вызовы обоих ходов с выходами - evidence-' + opt.main + '/r' + r.n + '.json):', ...(tl(r.t1).length ? tl(r.t1) : ['- нет']), '');
    if (r.t2) ans.push('Вызовы инструментов, ход 2:', ...(tl(r.t2).length ? tl(r.t2) : ['- нет']), '');
  }
  fs.writeFileSync(path.join(runDir, 'answers-' + opt.main + '.md'), ans.join('\n'));
  return line;
}

function pkgHash() {
  const H = require('../lib/harness');
  return H.treeHash(S.KIT, ['tests', 'dist', 'release', '.git']).slice(0, 12);
}

(async () => {
  const gate0 = G.snapshot();
  fs.writeFileSync(path.join(runDir, 'gate-before.json'), JSON.stringify(gate0, null, 2));
  const meta = { pkgHash: pkgHash() };
  let results = [], aborted = null;
  if (opt.install) {
    const inst = require('./install-scenario');
    results = await inst.run({ opt, runDir, reviewer, gateBefore: gate0 });
  } else {
    // Для Codex просьбы 4 и 5 (установка, обновление) без явного --only не прогоняются: у Codex нет сторожа стенда, настоящую установку по сети нечем остановить.
    const todo = REQUESTS.filter((r) => (opt.only ? opt.only.includes(r.n) : !(opt.main === 'codex' && [4, 5].includes(r.n))));
    for (const req of todo) {
      process.stdout.write('[' + new Date().toTimeString().slice(0, 8) + '] просьба ' + req.n + ' (' + req.title + ') ... ');
      let res;
      try { res = await runRequest(req, gate0); } catch (e) { res = { n: req.n, title: req.title, prompt: '', verdict: 'ОШИБКА СТЕНДА', why: [String(e.message || e).slice(0, 600)], notes: [], t1: { answer: '', tools: [], ms: 0 }, t2: null, gateDiff: [] }; }
      results.push(res);
      console.log(res.verdict + ' (' + (res.seconds || 0) + ' с)');
      if (res.gateDiff && res.gateDiff.length) { aborted = 'гейт настоящей машины показал изменение после просьбы ' + req.n; console.log('!!! ' + aborted + ': ' + JSON.stringify(res.gateDiff)); break; }
    }
  }
  const gate1 = G.snapshot();
  fs.writeFileSync(path.join(runDir, 'gate-after.json'), JSON.stringify(gate1, null, 2));
  const diff = G.diff(gate0, gate1);
  const gate = { clean: diff.length === 0, diff, aborted };
  const line = writeReports(results, gate, meta);
  fs.writeFileSync(path.join(runDir, 'results-' + opt.main + '.json'), JSON.stringify({ opt, meta, gate, results }, null, 2));
  console.log('\n' + line);
  console.log(gate.clean ? 'Настоящая машина: БЕЗ ИЗМЕНЕНИЙ' : 'ГЕЙТ КРАСНЫЙ: ' + JSON.stringify(diff));
  console.log('Отчёт: ' + path.join(runDir, 'report-' + opt.main + '.md'));
  process.exit(gate.clean ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
