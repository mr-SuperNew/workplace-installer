#!/usr/bin/env node
'use strict';
// Правки по проверке этапа Г (build/reports/D-review.md): у каждой находки свой тест, который краснеет, если правку вернуть назад (tests/negative/run.js держит мутации).
//   H1  ложный GREEN самопроверки: вердикт без запуска проверяющего (run.json) не принимается и finalize-check, и verify P3.selftest
//   H3  основной Codex + проверяющий Claude: .codex/config.toml с сетью, быстрый ответ «нет сети», документы не обещают несуществующего
//   H4  update не затирает правки человека: не тронут / изменён человеком / удалён человеком
//   M1  разведка не пишет (codex --version не создаёт ~/.codex/tmp)
//   M2  Mac без Homebrew: .pkg не основной путь (с этапа Ж путь Mac по версии macOS: набор unit/fixes-g)
//   M3  verify all не включает P5.report
//   M4  config.toml Codex: доверие папкам и хукам это вопрос (C), не тревога (A)
//   M5  path-fix: строка PATH в профиль только по «да», с объявлением и копией
//   L3  init не молчит о неснятом снимке; L4 npm-путь Claude требует Node 22
// Всё на заглушках, в фейковом HOME во временных папках; настоящие ~/.claude и ~/.codex не трогаются.
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const H = require('../../lib/harness');
const stubsLib = require('../../lib/stubs');

const S = new H.Suite('unit/fixes');
const ok = (n, c, d) => S.ok(n, c, d);
const TMP = H.mkTmp('wp-fixes-');
const HOME = path.join(TMP, 'home');
fs.mkdirSync(HOME, { recursive: true });
const BIN = stubsLib.prepare(path.join(TMP, 'bin'), ['codex', 'claude', 'python', 'python3']);
const LOG = path.join(TMP, 'stub.log');
const ENV = H.sandboxEnv(HOME, { path: H.minPath([BIN]), extra: { STUB_LOG: LOG } });
process.env.WP_HOME = HOME;                 // ядро, подключённое в этом процессе, читает фейковую домашнюю папку
const core = (m) => require(path.join(H.KIT, 'core', 'lib', m));
const wpPkg = (args, o) => H.node(H.WP_SRC, args, Object.assign({ cwd: TMP, env: ENV }, o || {}));
const wpIn = (root, args, o) => H.node(path.join(root, '.workplace', 'core', 'cli', 'wp.js'), args, Object.assign({ cwd: root, env: ENV }, o || {}));
const script = (root, name, args, o) => H.node(path.join(root, '.workplace', 'core', 'skills', 'cross-check', 'scripts', name), args || [], Object.assign({ cwd: root, env: ENV }, o || {}));
const readJson = H.readJson;
const text = (p) => fs.readFileSync(p, 'utf8');
function makeRoot(name, main, o) {
  const root = path.join(HOME, name);
  let r = H.node(H.WP_SRC, ['init', '--root', root, '--main', main, '--no-scan'], { cwd: TMP, env: (o && o.env) || ENV });
  if (r.code !== 0) throw new Error('init ' + name + ': ' + r.all);
  if (!o || o.layout !== false) { r = wpIn(root, ['layout']); if (r.code !== 0) throw new Error('layout ' + name + ': ' + r.all); }
  return root;
}
const dirOf = (out) => (out.match(/Папка проверки:\s*(checks\/\S+)/) || [])[1];
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

(async () => {
  try {
    // ====================================================================== H1
    S.section('H1) самопроверка: вердикт, написанный руками, не принимается');
    {
      const root = makeRoot('root-h1', 'claude');
      let r = script(root, 'selftest-setup.js');
      const prep = (name) => script(root, 'prepare-check.js', ['--name', name, '--label', name, '--task', 'Посчитать выручку на сотрудника по каждой компании', '--result', 'selftest/result.md', '--sources', 'selftest/input.md', '--must-quote', 'КОНТРОЛЬНАЯ СТРОКА']);
      // настоящая проверка заглушкой: это образец верного вердикта (цитаты настоящие)
      const pa = prep('real-a'); const dA = dirOf(pa.out);
      r = script(root, 'run-check.js', [dA]);
      ok('настоящий запуск проверяющего (заглушка codex): код 0, run.json записан', r.code === 0 && fs.existsSync(path.join(root, dA, 'run.json')), r.all);
      const run = readJson(path.join(root, dA, 'run.json'));
      ok('run.json: проверяющий, код выхода, время начала и конца, хеши prompt.md и verdict.md', run.provider === 'codex' && run.ok === true && run.exit_code === 0 && !!Date.parse(run.started_at) && !!Date.parse(run.finished_at) && /^[0-9a-f]{64}$/.test(run.verdict_sha256) && /^[0-9a-f]{64}$/.test(run.prompt_sha256) && run.check_id === path.basename(dA), JSON.stringify(run));
      const verdictA = text(path.join(root, dA, 'verdict.md'));
      r = script(root, 'finalize-check.js', [dA]);
      ok('контроль: настоящий запуск принят (код 0, ВЕРДИКТ GREEN), в манифесте отметка finalize', r.code === 0 && /GREEN/.test(r.out) && !!readJson(path.join(root, dA, 'manifest.json')).run_proof, r.all);

      // подделка 1: проверка подготовлена, проверяющий НЕ запускался, verdict.md с настоящими цитатами положен руками
      const pb = prep('forged-b'); const dB = dirOf(pb.out);
      fs.writeFileSync(path.join(root, dB, 'verdict.md'), verdictA);
      r = script(root, 'finalize-check.js', [dB]);
      ok('H1: рукописный verdict.md с верными цитатами БЕЗ run.json: не принят (код 3, НЕ ПРОВЕРЕНО, причина про run.json)', r.code === 3 && /НЕ ПРОВЕРЕНО/.test(r.out) && /нет доказательства запуска проверяющего/.test(r.out) && /run\.json/.test(r.out), r.all);
      ok('H1: манифест подделки остался not_checked, отметки finalize нет', readJson(path.join(root, dB, 'manifest.json')).status === 'not_checked' && !readJson(path.join(root, dB, 'manifest.json')).run_proof);

      // подделка 2: настоящий запуск, потом verdict.md подменён (GREEN вместо честного ответа)
      const pc = prep('tamper-c'); const dC = dirOf(pc.out);
      r = script(root, 'run-check.js', [dC], { env: Object.assign({}, ENV, { STUB_MODE: 'lazy' }) });
      fs.writeFileSync(path.join(root, dC, 'verdict.md'), verdictA + '\nправка рукой после запуска\n');
      r = script(root, 'finalize-check.js', [dC]);
      ok('H1: verdict.md изменён после запуска проверяющего: не принят, причина «хеш не совпал»', r.code === 3 && /хеш не совпал/.test(r.out), r.all);

      // подделка 3: run.json от другого проверяющего (config: проверяет codex)
      const pd = prep('other-d'); const dD = dirOf(pd.out);
      script(root, 'run-check.js', [dD]);
      const rjD = readJson(path.join(root, dD, 'run.json')); rjD.provider = 'claude'; rjD.reviewer = 'claude';
      fs.writeFileSync(path.join(root, dD, 'run.json'), JSON.stringify(rjD));
      r = script(root, 'finalize-check.js', [dD]);
      ok('H1: run.json называет другого проверяющего, чем config.json: не принят', r.code === 3 && /проверял claude/.test(r.out), r.all);

      // подделка 4: проверяющий упал (лимит), потом verdict.md написан рукой
      const pe = prep('quota-e'); const dE = dirOf(pe.out);
      r = script(root, 'run-check.js', [dE], { env: Object.assign({}, ENV, { STUB_MODE: 'quota' }) });
      fs.writeFileSync(path.join(root, dE, 'verdict.md'), verdictA);
      r = script(root, 'finalize-check.js', [dE]);
      ok('H1: проверяющий упёрся в лимит (run.json ok: false), вердикт дописан руками: не принят', r.code === 3 && /нет доказательства/.test(r.out) && /не закончился успехом/.test(r.out), r.all);

      // verify P3.selftest: подложенная пара вердиктов красная, настоящая зелёная
      const forgedRoot = makeRoot('root-h1-forged', 'claude');
      script(forgedRoot, 'selftest-setup.js');
      for (const [label, file] of [['selftest-good', 'selftest/result.md'], ['selftest-bad', 'selftest/result-with-error.md']]) {
        const p = script(forgedRoot, 'prepare-check.js', ['--name', label, '--label', label, '--task', 'x', '--result', file, '--sources', 'selftest/input.md', '--must-quote', 'КОНТРОЛЬНАЯ СТРОКА']);
        const d = dirOf(p.out);
        const v = label === 'selftest-good' ? verdictA : verdictA.replace('ВЕРДИКТ: GREEN', 'ВЕРДИКТ: RED').replace(/Находки:.*/, 'Находки: 1. Блокирующая: Бета 4,0 вместо 2,0');
        fs.writeFileSync(path.join(forgedRoot, d, 'verdict.md'), v);
        const f = script(forgedRoot, 'finalize-check.js', [d, ...(label === 'selftest-bad' ? ['--expect-mention', 'Бета|4,0', '--expect-verdict', 'RED'] : [])]);
        ok('подложенный verdict (' + label + ') finalize-check не принимает', f.code === 3, f.all);
        // и «принятый» вручную манифест (status: checked) тоже не открывает самопроверку
        const mf = path.join(forgedRoot, d, 'manifest.json'); const m = readJson(mf); m.status = 'checked'; m.verdict = label === 'selftest-good' ? 'GREEN' : 'RED'; fs.writeFileSync(mf, JSON.stringify(m, null, 2));
      }
      r = wpIn(forgedRoot, ['verify', 'P3.selftest']);
      ok('H1: подложенные verdict и вручную проставленный status: checked: verify P3.selftest КРАСНЫЙ (код 1)', r.code === 1 && /нет доказательства/.test(r.out), r.all);
      const realRoot = makeRoot('root-h1-real', 'claude');
      r = script(realRoot, 'selftest-run.js', ['--timeout', '60']);
      ok('контроль: настоящая самопроверка на заглушке проходит (код 0)', r.code === 0, r.all);
      r = wpIn(realRoot, ['verify', 'P3.selftest']);
      ok('контроль: verify P3.selftest после настоящей самопроверки зелёный, запуск подтверждён', r.code === 0 && /запуск подтверждён run\.json/.test(r.out), r.all);
      const goodDir = fs.readdirSync(path.join(realRoot, 'checks')).find((d) => d.endsWith('selftest-good'));
      fs.appendFileSync(path.join(realRoot, 'checks', goodDir, 'verdict.md'), 'дописано рукой\n');
      r = wpIn(realRoot, ['verify', 'P3.selftest']);
      ok('H1: verdict.md настоящей проверки правили после приёмки: verify красный', r.code === 1, r.all);
    }

    // ====================================================================== H2 (шаблоны)
    S.section('H2) подключение сторожей: инструменты записи в сопоставителях обоих провайдеров');
    {
      const wiring = core('wiring.js');
      const tp = wiring.templatePaths();
      const ct = wiring.renderTemplate(tp.claude, '/r'), xt = wiring.renderTemplate(tp.codex, '/r');
      const matcherOf = (t, name) => { for (const gs of Object.values(t.hooks)) for (const g of gs) if (g.hooks.some((h) => h.command.includes(name + '.js'))) return g.matcher || ''; return null; };
      for (const g of ['danger-guard', 'cross-check-guard']) ok('Claude: у ' + g + ' в сопоставителе Write, Edit, MultiEdit, NotebookEdit', ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].every((x) => matcherOf(ct, g).split('|').includes(x)), matcherOf(ct, g));
      for (const g of ['danger-guard', 'cross-check-guard']) ok('Codex: у ' + g + ' в сопоставителе apply_patch', matcherOf(xt, g).split('|').includes('apply_patch'), matcherOf(xt, g));
      ok('Claude: у danger-guard по-прежнему Bash и PowerShell', /\bBash\b/.test(matcherOf(ct, 'danger-guard')) && /\bPowerShell\b/.test(matcherOf(ct, 'danger-guard')));
    }

    // ====================================================================== H3
    S.section('H3) основной Codex, проверяющий Claude: сеть в песочнице и честные ответы');
    {
      const cx = makeRoot('root-h3-codex', 'codex');
      const cfgFile = path.join(cx, '.codex', 'config.toml');
      ok('основной Codex: layout пишет .codex/config.toml с [sandbox_workspace_write] и network_access = true', fs.existsSync(cfgFile) && /^\[sandbox_workspace_write\]\s*$/m.test(text(cfgFile)) && /^network_access\s*=\s*true\s*$/m.test(text(cfgFile)), fs.existsSync(cfgFile) ? text(cfgFile) : 'нет файла');
      let r = wpIn(cx, ['verify', 'P2.core']);
      ok('verify P2.core зелёный, когда настройка сети на месте', r.code === 0, r.all);
      r = wpIn(cx, ['layout']);
      ok('layout повторно: «без изменений» для config.toml, файл тот же', /без изменений: \.codex\/config\.toml/.test(r.out) && text(cfgFile).split('network_access').length === 2, r.out);
      const cl = makeRoot('root-h3-claude', 'claude');
      ok('основной Claude: .codex/config.toml не создаётся', !fs.existsSync(path.join(cl, '.codex', 'config.toml')));
      // чужой config.toml без нужной таблицы: блок дописывается, прежнее остаётся
      const c2 = makeRoot('root-h3-own', 'codex', { layout: false });
      H.write(path.join(c2, '.codex', 'config.toml'), 'model = "my-model"\n[features]\nx = true\n');
      r = wpIn(c2, ['layout']);
      const t2 = text(path.join(c2, '.codex', 'config.toml'));
      ok('config.toml без таблицы песочницы: блок дописан, прежние строки целы', /model = "my-model"/.test(t2) && /\[features\]/.test(t2) && /network_access\s*=\s*true/.test(t2) && /дописан: \.codex\/config\.toml/.test(r.out), r.out + t2);
      // таблица есть, но network_access = false: не перезаписываем, verify красный
      const c3 = makeRoot('root-h3-false', 'codex', { layout: false });
      H.write(path.join(c3, '.codex', 'config.toml'), '[sandbox_workspace_write]\nnetwork_access = false\n');
      r = wpIn(c3, ['layout']);
      ok('network_access = false у человека: не перезаписан, ОТЛИЧАЕТСЯ, код 2', /ОТЛИЧАЕТСЯ, не перезаписан: \.codex\/config\.toml/.test(r.out) && /network_access = false/.test(text(path.join(c3, '.codex', 'config.toml'))) && r.code === 2, r.out);
      r = wpIn(c3, ['verify', 'P2.core']);
      ok('и verify P2.core красный: настройки сети нет', r.code === 1 && /network_access/.test(r.out), r.all);

      // быстрый честный ответ «нет сети» (проверяющий Claude)
      const prov = require(path.join(H.KIT, 'core', 'providers', 'claude.js'));
      const outFile = path.join(TMP, 'v.md');
      const saved = { a: process.env.CODEX_SANDBOX_NETWORK_DISABLED, b: process.env.WP_NET_PROBE, c: process.env.WP_NET_PROBE_HOST, d: process.env.WP_NET_PROBE_PORT };
      process.env.CODEX_SANDBOX_NETWORK_DISABLED = '1';
      let rv = await prov.review({ dir: TMP, prompt: 'x', outFile, timeoutMs: 5000 });
      ok('переменная песочницы без сети: сразу kind no-network, подсказка называет config.toml и флаг -c', rv.kind === 'no-network' && !rv.ok && /config\.toml/.test(rv.hint) && /network_access/.test(rv.hint) && /-c sandbox_workspace_write\.network_access=true/.test(rv.hint), rv.hint);
      delete process.env.CODEX_SANDBOX_NETWORK_DISABLED;
      delete process.env.WP_NET_PROBE;
      process.env.WP_NET_PROBE_HOST = '127.0.0.1'; process.env.WP_NET_PROBE_PORT = String(await freePort());
      const t0 = Date.now();
      rv = await prov.review({ dir: TMP, prompt: 'x', outFile, timeoutMs: 5000 });
      ok('сети нет (закрытый порт, как в песочнице без сети): kind no-network за ' + (Date.now() - t0) + ' мс, не за 120 с, причина названа', rv.kind === 'no-network' && Date.now() - t0 < 8000 && /нет соединения/.test(rv.stderrTail), JSON.stringify([rv.kind, rv.stderrTail]));
      for (const k of Object.keys(saved)) { const n = ['CODEX_SANDBOX_NETWORK_DISABLED', 'WP_NET_PROBE', 'WP_NET_PROBE_HOST', 'WP_NET_PROBE_PORT'][Object.keys(saved).indexOf(k)]; if (saved[k] === undefined) delete process.env[n]; else process.env[n] = saved[k]; }
      // через настоящий run-check: основной Codex, проверяет Claude; сеть «закрыта»
      script(cx, 'selftest-setup.js');
      const p = script(cx, 'prepare-check.js', ['--name', 'net', '--task', 'x', '--result', 'selftest/result.md', '--sources', 'selftest/input.md']);
      const closed = await freePort();
      const t1 = Date.now();
      const envNet = Object.assign({}, ENV, { WP_NET_PROBE: '', WP_NET_PROBE_HOST: '127.0.0.1', WP_NET_PROBE_PORT: String(closed) });
      r = await H.nodeAsync(path.join(cx, '.workplace', 'core', 'skills', 'cross-check', 'scripts', 'run-check.js'), [dirOf(p.out)], { cwd: cx, env: envNet });
      ok('run-check (основной Codex, проверяет Claude), сети нет: код 2 быстро, «нет сети» и что включить, а не молчаливое зависание', r.code === 2 && /no-network/.test(text(path.join(cx, dirOf(p.out), 'run.json'))) && /network_access/.test(r.out) && Date.now() - t1 < 20000, r.all);
      ok('в run.json kind no-network, ok false; finalize после этого НЕ ПРОВЕРЕНО', readJson(path.join(cx, dirOf(p.out), 'run.json')).ok === false && script(cx, 'finalize-check.js', [dirOf(p.out)]).code === 3);
      // а когда сеть есть (локальный порт слушает), проверка идёт обычным путём
      const srv = net.createServer(); await new Promise((res) => srv.listen(0, '127.0.0.1', res));
      const envOk = Object.assign({}, ENV, { WP_NET_PROBE: '', WP_NET_PROBE_HOST: '127.0.0.1', WP_NET_PROBE_PORT: String(srv.address().port) });
      const p2 = script(cx, 'prepare-check.js', ['--name', 'net-ok', '--task', 'x', '--result', 'selftest/result.md', '--sources', 'selftest/input.md']);
      r = await H.nodeAsync(path.join(cx, '.workplace', 'core', 'skills', 'cross-check', 'scripts', 'run-check.js'), [dirOf(p2.out)], { cwd: cx, env: envOk });
      srv.close();
      ok('сеть есть (проба соединения прошла): проверяющий Claude запускается, код 0', r.code === 0 && readJson(path.join(cx, dirOf(p2.out), 'run.json')).ok === true, r.all);
      // документы не обещают несуществующего
      const skill = text(path.join(H.KIT, 'core', 'skills', 'cross-check', 'SKILL.md'));
      const trouble = text(path.join(H.KIT, 'docs', 'troubleshooting.md'));
      const install = text(path.join(H.KIT, 'INSTALL.md'));
      const cases = text(path.join(H.KIT, 'docs', 'cases.md'));
      ok('SKILL.md не обещает «вызов Claude идёт в режиме workspace-write с сетью» и называет настоящий механизм (config.toml)', !/вызов Claude идёт в режиме `workspace-write` с сетью/.test(skill) && /config\.toml/.test(skill) && /network_access/.test(skill));
      ok('troubleshooting.md не говорит «так навык и запускает»', !/так навык и запускает/.test(trouble) && /network_access/.test(trouble));
      ok('cases.md: сеть через .codex/config.toml, а не «навык включает»; оба направления рабочие', /config.toml/.test(cases) && /Оба направления рабочие/.test(cases));
      ok('INSTALL.md: оба направления рабочие; по умолчанию Claude-основной, «основным Codex» выбирает человек', /Оба направления работают/.test(install) && /| По умолчанию | Claude Code |/.test(install) && /| «Основным Codex» | Codex |/.test(install));
      ok('INSTALL.md: у Codex-основного одной строкой названо, что сторожа Codex включаются после подтверждения проекта командой /hooks (M7)', /сторожа Codex включаются, когда я один раз подтвержу проект командой `\/hooks`/.test(install));
      // выпуск 1: разведка предлагает основным Claude Code даже при «только Codex»
      const j = JSON.parse(H.node(H.WP_SRC, ['recon', '--json', '--no-scan'], { cwd: TMP, env: H.sandboxEnv(HOME, { path: H.minPath([stubsLib.prepare(path.join(TMP, 'bin-codex-only'), ['codex', 'python', 'python3'])]) }) }).out);
      ok('«только Codex»: предложено направление основной Claude Code, проверяет Codex (выпуск 1)', j.case.id === 'codex-only' && j.case.suggested.main === 'claude' && j.case.suggested.reviewer === 'codex' && /основным можно сделать и Codex/.test(j.case.why.join(' ')) && !/экспериментальн/.test(j.case.why.join(' ')), JSON.stringify(j.case));
    }

    // ====================================================================== H4
    S.section('H4) update: правки человека не затираются (3 сценария)');
    {
      const root = makeRoot('root-h4', 'claude');
      let r = wpIn(root, ['git-init', '--name', 'Test Person', '--email', 'test@example.com']);
      ok('подготовка: git-init главной папки', r.code === 0, r.all);
      const st0 = readJson(path.join(root, '.workplace', 'state.json'));
      ok('init записал хеши установленных файлов пакета в state.json (files)', st0.files && Object.keys(st0.files).length > 50 && /^[0-9a-f]{64}$/.test(st0.files['.workplace/core/hooks/model-guard.js']) && !!st0.files['.workplace/VERSION'] && !!st0.files['.workplace/INSTALL.md'], Object.keys(st0.files || {}).length);
      // новая версия пакета
      const kit2 = path.join(TMP, 'kit2');
      (function cp(src, dst) { fs.mkdirSync(dst, { recursive: true }); for (const it of fs.readdirSync(src, { withFileTypes: true })) { if (['node_modules', '.git', 'release', 'dist', 'tests', 'scripts', '.github'].includes(it.name)) continue; const s = path.join(src, it.name), d = path.join(dst, it.name); if (it.isDirectory()) cp(s, d); else fs.copyFileSync(s, d); } })(H.KIT, kit2);
      fs.writeFileSync(path.join(kit2, 'VERSION'), '4.0.1-test\n');
      const reminder = path.join('core', 'hooks', 'feedback-reminder.js'), modelGuard = path.join('core', 'hooks', 'model-guard.js'), casesDoc = path.join('docs', 'cases.md');
      for (const f of [reminder, modelGuard]) fs.appendFileSync(path.join(kit2, f), '\n// обновлено в 4.0.1-test\n');
      fs.appendFileSync(path.join(kit2, casesDoc), '\nДобавлено в 4.0.1-test.\n');
      fs.writeFileSync(path.join(kit2, 'docs', 'new-doc.md'), '# новый документ\n');
      const wp2 = (args) => H.node(path.join(kit2, 'core', 'cli', 'wp.js'), args, { cwd: TMP, env: ENV });
      // действия человека: правит model-guard.js, удаляет cases.md; feedback-reminder.js не трогает; удаляет файл навыка
      const REL = (f) => '.workplace/' + f.replace(/\\/g, '/');
      const humanEdit = '\n// моя правка в хуке\n';
      fs.appendFileSync(path.join(root, REL(modelGuard)), humanEdit);
      fs.rmSync(path.join(root, REL(casesDoc)));
      fs.rmSync(path.join(root, '.claude', 'skills', 'new-workspace', 'SKILL.md'));
      const humanSha = H.sha(path.join(root, REL(modelGuard)));
      const treeBefore = H.treeHash(root);
      r = wp2(['update', 'plan', '--root', root]);
      ok('plan: не тронутый файл (feedback-reminder.js) попадает в «обновится»', /обновится: \.workplace\/core\/hooks\/feedback-reminder\.js/.test(r.out), r.all);
      ok('plan: изменённый человеком (model-guard.js) = «ОТЛИЧАЕТСЯ, не трогаю без твоего «да»», с подсказкой --overwrite', /ОТЛИЧАЕТСЯ, не трогаю без твоего «да» \(apply с --overwrite \.workplace\/core\/hooks\/model-guard\.js\): \.workplace\/core\/hooks\/model-guard\.js/.test(r.out) && !/обновится: \.workplace\/core\/hooks\/model-guard\.js/.test(r.out), r.all);
      ok('plan: удалённый человеком (docs/cases.md) = «УДАЛЁН тобой, не восстанавливаю без твоего «да»»', /УДАЛЁН тобой, не восстанавливаю без твоего «да» \(apply с --overwrite \.workplace\/docs\/cases\.md\)/.test(r.out) && !/новый: \.workplace\/docs\/cases\.md/.test(r.out), r.all);
      ok('plan: удалённый человеком файл навыка тоже «УДАЛЁН»', /УДАЛЁН тобой.*\.claude\/skills\/new-workspace\/SKILL\.md/.test(r.out), r.all);
      ok('plan: новый файл новой версии (docs/new-doc.md) = «новый»', /новый: \.workplace\/docs\/new-doc\.md/.test(r.out), r.all);
      ok('plan: счётчики в итоговой строке (ОТЛИЧАЕТСЯ 1, УДАЛЕНО тобой ≥ 2)', /ОТЛИЧАЕТСЯ \(ты правил сам\) 1, УДАЛЕНО тобой [2-9]/.test(r.out), r.out.split('\n').find((l) => /Файлов пакета/.test(l)));
      ok('plan ничего не записал: дерево главной папки то же (хеш с .git)', H.treeHash(root) === treeBefore);
      r = wp2(['update', 'apply', '--root', root]);
      ok('apply без --yes: отказ (код 2), ничего не изменено', r.code === 2 && H.treeHash(root) === treeBefore, r.all);
      r = wp2(['update', 'apply', '--root', root, '--overwrite', '.workplace/core/hooks/not-there.js', '--yes']);
      ok('apply --overwrite несуществующего пути: отказ (код 2), ничего не изменено', r.code === 2 && /Ничего не сделано/.test(r.all) && H.treeHash(root) === treeBefore, r.all);
      const commitsBefore = Number(H.git(root, ['rev-list', '--count', 'HEAD']).out.trim());
      // «да» человека приходит только его сообщением (хук главной папки); флаг --yes сам его не заменяет (проверки отказов: unit/n-flow)
      H.humanSays(root, 'Обнови установщик до 4.0.1-test', ENV); H.humanSays(root, 'да', ENV);
      r = wp2(['update', 'apply', '--root', root, '--yes']);
      ok('apply --yes: код 0', r.code === 0, r.all);
      ok('не тронутый человеком файл обновлён (совпал с новым пакетом), копия прежнего в backup-update', H.sha(path.join(root, REL(reminder))) === H.sha(path.join(kit2, reminder)) && fs.readdirSync(path.join(root, '.workplace', 'backup-update')).some((d) => fs.existsSync(path.join(root, '.workplace', 'backup-update', d, REL(reminder)))), r.out);
      ok('файл, изменённый человеком, НЕ затёрт (хеш тот же, правка на месте)', H.sha(path.join(root, REL(modelGuard))) === humanSha && text(path.join(root, REL(modelGuard))).includes('моя правка в хуке'), r.out);
      ok('файл, удалённый человеком, НЕ восстановлен (cases.md и файл навыка)', !fs.existsSync(path.join(root, REL(casesDoc))) && !fs.existsSync(path.join(root, '.claude', 'skills', 'new-workspace', 'SKILL.md')), r.out);
      ok('новый файл создан', fs.existsSync(path.join(root, '.workplace', 'docs', 'new-doc.md')));
      ok('версия пакета обновлена', text(path.join(root, '.workplace', 'VERSION')).trim() === '4.0.1-test' && readJson(path.join(root, '.workplace', 'state.json')).kit_version === '4.0.1-test');
      const st1 = readJson(path.join(root, '.workplace', 'state.json'));
      ok('state.json: хеш обновлённого файла новый, хеш файла с правкой человека остался прежним (он по-прежнему «отличается»)', st1.files[REL(reminder)] === H.sha(path.join(kit2, reminder)) && st1.files[REL(modelGuard)] === st0.files[REL(modelGuard)], '');
      ok('в state.json записано, что не тронуто: custom_kept и deleted_kept', st1.updates[0].custom_kept.includes('.workplace/core/hooks/model-guard.js') && st1.updates[0].deleted_kept.includes('.workplace/docs/cases.md'), JSON.stringify(st1.updates[0]));
      const files = H.git(root, ['show', '--name-only', '--format=', 'HEAD']).out.split(/\r?\n/).filter(Boolean);
      ok('git: создан один коммит обновления (без push), в нём только записанные файлы: нет model-guard.js, cases.md, state.json', Number(H.git(root, ['rev-list', '--count', 'HEAD']).out.trim()) === commitsBefore + 1 && files.includes('.workplace/core/hooks/feedback-reminder.js') && !files.includes('.workplace/core/hooks/model-guard.js') && !files.includes('.workplace/docs/cases.md') && !files.some((f) => /state\.json|backup-update/.test(f)), files.join(', '));
      // повторный запуск: нечего менять, правка человека и удаление по-прежнему ждут слова
      r = wp2(['update', 'plan', '--root', root]);
      ok('повторный plan: правка человека всё ещё «ОТЛИЧАЕТСЯ», удалённое всё ещё «УДАЛЁН», обновлённое «без изменений»', /ОТЛИЧАЕТСЯ, не трогаю[^\n]*model-guard\.js/.test(r.out) && /УДАЛЁН тобой[^\n]*cases\.md/.test(r.out) && !/обновится: \.workplace\/core\/hooks\/feedback-reminder\.js/.test(r.out), r.all);
      const tree2 = H.treeHash(root);
      r = wp2(['update', 'apply', '--root', root, '--yes']);
      ok('повторный apply --yes без изменений: правка человека цела, коммита не прибавилось', r.code === 0 && text(path.join(root, REL(modelGuard))).includes('моя правка в хуке') && Number(H.git(root, ['rev-list', '--count', 'HEAD']).out.trim()) === commitsBefore + 1, r.all);
      void tree2;
      // слово человека: --overwrite обоих файлов
      H.humanSays(root, 'да, обнови и замени model-guard.js, верни docs/cases.md', ENV);
      r = wp2(['update', 'apply', '--root', root, '--yes', '--overwrite', '.workplace/core/hooks/model-guard.js,.workplace/docs/cases.md']);
      ok('apply --yes --overwrite путь,путь (после «да» человека): файл с правкой заменён новым, удалённый восстановлен', r.code === 0 && H.sha(path.join(root, REL(modelGuard))) === H.sha(path.join(kit2, modelGuard)) && H.sha(path.join(root, REL(casesDoc))) === H.sha(path.join(kit2, casesDoc)), r.all);
      ok('копия правки человека сохранена в backup-update', fs.readdirSync(path.join(root, '.workplace', 'backup-update')).some((d) => { const f = path.join(root, '.workplace', 'backup-update', d, REL(modelGuard)); return fs.existsSync(f) && text(f).includes('моя правка в хуке'); }));
      r = wp2(['update', 'plan', '--root', root]);
      ok('после слова человека plan: ОТЛИЧАЕТСЯ 0, из удалённого остался только файл навыка, который не называли', /ОТЛИЧАЕТСЯ \(ты правил сам\) 0, УДАЛЕНО тобой 1/.test(r.out) && /УДАЛЁН тобой[^\n]*new-workspace\/SKILL\.md/.test(r.out), r.all);
      // старая установка без записи хешей
      const legacy = makeRoot('root-h4-legacy', 'claude');
      const lf = path.join(legacy, '.workplace', 'state.json'); const ls = readJson(lf); delete ls.files; fs.writeFileSync(lf, JSON.stringify(ls, null, 2));
      r = wp2(['update', 'plan', '--root', legacy]);
      ok('старая установка без files: plan не падает, честно говорит, что правки отличить нельзя', r.code === 0 && /нет записи хешей/.test(r.out), r.all);
    }

    // ====================================================================== M1
    S.section('M1) разведка не пишет: codex --version не создаёт ~/.codex/tmp');
    {
      const home2 = path.join(TMP, 'home-m1');
      H.write(path.join(home2, '.codex', 'config.toml'), 'model = "x"\n');
      H.write(path.join(home2, '.claude', 'settings.json'), '{}\n');
      const env2 = H.sandboxEnv(home2, { path: H.minPath([BIN]), extra: { STUB_CODEX_WRITES: '1' } });
      // контроль: без подмены CODEX_HOME заглушка (как настоящий Codex) писала бы в ~/.codex/tmp
      const ctrl = H.run(path.join(BIN, process.platform === 'win32' ? 'codex.cmd' : 'codex'), ['--version'], { env: env2 });
      ok('контроль: заглушка при существующем ~/.codex создаёт tmp/arg0-* (так ведёт себя настоящий Codex)', fs.existsSync(path.join(home2, '.codex', 'tmp', 'arg0-stub', '.lock')), ctrl.all);
      fs.rmSync(path.join(home2, '.codex', 'tmp'), { recursive: true, force: true });
      const before = H.treeMap(home2);
      const tmpBefore = fs.readdirSync(os.tmpdir()).filter((n) => /^wp-probe-/.test(n)).length;
      const r1 = H.node(H.WP_SRC, ['recon', '--json', '--no-scan'], { cwd: TMP, env: env2 });
      const r2 = H.node(H.WP_SRC, ['plan', '--json'], { cwd: TMP, env: env2 });
      const rj = JSON.parse(r1.out);
      ok('recon на заглушке, которая пишет в $CODEX_HOME/tmp: хеш фейковой домашней папки не изменился', H.mapDiffText(before, H.treeMap(home2)) === 'изменено: ; добавлено: ; убрано: ', H.mapDiffText(before, H.treeMap(home2)));
      ok('версия Codex при этом определена (предупреждение в stderr не мешает)', rj.codex.console && rj.codex.primary.version === '0.0.0-stub' && r2.code === 0, JSON.stringify(rj.codex.primary));
      ok('временная папка пробы не осталась в temp', fs.readdirSync(os.tmpdir()).filter((n) => /^wp-probe-/.test(n)).length === tmpBefore);
      const u = core('util.js');
      const v = u.versionOf(path.join(BIN, process.platform === 'win32' ? 'codex.cmd' : 'codex'));
      ok('util.versionOf(codex) в этом процессе (WP_HOME = фейковая папка): версия есть', v.ok && v.version === '0.0.0-stub', JSON.stringify(v));
    }

    // ====================================================================== M2
    S.section('M2, L1) Mac без Homebrew: .pkg не основной путь, «zsh -ilc» нигде не предлагается (путь Mac по версии macOS и процессору: набор unit/fixes-g, N1 и N3)');
    {
      const plan = core('plan.js');
      const mkR = (platform, mgrs, pyVersion) => ({ os: { platform }, tools: { managers: mgrs, node: { copies: [], ok: false, running: { version: 'v18.0.0' } }, python: { version: pyVersion || null, stubs: [] }, git: null }, case: { id: 'empty' } });
      const steps = plan.systemSteps(mkR('darwin', []), {});
      const node = steps.find((s) => s.stage === 'P1.node'), py = steps.find((s) => s.stage === 'P1.python');
      ok('Mac без Homebrew (версия и процессор не определены): Node архивом без пароля, Homebrew (brew.sh) не ставится', node.commands.length === 1 && node.commands[0].script === true && !node.needsPassword && !node.commands.some((c) => /brew/.test(c.display)), JSON.stringify(node.commands));
      ok('Mac без Homebrew: .pkg не в основных командах, только запасной путь с объяснением', !node.commands.some((c) => /\.pkg/.test(c.display)) && /Запасной путь/.test(node.fallback) && /\.pkg/.test(node.fallback), JSON.stringify(node));
      ok('Mac без Homebrew: Python не ставится установщиком .pkg: Command Line Tools, запасной путь python.org', py.commands[0].display === 'xcode-select --install' && !py.commands.some((c) => /\.pkg/.test(c.display)), JSON.stringify(py.commands));
      const withBrew = plan.systemSteps(mkR('darwin', [{ name: 'brew', path: '/opt/homebrew/bin/brew' }]), {});
      ok('Mac с Homebrew, но версия macOS неизвестна: поддержку Homebrew подтвердить нельзя, поэтому архив, а не brew', !withBrew.find((s) => s.stage === 'P1.node').commands.some((c) => /^brew /.test(c.display)));
      const win = plan.systemSteps(mkR('win32', []), {});
      ok('Windows без изменений: winget для Node и Python', /winget install -e --id OpenJS\.NodeJS\.LTS/.test(win.find((s) => s.stage === 'P1.node').commands[0].display) && /Python\.Python\.3\.13/.test(win.find((s) => s.stage === 'P1.python').commands[0].display));
      const rendered = plan.render({ case: { id: 'empty' }, direction: { main: 'claude', reviewer: 'codex' }, steps, questions: [], profile_notice: null, npm_note: '' });
      ok('в тексте плана для человека нет «zsh -ilc» (оболочка с его профилями) и .pkg назван только запасным путём', !/zsh -ilc/.test(rendered) && !/`bash [^`]*\.pkg[^`]*`/.test(rendered) && /Запасной путь[^\]]*\.pkg/.test(rendered), rendered);
      ok('docs и INSTALL.md: «zsh -ilc» нигде не предлагается (L1)', ['INSTALL.md', 'docs/recon-without-node.md', 'docs/install-steps/mac.md', 'docs/troubleshooting.md'].every((f) => !/(предлагается|проверяется|или) `?zsh -ilc 'command -v/.test(text(path.join(H.KIT, f)))), '');
    }

    // ====================================================================== M3
    S.section('M3) verify all не включает P5.report (шаг отчёта не начинается с красного)');
    {
      const root = makeRoot('root-m3', 'claude');
      let r = wpIn(root, ['verify', 'all']);
      ok('verify all: строки P5.report нет, есть пояснение, где его проверить', !/\] P5\.report:/.test(r.out) && /P5\.report в all не входит/.test(r.out), r.all);
      r = wpIn(root, ['verify', 'P5.report']);
      ok('verify P5.report до отчёта: красный (отчёта ещё нет)', r.code === 1 && /\[НЕТ\] P5\.report/.test(r.out), r.all);
      wpIn(root, ['report']);
      r = wpIn(root, ['verify', 'P5.report']);
      ok('verify P5.report после report: ок', r.code === 0 && /\[ok\] P5\.report/.test(r.out), r.all);
      const inst = text(path.join(H.KIT, 'INSTALL.md'));
      ok('INSTALL.md, шаг 11: report --live идёт до verify P5.report, а verify all не проверяет отчёт', inst.indexOf('report --live') > 0 && inst.indexOf('verify P5.report') > inst.indexOf('report --live'));
    }

    // ====================================================================== M4
    S.section('M4) config.toml Codex: доверие папкам и хукам = вопрос (C), не тревога (A)');
    {
      const snap = core('snapshot.js');
      const cfg = path.join(HOME, '.codex', 'config.toml');
      const base = 'model = "gpt-5"\n\n[features]\nhooks = true\n\n[plugins."a@b"]\nenabled = true\n';
      H.write(cfg, base);
      const sBefore = snap.scan(null);
      const trust = base + "\n[projects.'C:\\work\\main']\ntrust_level = \"trusted\"\n\n[hooks.state.'C:\\work\\main\\.codex\\hooks.json:pre_tool_use:0:0']\ntrusted_hash = \"sha256:abc\"\n";
      H.write(cfg, trust);
      let d = snap.diff(sBefore, snap.scan(null), { declared: [], installs: 0 });
      ok('Codex дописал доверие папке и хуку: класс C, тревоги нет, значения и пути не показаны', !d.alarm && d.classes.C.length === 1 && d.classes.A.length === 0 && /projects\.\*: 1, hooks\.state\.\*: 1/.test(d.classes.C[0].note) && !/work/.test(d.classes.C[0].note) && !/abc/.test(d.classes.C[0].note), JSON.stringify(d.classes));
      H.write(cfg, trust + '\n[mcp_servers.unknown]\ncommand = "node"\n');
      d = snap.diff(sBefore, snap.scan(null), { declared: [], installs: 0 });
      ok('рядом дописан чужой раздел ([mcp_servers.unknown]): по нему тревога A, доверие остаётся вопросом C', d.alarm && d.classes.A.length === 1 && /mcp_servers\.unknown/.test(d.classes.A[0].note) && d.classes.C.length === 1, JSON.stringify(d.classes));
      H.write(cfg, base.replace('model = "gpt-5"', 'model = "gpt-6"'));
      d = snap.diff(sBefore, snap.scan(null), { declared: [], installs: 0 });
      ok('изменён ключ верхнего уровня (model): тревога A, названо «верхний уровень»', d.alarm && /верхний уровень/.test(d.classes.A[0].note), JSON.stringify(d.classes));
      H.write(cfg, base + "\n[projects.'x']\ntrust_level = \"trusted\"\n");
      d = snap.diff(sBefore, snap.scan(null), { declared: [cfg.replace(HOME.replace(/\\/g, '/'), '~').replace(/\\/g, '/')], installs: 0 });
      ok('config.toml объявлен заранее: класс D, как раньше', !d.alarm, JSON.stringify(d.classes));
      fs.rmSync(path.join(HOME, '.codex'), { recursive: true, force: true });
      ok('tomlSections: заголовки с путями Windows и кавычками разбираются, комментарии не считаются', Object.keys(snap.tomlSections("# c\nmodel = 'x'\n[projects.'C:\\a\\b']\ntrust_level = 't'\n[[arr]]\nk = 1\n")).sort().join('|') === "|arr|projects.'C:\\a\\b'");
    }

    // ====================================================================== M5
    S.section('M5) path-fix: строка PATH в профиль только по «да», с копией и объявлением');
    {
      const inst = core('install.js');
      const home = '/home/user';
      const p1 = inst.pathFixPlan({ shell: '/bin/zsh', home, platform: 'darwin', dirs: [home + '/.local/bin', '/usr/local/bin', home + '/.local/bin'] });
      ok('zsh на Mac: профиль ~/.zshrc, одна строка PATH, системная папка не правится, дубли схлопнуты', p1.profile === '.zshrc' && p1.lines.length === 1 && p1.lines[0] === 'export PATH="$HOME/.local/bin:$PATH"', JSON.stringify(p1));
      ok('bash на Mac: ~/.bash_profile; bash на Linux: ~/.bashrc; другая оболочка: ~/.profile', inst.pathFixPlan({ shell: '/bin/bash', home, platform: 'darwin', dirs: [] }).profile === '.bash_profile' && inst.pathFixPlan({ shell: '/bin/bash', home, platform: 'linux', dirs: [] }).profile === '.bashrc' && inst.pathFixPlan({ shell: '/usr/bin/fish', home, platform: 'linux', dirs: [] }).profile === '.profile');
      ok('Windows: профили не правятся, понятный отказ', /Windows/.test(inst.pathFixPlan({ shell: '', home: 'C:/Users/user', platform: 'win32', dirs: [] }).error));
      ok('папка npm-global в домашней: строка с $HOME', inst.pathFixPlan({ shell: '/bin/zsh', home, platform: 'darwin', dirs: [home + '/.npm-global/bin'] }).lines[0] === 'export PATH="$HOME/.npm-global/bin:$PATH"');
      const root = makeRoot('root-m5', 'claude');
      if (process.platform === 'win32') {
        const r = wpIn(root, ['path-fix', '--yes']);
        ok('Windows: path-fix отказывается (код 3), ничего не записано', r.code === 3 && /Windows/.test(r.all), r.all);
        console.log('  (запись в профиль проверяется на Mac и Linux в CI: на Windows профилей оболочки нет)');
      } else {
        const bin = path.join(HOME, '.local', 'bin'); fs.mkdirSync(bin, { recursive: true });
        for (const n of ['claude']) fs.copyFileSync(path.join(BIN, n), path.join(bin, n));
        fs.copyFileSync(path.join(BIN, 'stub.js'), path.join(bin, 'stub.js')); fs.chmodSync(path.join(bin, 'claude'), 0o755);
        const envZ = Object.assign({}, ENV, { SHELL: '/bin/zsh', PATH: H.minPath([path.join(TMP, 'bin-no-claude')]) });
        fs.mkdirSync(path.join(TMP, 'bin-no-claude'), { recursive: true });
        const zshrc = path.join(HOME, '.zshrc'); H.write(zshrc, '# мой zshrc\nexport EDITOR=vim\n');
        const before = H.sha(zshrc);
        let r = wpIn(root, ['path-fix', '--dry-run'], { env: envZ });
        ok('path-fix --dry-run: показывает строку и профиль, профиль не изменён', r.code === 0 && /\.zshrc/.test(r.out) && /export PATH="\$HOME\/\.local\/bin:\$PATH"/.test(r.out) && H.sha(zshrc) === before, r.all);
        r = wpIn(root, ['path-fix'], { env: envZ });
        ok('path-fix без --yes: отказ (код 2), профиль не изменён', r.code === 2 && H.sha(zshrc) === before, r.all);
        r = wpIn(root, ['path-fix', '--yes', '--human-said', 'да, допиши PATH'], { env: envZ });
        ok('path-fix --yes: строка дописана в конец, прежнее содержимое цело', r.code === 0 && text(zshrc).startsWith('# мой zshrc\nexport EDITOR=vim\n') && /export PATH="\$HOME\/\.local\/bin:\$PATH"/.test(text(zshrc)), r.all + text(zshrc));
        ok('копия прежнего профиля в .workplace/backup-profile, запись объявлена в state.json', fs.readdirSync(path.join(root, '.workplace', 'backup-profile')).some((f) => text(path.join(root, '.workplace', 'backup-profile', f)) === '# мой zshrc\nexport EDITOR=vim\n') && readJson(path.join(root, '.workplace', 'state.json')).declared.includes('~/.zshrc'));
        const once = text(zshrc);
        r = wpIn(root, ['path-fix', '--yes', '--human-said', 'да, допиши PATH'], { env: envZ });
        ok('повторный path-fix --yes: дубля строки нет', text(zshrc) === once, r.all);
      }
    }

    // ====================================================================== L3, L4
    S.section('L3) init не молчит, если снимок «до» не снят; L4) npm-путь Claude требует Node 22');
    {
      const patch = path.join(TMP, 'patch-snapshot.js');
      fs.writeFileSync(patch, "const s = require(" + JSON.stringify(path.join(H.KIT, 'core', 'lib', 'snapshot.js')) + "); s.take = () => { throw new Error('диск недоступен (тест)'); };\n");
      const root = path.join(HOME, 'root-l3');
      const r = H.run(process.execPath, ['--require', patch, H.WP_SRC, 'init', '--root', root, '--main', 'claude', '--no-scan'], { cwd: TMP, env: ENV });
      ok('init при сбое снимка: заметное ВНИМАНИЕ с причиной, «Дальше» начинается со снимка, код 0 (папка создана)', r.code === 0 && /ВНИМАНИЕ: снимок «до» НЕ снят \(диск недоступен \(тест\)\)/.test(r.out) && /Сначала снимок «до»/.test(r.out) && !/Дальше из неё: node/.test(r.out), r.all);
      const st = readJson(path.join(root, '.workplace', 'state.json'));
      ok('в state.json есть замечание про неснятый снимок, в STATE.md запись', st.notes.some((n) => /снимок «до» не снят/.test(n.text)) && /снимок «до» не снят/.test(text(path.join(root, 'STATE.md'))), JSON.stringify(st.notes));
      const claude = require(path.join(H.KIT, 'core', 'providers', 'claude.js')), codex = require(path.join(H.KIT, 'core', 'providers', 'codex.js'));
      ok('installPlan Claude: запасной путь npm требует Node >=22, Codex >=18', claude.installPlan({ platform: 'linux' }, {}).fallback.requires.node === '>=22' && codex.installPlan({ platform: 'linux' }, {}).fallback.requires.node === '>=18');
      // запасной путь на «старом» Node: npm не запускается, причина названа (npm подменён заглушкой, чтобы тест ничего не ставил)
      const binNpm = path.join(TMP, 'bin-npm'); fs.mkdirSync(binNpm, { recursive: true });
      const npmLog = path.join(TMP, 'npm.log');
      fs.writeFileSync(path.join(binNpm, 'npm.cmd'), '@echo off\r\necho %* >> "' + npmLog + '"\r\nexit /b 0\r\n');
      fs.writeFileSync(path.join(binNpm, 'npm'), '#!/bin/sh\necho "$@" >> "' + npmLog + '"\nexit 0\n'); fs.chmodSync(path.join(binNpm, 'npm'), 0o755);
      const oldNode = path.join(TMP, 'fake-node-version.js');
      fs.writeFileSync(oldNode, "Object.defineProperty(process, 'version', { value: 'v20.11.0' });\n");
      fs.rmSync(path.join(HOME, '.local'), { recursive: true, force: true });   // заглушка claude из проверки path-fix выше (только Mac и Linux) лежит в ~/.local/bin: тут Claude не должен быть найден
      const envNpm = Object.assign({}, ENV, { PATH: H.minPath([binNpm, path.join(TMP, 'bin-codex-only')]) });
      const lroot = makeRoot('root-l4', 'codex', { env: envNpm });
      const r4 = H.run(process.execPath, ['--require', oldNode, path.join(lroot, '.workplace', 'core', 'cli', 'wp.js'), 'install', 'claude', '--yes', '--human-said', 'да, ставь claude', '--npm'], { cwd: lroot, env: envNpm });
      ok('install claude --npm на Node 20: сказано «требует Node 22 или новее», npm НЕ запускался', /требует Node 22 или новее \(сейчас v20\.11\.0\)/.test(r4.out) && !(fs.existsSync(npmLog) && /install/.test(text(npmLog))), r4.all + (fs.existsSync(npmLog) ? text(npmLog) : ''));
    }
  } catch (e) {
    ok('набор дошёл до конца без исключения', false, e && e.stack);
  } finally {
    H.rmTree(TMP);
  }
  process.exit(S.finish());
})();
