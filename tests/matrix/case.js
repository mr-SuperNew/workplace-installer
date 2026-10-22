#!/usr/bin/env node
'use strict';
// Один прогон матрицы: случай (empty | claude-only | codex-only | scattered) и направление (основной claude или codex) на заглушках в фейковом HOME.
//   node tests/matrix/case.js <случай> <основной: claude|codex>
// Порядок как у человека: разведка -> план -> init (по состоянию «до») -> «установка» -> раскладка -> сторожа -> самопроверка -> отчёт.
// «Установка» недостающего ИИ в тесте = заглушка появляется в PATH (сама установка из сети в тест не входит: она проверена по плану и `install --dry-run`).
// Фейковый HOME (WP_HOME, HOME, USERPROFILE) и PATH без настоящих claude и codex: настоящие ~/.claude и ~/.codex не затрагиваются.
const path = require('path');
const H = require('../lib/harness');
const stubsLib = require('../lib/stubs');

const CASES = { empty: [], 'claude-only': ['claude'], 'codex-only': ['codex'], scattered: ['claude', 'codex'] };
const SUGGESTED = { empty: 'claude', 'claude-only': 'claude', 'codex-only': 'claude', scattered: 'claude' };   // выпуск 1: основным всегда Claude Code, основной Codex только по просьбе (H3)
const LABEL = { claude: 'Claude Code', codex: 'Codex' };
const CONTACT = 'https://t.me/' + 'moneyBaires';

const caseId = process.argv[2], main = process.argv[3];
if (!(caseId in CASES) || !['claude', 'codex'].includes(main)) { console.error('Использование: node tests/matrix/case.js <empty|claude-only|codex-only|scattered> <claude|codex>'); process.exit(2); }
const reviewer = main === 'claude' ? 'codex' : 'claude';
const present = CASES[caseId];
const missing = ['claude', 'codex'].filter((p) => !present.includes(p));
const tag = caseId + ' / основной ' + main + ', проверяет ' + reviewer;

const S = new H.Suite(tag);
const ok = (n, c, d) => S.ok('[' + tag + '] ' + n, c, d);
const TMP = H.mkTmp('wp-matrix-');
const HOME = path.join(TMP, 'home');
const ROOT = path.join(HOME, 'workplace');
const LOG = path.join(TMP, 'stub.log');
const BIN_START = stubsLib.prepare(path.join(TMP, 'bin-start'), ['python', 'python3', ...present]);
const BIN_FULL = stubsLib.prepare(path.join(TMP, 'bin-full'), ['python', 'python3', 'codex', 'claude']);
const BIN_GIT = stubsLib.prepare(path.join(TMP, 'bin-git'), ['python', 'python3', 'git', ...present]);
const envStart = () => H.sandboxEnv(HOME, { path: H.minPath([BIN_START]), extra: { STUB_LOG: LOG } });
const envFull = (extra) => H.sandboxEnv(HOME, { path: H.minPath([BIN_FULL]), extra: Object.assign({ STUB_LOG: LOG }, extra || {}) });
const wpPkg = (args, env) => H.node(H.WP_SRC, args, { cwd: TMP, env: env || envStart() });
const WP_ROOT = path.join(ROOT, '.workplace', 'core', 'cli', 'wp.js');
const wp = (args, env) => H.node(WP_ROOT, args, { cwd: ROOT, env: env || envFull() });
const json = (r) => { try { return JSON.parse(r.out); } catch (_) { return null; } };

try {
  // фейковая домашняя папка с личными файлами: после всего прогона вне главной папки они те же
  H.write(path.join(HOME, '.zshrc'), '# мой zshrc\nexport EDITOR=vim\n');
  H.write(path.join(HOME, '.gitconfig'), '[user]\n\tname = Test Person\n\temail = test@example.com\n');
  H.write(path.join(HOME, 'Documents', 'notes', 'a.txt'), 'просто файлы\n');
  const homeBefore = H.treeMap(HOME);

  // ---- 1. разведка: называет случай, ничего не пишет (К6)
  S.section(tag + ': разведка');
  let r = wpPkg(['recon', '--json', '--no-scan']);
  const rj = json(r);
  ok('recon --json: код 0 и разбирается', r.code === 0 && !!rj, r.all);
  ok('recon называет случай «' + caseId + '»', rj && rj.case.id === caseId, rj && rj.case.id + ': ' + rj.case.why.join('; '));
  ok('recon: оба CLI ищутся симметрично (claude ' + present.includes('claude') + ', codex ' + present.includes('codex') + ')', rj && rj.claude.console === present.includes('claude') && rj.codex.console === present.includes('codex'), rj && JSON.stringify([rj.claude.console, rj.codex.console]));
  ok('recon предлагает основным ' + SUGGESTED[caseId], rj && rj.case.suggested.main === SUGGESTED[caseId] && rj.case.suggested.reviewer !== SUGGESTED[caseId], rj && JSON.stringify(rj.case.suggested));
  ok('recon: Node, Python на месте; git есть (настоящий или заглушка)', rj && rj.tools.node.ok && rj.tools.python.version === '3.12.0', rj && JSON.stringify([rj.tools.node.ok, rj.tools.python]));
  r = wpPkg(['recon', '--no-scan']);
  ok('recon (текст): строка «Случай» с названием случая', r.code === 0 && new RegExp('Случай: \\*\\*[^*]+\\*\\* \\(' + caseId + '\\)').test(r.out), r.out.slice(0, 400));
  const install = (rj ? rj.plan : []).filter((x) => x.action === 'поставлю после да').map((x) => x.item);
  const wantRows = missing.map((p) => (p === 'claude' ? 'Claude Code, консольная команда claude' : 'Codex, консольная команда codex'));
  ok('таблица разведки: «поставлю после да» ровно у недостающих (' + (wantRows.join('; ') || 'ничего') + ')', JSON.stringify(install.sort()) === JSON.stringify(wantRows.sort()), JSON.stringify(install));
  ok('разведка и план не изменили ни байта в домашней папке (К6)', H.mapDiff(homeBefore, H.treeMap(HOME)).changed.length === 0 && H.mapDiff(homeBefore, H.treeMap(HOME)).added.length === 0 && H.mapDiff(homeBefore, H.treeMap(HOME)).removed.length === 0, H.mapDiffText(homeBefore, H.treeMap(HOME)));

  // ---- 2. план: перечисляет ровно недостающее, для ЭТОГО направления
  S.section(tag + ': план');
  r = wpPkg(['plan', '--main', main, '--reviewer', reviewer, '--json']);
  const pj = json(r);
  ok('plan --json: код 0 и разбирается', r.code === 0 && !!pj, r.all);
  if (pj) {
    ok('plan: направление основной ' + main + ', проверяет ' + reviewer, pj.direction.main === main && pj.direction.reviewer === reviewer, JSON.stringify(pj.direction));
    const need = pj.steps.filter((s) => s.status === 'needs-install');
    const needProv = need.filter((s) => s.provider).map((s) => s.provider).sort();
    ok('plan: установка нужна ровно для ' + (missing.join(', ') || 'никого'), JSON.stringify(needProv) === JSON.stringify([...missing].sort()), JSON.stringify(need.map((s) => s.stage)));
    ok('plan: больше ничего не ждёт установки (Node, Python, git на месте)', need.length === missing.length, JSON.stringify(need.map((s) => s.stage)));
    for (const [role, prov] of [['main', main], ['reviewer', reviewer]]) {
      const st = pj.steps.find((s) => s.stage === 'P1.' + role);
      ok('plan: этап P1.' + role + ' (' + prov + ') ' + (present.includes(prov) ? 'done' : 'needs-install, провайдер ' + prov), st && (present.includes(prov) ? st.status === 'done' : st.status === 'needs-install' && st.provider === prov && st.role === role), JSON.stringify(st && [st.status, st.provider, st.role]));
      ok('plan: у этапа входа P1.' + role + '-login есть шаг входа для ' + prov, !!pj.steps.find((s) => s.stage === 'P1.' + role + '-login' && s.provider === prov), '');
    }
    const roleOfMissing = missing.map((p) => (p === main ? 'P1.main' : 'P1.reviewer'));
    ok('plan: недостающий ИИ привязан к роли направления (' + roleOfMissing.join(', ') + ')', JSON.stringify(need.filter((s) => s.provider).map((s) => s.stage).sort()) === JSON.stringify(roleOfMissing.sort()), JSON.stringify(need.map((s) => s.stage)));
  }
  r = wpPkg(['plan', '--main', main, '--reviewer', reviewer]);
  for (const [role, prov] of [['main', main], ['reviewer', reviewer]]) {
    const line = r.out.split(/\r?\n/).find((l) => l.startsWith('- [P1.' + role + ']')) || '';
    ok('plan (текст): строка P1.' + role + (present.includes(prov) ? ' «уже есть»' : ' «после да»'), present.includes(prov) ? /уже есть/.test(line) : (/после «да»/.test(line) && line.includes(LABEL[prov])), line);
  }
  // заглушка git первой в PATH: разведка берёт копию в порядке PATH и не считает её недостающей
  r = wpPkg(['plan', '--main', main, '--reviewer', reviewer, '--json'], H.sandboxEnv(HOME, { path: H.minPath([BIN_GIT]), extra: { STUB_LOG: LOG } }));
  const pg = json(r);
  const gitStep = pg && pg.steps.find((s) => s.stage === 'P1.git');
  ok('plan: git найден первой копией из PATH (заглушка) и не ждёт установки', gitStep && gitStep.status === 'done' && /stub/.test(gitStep.note || ''), JSON.stringify(gitStep));
  r = wpPkg(['plan', '--main', main, '--reviewer', reviewer]);
  const homeAfterPlan = H.treeMap(HOME);
  ok('после плана домашняя папка та же', H.mapDiffText(homeBefore, homeAfterPlan) === 'изменено: ; добавлено: ; убрано: ', H.mapDiffText(homeBefore, homeAfterPlan));

  // ---- 3. init по состоянию «до»
  S.section(tag + ': init');
  r = wpPkg(['init', '--root', ROOT, '--main', main, '--no-scan']);
  ok('init: код 0', r.code === 0, r.all);
  const st0 = H.exists(path.join(ROOT, '.workplace', 'state.json')) ? H.readJson(path.join(ROOT, '.workplace', 'state.json')) : null;
  ok('state.json: случай ' + caseId + ', направление ' + main + '/' + reviewer, st0 && st0.case === caseId && st0.direction.main === main && st0.direction.reviewer === reviewer, st0 && JSON.stringify([st0.case, st0.direction]));
  for (const [role, prov] of [['main', main], ['reviewer', reviewer]]) {
    const s = st0 && st0.stages['P1.' + role];
    ok('state.json: P1.' + role + ' (' + prov + ') ' + (present.includes(prov) ? 'done' : 'needs-install («поставить после да»)'), s && s.status === (present.includes(prov) ? 'done' : 'needs-install'), s && s.status);
  }
  const cfg0 = H.readJson(path.join(ROOT, '.workplace', 'config.json'));
  ok('config.json: main ' + main + ', reviewer ' + reviewer, cfg0.main === main && cfg0.reviewer === reviewer, JSON.stringify(cfg0));
  const rb = H.exists(path.join(ROOT, '.workplace', 'recon-before.json')) ? H.readJson(path.join(ROOT, '.workplace', 'recon-before.json')) : null;
  ok('recon-before.json называет тот же случай', rb && rb.case.id === caseId);
  // установка недостающего: сухой прогон показывает официальный адрес и ничего не пишет; то, что уже стоит, не переустанавливается даже с --yes
  const envNow = () => H.sandboxEnv(HOME, { path: H.minPath([BIN_START]), extra: { STUB_LOG: LOG } });
  for (const prov of missing) {
    const before = H.treeMap(HOME, ['workplace']);
    r = wp(['install', prov, '--dry-run'], envNow());
    ok('install ' + prov + ' --dry-run: код 0, официальный адрес в выводе, ничего не выполнялось', r.code === 0 && /https:\/\/(claude\.ai|chatgpt\.com)\//.test(r.out) && /ничего не выполнялось/.test(r.out), r.all);
    ok('install ' + prov + ' --dry-run: домашняя папка та же', H.mapDiffText(before, H.treeMap(HOME, ['workplace'])) === 'изменено: ; добавлено: ; убрано: ', H.mapDiffText(before, H.treeMap(HOME, ['workplace'])));
  }
  for (const prov of present) {
    const stBefore = H.sha(path.join(ROOT, '.workplace', 'state.json'));
    r = wp(['install', prov, '--yes'], envNow());
    ok('install ' + prov + ' --yes при уже стоящей программе: не переустанавливает (код 0, «уже стоит»)', r.code === 0 && /уже стоит/.test(r.out), r.all);
    const sj = H.readJson(path.join(ROOT, '.workplace', 'state.json'));
    ok('install ' + prov + ': записей об установке нет', (sj.installs || []).length === 0, JSON.stringify(sj.installs));
    void stBefore;
  }

  // ---- 4. «установка» (заглушка в PATH), раскладка, сторожа
  S.section(tag + ': раскладка и сторожа');
  for (const prov of missing) {
    const role = prov === main ? 'main' : 'reviewer';
    r = wp(['state', 'set', 'P1.' + role, 'done', '--action', 'installed', '--note', 'заглушка вместо установки']);
    ok('этап P1.' + role + ' записан как поставленный', r.code === 0, r.all);
  }
  r = wp(['layout']);
  ok('layout: код 0', r.code === 0, r.all);
  r = wp(['hooks', 'wire']);
  ok('hooks wire: код 0', r.code === 0, r.all);
  r = wp(['hooks', 'status']);
  ok('hooks status: все сторожа есть и подключены', r.code === 0 && !/НЕТ |не подключён|ОШИБКА/.test(r.out), r.out);
  r = wp(['hooks', 'test']);
  ok('hooks test: сторожа отвечают как положено', r.code === 0 && /Все отвечают как положено/.test(r.out), r.all);
  const WANT = { claude: ['secret-guard', 'danger-guard', 'cross-check-guard', 'model-guard', 'session-start', 'feedback-reminder', 'human-message'], codex: ['secret-guard', 'danger-guard', 'cross-check-guard', 'session-start', 'feedback-reminder', 'human-message'] };
  const mainFile = main === 'claude' ? path.join(ROOT, '.claude', 'settings.json') : path.join(ROOT, '.codex', 'hooks.json');
  ok('файл подключения основного (' + path.relative(ROOT, mainFile).replace(/\\/g, '/') + ') создан', H.exists(mainFile));
  if (H.exists(mainFile)) {
    const j = H.readJson(mainFile);
    const cmds = [];
    for (const groups of Object.values(j.hooks || {})) for (const g of groups) for (const h of g.hooks) cmds.push({ cmd: h.command, matcher: g.matcher || '' });
    const names = [...new Set(cmds.map((c) => (c.cmd.match(/hooks\/([\w-]+)\.js/) || [])[1]).filter(Boolean))].sort();
    ok('в файле основного подключены сторожа: ' + WANT[main].join(', '), JSON.stringify(names) === JSON.stringify([...WANT[main]].sort()), names.join(', '));
    ok('каждый подключённый сторож указывает на существующий скрипт в .workplace/core/hooks', cmds.every((c) => { const m = c.cmd.match(/\.workplace\/core\/hooks\/[\w-]+\.js/); return m && H.exists(path.join(ROOT, m[0])); }), JSON.stringify(cmds.map((c) => c.cmd)));
    if (main === 'claude') {
      const pw = (n) => cmds.filter((c) => c.cmd.includes(n + '.js')).every((c) => /PowerShell/.test(c.matcher));
      ok('Claude: сторожа secret-guard, danger-guard, cross-check-guard ловят и PowerShell', ['secret-guard', 'danger-guard', 'cross-check-guard'].every(pw), JSON.stringify(cmds.filter((c) => /guard/.test(c.cmd)).map((c) => c.matcher)));
      ok('Claude: разрешения на скрипты пакета в permissions.allow', ((j.permissions || {}).allow || []).some((x) => /wp\.js/.test(x)), JSON.stringify(j.permissions));
    } else {
      ok('Codex: у хуков есть commandWindows', cmds.length > 0 && Object.values(j.hooks).every((gs) => gs.every((g) => g.hooks.every((h) => typeof h.commandWindows === 'string'))), '');
    }
  }
  const am = H.read(path.join(ROOT, 'AGENTS.md')), cm = H.read(path.join(ROOT, 'CLAUDE.md'));
  ok('AGENTS.md: роли подставлены (' + LABEL[main] + ' делает, ' + LABEL[reviewer] + ' проверяет), временная метка снята', am.includes(LABEL[main] + ' делает') && am.includes(LABEL[reviewer] + ' проверяет') && !am.includes('wp-bootstrap') && !/\{\{/.test(am), am.slice(0, 300));
  ok('AGENTS.md называет режим --action и формат записи в checks/POLICY.md', /--action/.test(am) && /ПДн проверяющему: можно\|нельзя/.test(am));
  ok('CLAUDE.md содержит @AGENTS.md', /^\s*@AGENTS\.md\s*$/m.test(cm));
  for (const sk of ['cross-check', 'end-session', 'new-workspace', 'doctor']) {
    ok('навык ' + sk + ' лежит в .claude/skills и .agents/skills одинаково', H.exists(path.join(ROOT, '.claude', 'skills', sk, 'SKILL.md')) && H.exists(path.join(ROOT, '.agents', 'skills', sk, 'SKILL.md')) && H.read(path.join(ROOT, '.claude', 'skills', sk, 'SKILL.md')) === H.read(path.join(ROOT, '.agents', 'skills', sk, 'SKILL.md')));
  }
  r = wp(['verify', 'P1.main', 'P1.reviewer', 'P2.core', 'P2.hooks', 'P3.hooks-test']);
  ok('verify: основной, проверяющий, раскладка, сторожа, проба сторожей — всё ок', r.code === 0, r.all);

  // ---- 5. самопроверка проверяющего: GREEN на верной копии, RED на ошибочной
  S.section(tag + ': самопроверка проверяющего ' + reviewer);
  H.rmTree(LOG);
  r = H.node(path.join(ROOT, '.workplace', 'core', 'skills', 'cross-check', 'scripts', 'selftest-run.js'), ['--timeout', '90'], { cwd: ROOT, env: envFull(), timeout: 300000 });
  ok('selftest-run: код 0', r.code === 0, r.all);
  const checksDir = path.join(ROOT, 'checks');
  const ms = (H.exists(checksDir) ? require('fs').readdirSync(checksDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => H.readJson(path.join(checksDir, d.name, 'manifest.json'))) : []);
  const good = ms.find((m) => m.label === 'selftest-good'), bad = ms.find((m) => m.label === 'selftest-bad');
  ok('верная копия принята: GREEN или YELLOW, проверяет ' + reviewer, good && good.status === 'checked' && ['GREEN', 'YELLOW'].includes(good.verdict) && good.reviewer === reviewer, good && JSON.stringify([good.status, good.verdict, good.reviewer]));
  ok('копия с вшитой ошибкой принята как RED, проверяет ' + reviewer, bad && bad.status === 'checked' && bad.verdict === 'RED' && bad.reviewer === reviewer, bad && JSON.stringify([bad.status, bad.verdict, bad.reviewer]));
  const calls = H.exists(LOG) ? H.read(LOG).split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.argv.some((a) => ['exec', '-p'].includes(a))) : [];
  ok('проверяющий вызван дважды и только ' + reviewer + ' (основной ' + main + ' как проверяющий не вызывался)', calls.length === 2 && calls.every((c) => c.provider === reviewer), JSON.stringify(calls.map((c) => c.provider)));
  ok('проверяющий запущен в режиме «только чтение»' + (reviewer === 'codex' ? ' (--sandbox read-only)' : ' (--tools Read,Grep,Glob, dontAsk)'), calls.length > 0 && calls.every((c) => (reviewer === 'codex' ? c.argv.includes('read-only') : c.argv.includes('Read,Grep,Glob') && c.argv.includes('dontAsk'))), JSON.stringify(calls[0]));
  r = wp(['verify', 'P3.selftest']);
  ok('verify P3.selftest зелёный (в цепочке проверяет ' + reviewer + ')', r.code === 0 && new RegExp(LABEL[reviewer]).test(r.out), r.all);
  // направление сменилось: самопроверка другого проверяющего не доказывает ничего про нового
  r = wp(['config', 'set', 'main', reviewer]);
  const flipped = wp(['verify', 'P3.selftest']);
  ok('после смены направления самопроверка прежнего проверяющего не засчитывается (код 1)', r.code === 0 && flipped.code === 1 && /другим проверяющим|нет принятых/.test(flipped.out), flipped.all);
  r = wp(['config', 'set', 'main', main]);
  ok('направление возвращено, самопроверка снова зелёная', r.code === 0 && wp(['verify', 'P3.selftest']).code === 0);

  // ---- 6. отчёт: без личных данных, с контактом
  S.section(tag + ': отчёт');
  r = wp(['report']);
  const repFile = path.join(ROOT, 'install-report.md');
  ok('report: код 0, install-report.md создан', r.code === 0 && H.exists(repFile), r.all);
  const rep = H.exists(repFile) ? H.read(repFile) : '';
  const realUser = require('os').userInfo().username;
  ok('в отчёте контакт ' + CONTACT, rep.includes(CONTACT) && rep.trim().endsWith(CONTACT));
  ok('в отчёте названо направление: основной ' + LABEL[main] + ', проверяет ' + LABEL[reviewer], rep.includes('основной ' + LABEL[main] + ', проверяет ' + LABEL[reviewer]), rep.split('\n').slice(0, 4).join(' | '));
  ok('в отчёте названа разведка этого случая', rep.includes('Случай при разведке: ') && rep.includes(require('../../core/lib/recon').CASE_TITLE[caseId]), '');
  const problems = require('../../core/lib/mask').reportProblems(rep);
  ok('в отчёте нет почт, токенов, телефонов и путей с именем пользователя (reportProblems пуст)', problems.length === 0, problems.join('; '));
  ok('в отчёте нет почты, пути /Users/<имя>, имени пользователя системы и фейковой домашней папки', !/[\w.+-]+@[\w-]+\.[\w.-]+/.test(rep.replace(/https:\/\/t\.me\/\w+/g, '')) && !/(\/Users\/|\\Users\\|\/home\/)[^\s/\\~*]/.test(rep) && !new RegExp('\\b' + realUser.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(rep) && !rep.includes(HOME), rep.split('\n').filter((l) => l.includes(HOME) || l.toLowerCase().includes(realUser.toLowerCase())).slice(0, 3).join('\n'));

  // ---- 7. ничего вне главной папки не тронуто
  const homeEnd = H.treeMap(HOME, ['workplace']);
  ok('вся домашняя папка кроме главной папки байт-в-байт та же после полного прогона', H.mapDiffText(homeBefore, homeEnd) === 'изменено: ; добавлено: ; убрано: ', H.mapDiffText(homeBefore, homeEnd));
} catch (e) {
  ok('прогон дошёл до конца без исключения', false, e && e.stack);
} finally {
  H.rmTree(TMP);
}
process.exit(S.finish());
