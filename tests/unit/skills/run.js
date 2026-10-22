#!/usr/bin/env node
'use strict';
// Модульные тесты навыков (core/skills): cross-check, end-session, new-workspace, doctor. Заглушки проверяющего: tests/stubs/ (копия с исполняемым битом делается при запуске: tests/lib/stubs.js).
//   node tests/unit/skills/run.js
// Каждое направление (основной Claude + проверяет Codex; основной Codex + проверяет Claude) проходит одни и те же проверки в своей временной
// главной папке, собранной настоящими `wp.js init` и `wp.js layout`. Фейковый HOME (WP_HOME), настоящие ~/.claude и ~/.codex не трогаются.
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const KIT = path.resolve(__dirname, '..', '..', '..');                 // build/v4
const SKILLS = path.join(KIT, 'core', 'skills');
const WP_SRC = path.join(KIT, 'core', 'cli', 'wp.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-skills-'));
const HOME = path.join(TMP, 'home');
fs.mkdirSync(HOME, { recursive: true });
const STUBS = require(path.join(KIT, 'tests', 'lib', 'stubs.js')).prepare(path.join(TMP, 'stubs'));   // codex и claude; бит исполнения ставится на копии (Mac, Linux)

let pass = 0, failed = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; return true; }
  failed++; failures.push(name + (detail ? ' :: ' + String(detail).slice(0, 600) : ''));
  process.stdout.write('  ПАДЕНИЕ: ' + name + (detail ? '\n    ' + String(detail).slice(0, 600).replace(/\n/g, '\n    ') : '') + '\n');
  return false;
}
function section(t) { process.stdout.write('\n== ' + t + '\n'); }

function env(extra) {
  const e = Object.assign({}, process.env, { WP_HOME: HOME, PATH: STUBS + path.delimiter + (process.env.PATH || process.env.Path || ''), STUB_MODE: 'smart', WP_NET_PROBE: 'off', STUB_LOG: path.join(TMP, 'stub.log') }, extra || {});
  delete e.CODEX_SANDBOX_NETWORK_DISABLED; delete e.CLAUDE_PROJECT_DIR; delete e.ANTHROPIC_API_KEY; delete e.OPENAI_API_KEY;
  return e;
}
function node(script, args, o) {
  o = o || {};
  const r = cp.spawnSync(process.execPath, [script, ...args], { cwd: o.cwd || TMP, encoding: 'utf8', env: env(o.env), timeout: o.timeout || 120000 });
  return { code: r.status, out: String(r.stdout || ''), err: String(r.stderr || ''), all: String(r.stdout || '') + String(r.stderr || '') };
}
const wp = (root, args, o) => node(path.join(root, '.workplace', 'core', 'cli', 'wp.js'), args, Object.assign({ cwd: root }, o));
const skill = (root, name, script, args, o) => node(path.join(root, '.workplace', 'core', 'skills', name, 'scripts', script), args || [], Object.assign({ cwd: root }, o));
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const write = (root, rel, text) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };
const checksDirs = (root) => (fs.existsSync(path.join(root, 'checks')) ? fs.readdirSync(path.join(root, 'checks'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : []);
const lastDir = (out) => (out.match(/Папка проверки:\s*(checks\/\S+)/) || [])[1];
function logLines() { try { return fs.readFileSync(path.join(TMP, 'stub.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (_) { return []; } }
const sha = (f) => require('crypto').createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function makeRoot(main, tag) {
  const root = path.join(HOME, 'root-' + tag);
  let r = node(WP_SRC, ['init', '--root', root, '--main', main, '--no-scan'], { cwd: TMP });
  if (r.code !== 0) { ok('init ' + main, false, r.all); return null; }
  r = wp(root, ['layout']);
  if (r.code !== 0) { ok('layout ' + main, false, r.all); return null; }
  return root;
}
function walk(d, rel) { return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name), rel + e.name + '/') : [rel + e.name])); }

// ============ A. статика ============
section('A. статика: синтаксис, SKILL.md, стоп-фразы');
const jsFiles = [...walk(SKILLS, '').filter((f) => f.endsWith('.js')).map((f) => path.join(SKILLS, f)), ...walk(__dirname, '').filter((f) => f.endsWith('.js')).map((f) => path.join(__dirname, f))];
for (const f of jsFiles) { const r = cp.spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' }); ok('node --check ' + path.relative(KIT, f), r.status === 0, r.stderr); }
const SK = ['cross-check', 'end-session', 'new-workspace', 'doctor'];
// Репозиторий публичный: имён людей в тестах нет. Стоп-фразы собраны из частей, имена ищет хеш-список check-no-private.js (scanLine), а не слова в этом файле.
const { scanLine } = require(path.join(KIT, 'scripts', 'check-no-private.js'));
const STOP = [['с ', 'И', 'льёй'].join(''), 'без при' + 'смотра', 'сам ничего не ' + 'ставь', 'не входи в ' + 'аккаунт', 'на за' + 'нятии', ['git add', ' -A'].join(''), '--' + 'bare', '--' + 'global', ['git ', 'push'].join('')];
for (const s of SK) {
  const md = fs.readFileSync(path.join(SKILLS, s, 'SKILL.md'), 'utf8');
  ok(s + ': SKILL.md не длиннее 120 строк', md.split('\n').length <= 120, md.split('\n').length);
  const fm = md.match(/^---\nname: (.+)\ndescription: (.+)\n---\n/);
  ok(s + ': frontmatter name и description', !!fm && fm[1] === s && fm[2].length > 60, fm && fm[1]);
  ok(s + ': без привязки к провайдеру (нет путей скриптов из .claude/.agents)', !/\.(claude|agents)\/skills\/[a-z-]+\/scripts/.test(md));
  ok(s + ': нет CRLF', !md.includes('\r'));
}
const ccDesc = fs.readFileSync(path.join(SKILLS, 'cross-check', 'SKILL.md'), 'utf8').match(/^description: (.+)$/m)[1];
ok('cross-check: description со словами «кросс-чек» и «перед необратимым или внешним шагом»', ccDesc.includes('кросс-чек') && ccDesc.includes('перед необратимым или внешним шагом'));
ok('cross-check: description про не только код (письмо, текст)', /письмо/.test(ccDesc) && /текст/.test(ccDesc));
for (const f of [...walk(SKILLS, ''), ...walk(path.join(KIT, 'tests', 'stubs'), '').map((x) => '../../tests/stubs/' + x)]) {
  const abs = path.join(SKILLS, f);
  if (/\.(md|js|json|cmd)$/.test(f) && !f.endsWith('run.js')) {
    const t = fs.readFileSync(abs, 'utf8');
    for (const ph of STOP) ok('стоп-фраза «' + ph + '» отсутствует: ' + f, !t.includes(ph));
    const hits = t.split(/\r?\n/).flatMap((line, i) => scanLine(line, f, []).map(([cls]) => (i + 1) + ': ' + cls));
    ok('имён людей, почт и личных путей нет (хеш-список check-no-private): ' + f, hits.length === 0, hits.join('; '));
  }
}

// ============ B. оба направления ============
const DIRS = [
  { main: 'claude', reviewer: 'codex', tag: 'cc' },
  { main: 'codex', reviewer: 'claude', tag: 'cx' },
];
for (const D of DIRS) {
  section('B. направление: основной ' + D.main + ', проверяет ' + D.reviewer);
  const root = makeRoot(D.main, D.tag);
  if (!root) continue;
  const cfg = readJson(path.join(root, '.workplace', 'config.json'));
  ok(D.tag + ': config main/reviewer', cfg.main === D.main && cfg.reviewer === D.reviewer, JSON.stringify(cfg));

  // --- раскладка: навыки одинаковы в трёх местах
  const srcFiles = SK.flatMap((s) => walk(path.join(SKILLS, s), s + '/'));
  for (const base of ['.workplace/core/skills', '.claude/skills', '.agents/skills']) {
    const miss = srcFiles.filter((f) => !fs.existsSync(path.join(root, base, f)) || sha(path.join(root, base, f)) !== sha(path.join(SKILLS, f)));
    ok(D.tag + ': навыки в ' + base + ' байт-в-байт как в пакете', miss.length === 0, miss.join(', '));
  }

  // --- самопроверка на заглушке: верная GREEN, с ошибкой RED
  fs.rmSync(path.join(TMP, 'stub.log'), { force: true });
  let r = skill(root, 'cross-check', 'selftest-run.js', ['--timeout', '60']);
  ok(D.tag + ': selftest-run принят (код 0)', r.code === 0, r.all);
  const ms = checksDirs(root).map((d) => readJson(path.join(root, 'checks', d, 'manifest.json')));
  const good = ms.find((m) => m.label === 'selftest-good'), bad = ms.find((m) => m.label === 'selftest-bad');
  ok(D.tag + ': верная копия принята, GREEN или YELLOW', good && good.status === 'checked' && ['GREEN', 'YELLOW'].includes(good.verdict), JSON.stringify(good && [good.status, good.verdict]));
  ok(D.tag + ': копия с ошибкой принята как RED', bad && bad.status === 'checked' && bad.verdict === 'RED', JSON.stringify(bad && [bad.status, bad.verdict, bad.reasons]));
  ok(D.tag + ': у ошибочной записано expect_mention и expect_verdict', bad && bad.expect_verdict === 'RED' && (bad.expect_mention || []).includes('Бета'));
  const runJson = checksDirs(root).map((d) => readJson(path.join(root, 'checks', d, 'run.json')));
  ok(D.tag + ': run.json называет проверяющего ' + D.reviewer, runJson.length === 2 && runJson.every((x) => x.reviewer === D.reviewer && x.ok), JSON.stringify(runJson));
  ok(D.tag + ': run-copy удалена после запуска', checksDirs(root).every((d) => !fs.existsSync(path.join(root, 'checks', d, 'run-copy'))));
  const vbad = fs.readFileSync(path.join(root, 'checks', checksDirs(root).find((d) => d.endsWith('selftest-bad')), 'verdict.md'), 'utf8');
  ok(D.tag + ': в verdict.md ошибочной названа Бета и 4,0', /Бета/.test(vbad) && /4,0/.test(vbad));
  r = wp(root, ['verify', 'P3.selftest']);
  ok(D.tag + ': wp.js verify P3.selftest зелёный', r.code === 0, r.all);

  // --- вызов провайдера: команда и режим «только чтение»
  const calls = logLines().filter((l) => l.argv.some((a) => ['exec', '-p'].includes(a)) && l.provider === D.reviewer);
  ok(D.tag + ': проверяющий вызван ' + calls.length + ' раза (ожидалось 2) через провайдера ' + D.reviewer, calls.length === 2, JSON.stringify(logLines().map((l) => l.provider + ' ' + l.argv[0])));
  ok(D.tag + ': другой ИИ как проверяющий не вызывался', !logLines().some((l) => l.provider !== D.reviewer && l.argv.some((a) => ['exec', '-p'].includes(a))));
  if (calls.length) {
    const a = calls[0].argv.join(' ');
    if (D.reviewer === 'codex') ok(D.tag + ': codex exec --sandbox read-only --ephemeral, промпт через stdin', /^exec --sandbox read-only --ephemeral --skip-git-repo-check -C .+ -o .+verdict\.md -c project_doc_max_bytes=0 -$/.test(a), a);
    else ok(D.tag + ': claude -p --tools Read,Grep,Glob dontAsk, без сессии, --setting-sources с ПУСТЫМ значением (потеря пустого аргумента ловится: сверка по элементам argv)', JSON.stringify(calls[0].argv) === JSON.stringify(['-p', '--tools', 'Read,Grep,Glob', '--permission-mode', 'dontAsk', '--no-session-persistence', '--setting-sources', '', '--output-format', 'text']), JSON.stringify(calls[0].argv));
    ok(D.tag + ': проверяющий запущен в run-copy, не в корне', path.basename(calls[0].cwd) === 'run-copy' && path.resolve(calls[0].cwd) !== root, calls[0].cwd);
    ok(D.tag + ': модель по умолчанию не задана (нет -m / --model)', !calls[0].argv.includes('-m') && !calls[0].argv.includes('--model'));
  }

  // --- модель проверяющего из config.json доходит до команды
  r = wp(root, ['config', 'set', 'reviewer_model', 'test-model']);
  write(root, 'm.md', '# Заметка\nТекст для проверки модели.\n');
  fs.rmSync(path.join(TMP, 'stub.log'), { force: true });
  r = skill(root, 'cross-check', 'prepare-check.js', ['--name', 'model', '--task', 'проверка модели', '--result', 'm.md']);
  const dm = lastDir(r.out);
  r = skill(root, 'cross-check', 'run-check.js', [dm]);
  const cm = logLines().find((l) => l.argv.some((a) => ['exec', '-p'].includes(a)));
  ok(D.tag + ': reviewer_model доходит до команды проверяющего', !!cm && (cm.argv.includes('-m') ? cm.argv[cm.argv.indexOf('-m') + 1] : cm.argv[cm.argv.indexOf('--model') + 1]) === 'test-model', JSON.stringify(cm));
  wp(root, ['config', 'set', 'reviewer_model', 'null']);

  // --- «слепой» вердикт отклоняется
  write(root, 'a.md', '# Результат\nВывод: всё верно.\n');
  const prep = (name, extra) => skill(root, 'cross-check', 'prepare-check.js', ['--name', name, '--task', 'проверка', ...extra]);
  const chk = (name, extra, mode, runArgs, finArgs) => {
    const p = prep(name, extra);
    const d = lastDir(p.out);
    if (!d) return { prep: p };
    const ru = skill(root, 'cross-check', 'run-check.js', [d, ...(runArgs || [])], { env: { STUB_MODE: mode } });
    const fi = skill(root, 'cross-check', 'finalize-check.js', [d, ...(finArgs || [])]);
    return { prep: p, run: ru, fin: fi, dir: d, manifest: readJson(path.join(root, d, 'manifest.json')) };
  };
  let c = chk('blind', ['--result', 'a.md'], 'blind');
  ok(D.tag + ': слепой вердикт без цитат отклонён (код 3, not_checked)', c.fin && c.fin.code === 3 && c.manifest.status === 'not_checked' && /нет верной цитаты/.test(c.fin.out), c.fin && c.fin.all);
  c = chk('lazy-mention', ['--result', 'selftest/result-with-error.md', '--sources', 'selftest/input.md'], 'lazy', [], ['--expect-mention', 'Бета|4,0']);
  ok(D.tag + ': вердикт без названной ошибки отклонён (--expect-mention)', c.fin && c.fin.code === 3 && /слепая/.test(c.fin.out), c.fin && c.fin.all);
  c = chk('lazy-green', ['--result', 'selftest/result-with-error.md', '--sources', 'selftest/input.md'], 'lazy', [], ['--expect-verdict', 'RED']);
  ok(D.tag + ': GREEN на ошибочной копии отклонён (--expect-verdict RED)', c.fin && c.fin.code === 3 && /ожидался RED/.test(c.fin.out), c.fin && c.fin.all);
  c = chk('smart-red', ['--result', 'selftest/result-with-error.md', '--sources', 'selftest/input.md'], 'smart', [], ['--expect-mention', 'Бета|4.0', '--expect-verdict', 'RED']);
  ok(D.tag + ': число с точкой вместо запятой («4.0» против «4,0») засчитывается', c.fin && c.fin.code === 0 && c.manifest.verdict === 'RED', c.fin && c.fin.all);
  // оригинал изменён после подготовки
  const p = prep('tamper', ['--result', 'a.md']);
  const dt = lastDir(p.out);
  fs.appendFileSync(path.join(root, 'a.md'), 'дописано после подготовки\n');
  skill(root, 'cross-check', 'run-check.js', [dt]);
  const ft = skill(root, 'cross-check', 'finalize-check.js', [dt]);
  ok(D.tag + ': файл изменён после подготовки: проверка отклонена', ft.code === 3 && /изменился после подготовки/.test(ft.out), ft.all);
  write(root, 'a.md', '# Результат\nВывод: всё верно.\n');

  // --- какие файлы принимаются
  section('   ' + D.tag + ': приём файлов');
  write(root, 'ok/a.js', 'module.exports = 1;\n'); write(root, 'ok/b.md', '# b\n'); write(root, 'ok/c.csv', 'a;b\n1;2\n'); write(root, 'ok/d.json', '{"a":1}\n'); write(root, 'ok/.env.example', 'KEY=ваш_ключ\n');
  const before = checksDirs(root).length;
  r = prep('formats', ['--result', 'ok/a.js,ok/b.md,ok/c.csv,ok/d.json,ok/.env.example']);
  ok(D.tag + ': .js .md .csv .json (и .env.example) принимаются', r.code === 0 && checksDirs(root).length === before + 1, r.all);
  const mf = readJson(path.join(root, lastDir(r.out), 'manifest.json'));
  ok(D.tag + ': в манифесте 5 файлов с sha256', mf.files.length === 5 && mf.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256)));
  const refuse = (name, rel, extra) => {
    const n0 = checksDirs(root).length;
    const x = prep('ref-' + name, ['--result', rel, ...(extra || [])]);
    ok(D.tag + ': отказ «' + name + '» (код 1, папка проверки не осталась)', x.code === 1 && checksDirs(root).length === n0, x.all);
    return x;
  };
  write(root, '.env', 'API_KEY=1\n'); refuse('.env', '.env');
  write(root, '.env.local', 'A=1\n'); refuse('.env.local', '.env.local');
  write(root, 'server.pem', 'x\n'); refuse('.pem', 'server.pem');
  write(root, 'id_rsa', 'x\n'); refuse('id_rsa', 'id_rsa');
  const outside = path.join(TMP, 'outside-' + D.tag + '.md'); fs.writeFileSync(outside, '# вне корня\n');
  refuse('вне корня (абсолютный путь)', outside);
  refuse('вне корня (..)', '../outside-' + D.tag + '.md');
  write(root, 'tbl.xlsx', 'PK'); refuse('.xlsx', 'tbl.xlsx');
  fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([0, 1, 2, 0, 255, 254])); refuse('бинарный файл', 'bin.dat');
  write(root, '.git/config', '[core]\n'); refuse('.git/', '.git/config');
  refuse('checks/', 'checks/' + checksDirs(root)[0] + '/manifest.json');
  refuse('несуществующий файл', 'net-takogo.md');
  try {
    fs.symlinkSync(path.join(root, 'a.md'), path.join(root, 'link.md'));
    refuse('символическая ссылка', 'link.md');
  } catch (e) { process.stdout.write('  (символическая ссылка не создана: ' + e.code + ', проверка пропущена)\n'); }
  const fakeKey = 'sk-' + 'abcdefghijklmnopqrstuvwxyz0123456789';
  write(root, 'leak.md', 'Ключ: ' + fakeKey + '\n');
  const lk = refuse('текст с ключом', 'leak.md');
  ok(D.tag + ': значение ключа в сообщении об отказе не печатается', !lk.all.includes(fakeKey), lk.all);
  r = prep('allow', ['--result', 'leak.md', '--allow-secret-like']);
  ok(D.tag + ': с --allow-secret-like файл принят', r.code === 0, r.all);
  r = skill(root, 'cross-check', 'prepare-check.js', ['--name', 'root', '--task', 'x', '--result', 'a.md', '--root', TMP]);
  ok(D.tag + ': параметр --root отклонён', r.code === 1 && /--root/.test(r.all), r.all);
  r = skill(root, 'cross-check', 'run-check.js', ['../..']);
  ok(D.tag + ': run-check с «../..» отклонён', r.code === 1, r.all);
  r = skill(root, 'cross-check', 'run-check.js', [path.join(root, 'checks', 'x')]);
  ok(D.tag + ': run-check с абсолютным путём отклонён', r.code === 1, r.all);

  // --- маскирование
  section('   ' + D.tag + ': маскирование');
  write(root, 'pd.md', ['Почта: ivan.petrov@example.com', 'Телефон: +7 (916) 123-45-67 и 8 916 555 11 22', 'Дата: 2026-10-21 19:15, метка 20261021-191550, 21.10.2026 12:30', 'ИНН: 7707083893', 'Сумма: 1 234 567 890 руб.'].join('\n') + '\n');
  r = prep('mask', ['--result', 'pd.md']);
  const dmk = lastDir(r.out);
  const masked = fs.readFileSync(path.join(root, dmk, 'input', 'result', 'pd.md'), 'utf8');
  ok(D.tag + ': почта замаскирована (i***@домен)', /i\*\*\*@example\.com/.test(masked) && !/ivan\.petrov/.test(masked), masked);
  ok(D.tag + ': телефоны замаскированы', !/916/.test(masked) && /\+\*\*\* \*\*\* \*\* 67/.test(masked) && /\+\*\*\* \*\*\* \*\* 22/.test(masked), masked);
  ok(D.tag + ': даты и метки времени не испорчены', masked.includes('2026-10-21 19:15') && masked.includes('20261021-191550') && masked.includes('21.10.2026 12:30'), masked);
  ok(D.tag + ': ИНН и сумма с пробелами не тронуты', masked.includes('7707083893') && masked.includes('1 234 567 890'), masked);
  ok(D.tag + ': оригинал в корне не изменён', fs.readFileSync(path.join(root, 'pd.md'), 'utf8').includes('ivan.petrov@example.com'));
  ok(D.tag + ': в промпте сказано про маскирование', /намеренно замаскированы/.test(fs.readFileSync(path.join(root, dmk, 'prompt.md'), 'utf8')));
  r = prep('unmasked-no', ['--result', 'pd.md', '--unmasked']);
  ok(D.tag + ': --unmasked без решения человека отказ', r.code === 1 && /POLICY/.test(r.all), r.all);
  write(root, 'checks/POLICY.md', 'ПДн проверяющему: можно (тест, 21.10)\n');
  r = prep('unmasked-yes', ['--result', 'pd.md', '--unmasked']);
  ok(D.tag + ': --unmasked после записи в POLICY.md принят, почта на месте', r.code === 0 && fs.readFileSync(path.join(root, lastDir(r.out), 'input', 'result', 'pd.md'), 'utf8').includes('ivan.petrov@example.com'), r.all);
  fs.rmSync(path.join(root, 'checks', 'POLICY.md'));

  // --- режим --action (проверка намерения)
  section('   ' + D.tag + ': проверка намерения (--action)');
  write(root, 'letter.md', 'Здравствуйте! Отправляем счёт на 120 000 руб. Срок оплаты 25.10.\n'); write(root, 'list.csv', 'клиент;сумма\nАльфа;120000\n');
  r = skill(root, 'cross-check', 'prepare-check.js', ['--name', 'intent', '--action', 'Отправить письмо со счётом клиенту Альфа', '--result', 'letter.md', '--sources', 'list.csv']);
  const di = lastDir(r.out);
  ok(D.tag + ': --action без --task принят', r.code === 0 && !!di, r.all);
  const mi = readJson(path.join(root, di, 'manifest.json'));
  ok(D.tag + ': manifest.mode = action, action.md есть как виртуальный файл', mi.mode === 'action' && mi.files.some((f) => f.virtual && f.input_copy === 'result/action.md'), JSON.stringify(mi.files));
  const pi = fs.readFileSync(path.join(root, di, 'prompt.md'), 'utf8');
  ok(D.tag + ': в промпте режим «проверка намерения», шаг ещё не выполнен, вердикт про выполнение', /проверка намерения/.test(pi) && /ещё НЕ выполнил/.test(pi) && /RED выполнять нельзя/.test(pi) && /result\/action\.md/.test(pi), pi);
  ok(D.tag + ': в промпте нет привязки к Codex', !/Codex/.test(pi));
  ok(D.tag + ': текст шага лежит в input/result/action.md', /Отправить письмо со счётом клиенту Альфа/.test(fs.readFileSync(path.join(root, di, 'input', 'result', 'action.md'), 'utf8')));
  r = skill(root, 'cross-check', 'run-check.js', [di], { env: { STUB_VERDICT: 'YELLOW' } });
  ok(D.tag + ': запуск намерения', r.code === 0, r.all);
  r = skill(root, 'cross-check', 'finalize-check.js', [di]);
  ok(D.tag + ': намерение принято, YELLOW (хеш action.md не сверяется с диском)', r.code === 0 && /YELLOW/.test(r.out) && readJson(path.join(root, di, 'manifest.json')).status === 'checked', r.all);
  r = skill(root, 'cross-check', 'prepare-check.js', ['--name', 'intent-only', '--action', 'Удалить папку old/ с сервера']);
  ok(D.tag + ': --action без файлов тоже принят', r.code === 0, r.all);
  r = skill(root, 'cross-check', 'prepare-check.js', ['--name', 'intent-secret', '--action', 'Отправить ключ ' + fakeKey + ' коллеге']);
  ok(D.tag + ': ключ в тексте --action отказ, значение не печатается', r.code === 1 && !r.all.includes(fakeKey), r.all);
  r = skill(root, 'cross-check', 'prepare-check.js', ['--name', 'intent-empty', '--action', '  ']);
  ok(D.tag + ': пустой --action отказ', r.code === 1, r.all);

  // --- сбои запуска проверяющего: подсказки без «подставь свою проверку»
  section('   ' + D.tag + ': сбои запуска');
  write(root, 'f.md', '# f\nтекст\n');
  for (const [mode, rx, extra] of [['quota', /лимит/, []], ['auth', /вход/, []], ['empty', /ответа нет|не состоялась/, []], ['hang', /Время вышло/, ['--timeout', '5']]]) {
    const pf = prep('fail-' + mode, ['--result', 'f.md']);
    const df = lastDir(pf.out);
    const t0 = Date.now();
    const rf = skill(root, 'cross-check', 'run-check.js', [df, ...extra], { env: { STUB_MODE: mode } });
    ok(D.tag + ': ' + mode + ': код 2 и подсказка', rf.code === 2 && rx.test(rf.out) && /НЕ ПРОВЕРЕНО/.test(rf.out), rf.all);
    ok(D.tag + ': ' + mode + ': verdict.md не создан, run-copy убрана', !fs.existsSync(path.join(root, df, 'verdict.md')) && !fs.existsSync(path.join(root, df, 'run-copy')));
    if (mode === 'hang') ok(D.tag + ': hang остановлен по таймауту за ' + Math.round((Date.now() - t0) / 1000) + ' с', Date.now() - t0 < 60000);
    const ff = skill(root, 'cross-check', 'finalize-check.js', [df]);
    ok(D.tag + ': ' + mode + ': finalize после сбоя = НЕ ПРОВЕРЕНО', ff.code === 3 && /НЕ ПРОВЕРЕНО/.test(ff.out), ff.all);
  }

  // --- скрипты работают из .claude/skills и .agents/skills (одинаково для обоих ИИ)
  for (const base of ['.claude/skills', '.agents/skills']) {
    const x = node(path.join(root, base, 'cross-check', 'scripts', 'prepare-check.js'), ['--name', 'from-' + base.slice(1, 3), '--task', 'x', '--result', 'f.md'], { cwd: root });
    ok(D.tag + ': prepare-check запускается из ' + base, x.code === 0 && !!lastDir(x.out), x.all);
  }
  // чужая папка с поддельной меткой: скрипты берут корень по своему расположению, а не по cwd
  const fake = path.join(HOME, 'fake-' + D.tag); fs.mkdirSync(path.join(fake, '.workplace'), { recursive: true }); fs.writeFileSync(path.join(fake, '.workplace', 'config.json'), '{}');
  const nf = checksDirs(root).length;
  r = node(path.join(root, '.workplace', 'core', 'skills', 'cross-check', 'scripts', 'prepare-check.js'), ['--name', 'fake', '--task', 'x', '--result', 'f.md'], { cwd: fake, env: { CLAUDE_PROJECT_DIR: fake } });
  ok(D.tag + ': корень по расположению скрипта, а не по cwd/CLAUDE_PROJECT_DIR', !fs.existsSync(path.join(fake, 'checks')) && checksDirs(root).length === nf + 1, r.all);

  // --- new-workspace через wp.js
  section('   ' + D.tag + ': new-workspace');
  r = wp(root, ['new-workspace', 'weekly-report', '--title', 'Недельный отчёт', '--goal', 'Собирать отчёт по понедельникам']);
  const ws = path.join(root, 'workspaces', 'weekly-report');
  ok(D.tag + ': new-workspace создаёт триаду, handoffs, data, out', r.code === 0 && ['AGENTS.md', 'CLAUDE.md', 'tasks.md', 'MEMORY.md', 'handoffs', 'data', 'out'].every((n) => fs.existsSync(path.join(ws, n))), r.all);
  ok(D.tag + ': CLAUDE.md папки содержит @AGENTS.md, название и цель подставлены', /@AGENTS\.md/.test(fs.readFileSync(path.join(ws, 'CLAUDE.md'), 'utf8')) && /Недельный отчёт/.test(fs.readFileSync(path.join(ws, 'AGENTS.md'), 'utf8')) && /по понедельникам/.test(fs.readFileSync(path.join(ws, 'AGENTS.md'), 'utf8')));
  fs.writeFileSync(path.join(ws, 'MEMORY.md'), 'мои правки\n');
  r = wp(root, ['new-workspace', 'weekly-report']);
  ok(D.tag + ': повтор не перезаписывает (код 3), правки целы', r.code === 3 && fs.readFileSync(path.join(ws, 'MEMORY.md'), 'utf8') === 'мои правки\n', r.all);
  r = wp(root, ['new-workspace', 'Недельный отчёт 2']);
  ok(D.tag + ': русское название даёт папку латиницей и показывает похожую', r.code === 0 && fs.existsSync(path.join(root, 'workspaces', 'nedelnyj-otchet-2')), r.all);
  r = wp(root, ['new-workspace', 'weekly-report-2']);
  ok(D.tag + ': похожие папки названы', r.code === 0 && /weekly-report/.test(r.out) && /похожие/.test(r.out), r.all);

  // --- end-session: записка подхватывается (форма файла) и шаблон на месте
  section('   ' + D.tag + ': end-session');
  const tplPath = path.join(root, '.workplace', 'core', 'templates', 'handoff.md.tpl');
  const es = fs.readFileSync(path.join(root, '.claude', 'skills', 'end-session', 'SKILL.md'), 'utf8');
  ok(D.tag + ': end-session: 5 шагов и три режима', [1, 2, 3, 4, 5].every((n) => new RegExp('## Шаг ' + n + '\\.').test(es)) && /Закрыть/.test(es) && /Перейти/.test(es) && /сжатию/.test(es));
  ok(D.tag + ': end-session ссылается на существующий шаблон записки и поглощает /handoff', es.includes('.workplace/core/templates/handoff.md.tpl') && fs.existsSync(tplPath) && /отдельный \/handoff не нужен/.test(es));
  const tp = fs.readFileSync(tplPath, 'utf8');
  const secs = [...es.matchAll(/«([^»]+)»/g)].map((m) => m[1]);
  ok(D.tag + ': разделы записки из SKILL.md есть в шаблоне', ['Цель', 'Что уже сделано', 'Какие файлы менялись', 'Что не трогать', 'Следующий шаг', 'Как проверить результат', 'Открытые вопросы к человеку'].every((s) => tp.includes('## ' + s) && es.includes(s)), secs.join(','));

  // --- doctor
  section('   ' + D.tag + ': doctor');
  r = skill(root, 'doctor', 'doctor.js', ['--json'], { env: { STUB_LOGIN: 'chatgpt' } });
  let dj = null; try { dj = JSON.parse(r.out); } catch (_) { /* ниже */ }
  ok(D.tag + ': doctor --json разбирается', !!dj, r.all);
  if (dj) {
    const it = (id) => dj.items.find((x) => x.id === id) || {};
    ok(D.tag + ': doctor видит оба ИИ и роли', dj.providers.length === 2 && dj.providers.find((x) => x.name === D.main).role === 'основной' && dj.providers.find((x) => x.name === D.reviewer).role === 'проверяющий', JSON.stringify(dj.providers));
    ok(D.tag + ': doctor: консольные команды обоих ИИ найдены (заглушки)', it('install.claude').status === 'ok' && it('install.codex').status === 'ok', JSON.stringify([it('install.claude'), it('install.codex')]));
    ok(D.tag + ': doctor: вход в Codex по `codex login status` = ok', it('login.codex').status === 'ok', JSON.stringify(it('login.codex')));
    ok(D.tag + ': doctor: вход в Claude без --live = не проверено, а не ok', it('login.claude').status === 'notchecked' && /--live/.test(it('login.claude').fix), JSON.stringify(it('login.claude')));
    ok(D.tag + ': doctor: самопроверка (вшитая ошибка) ok после selftest-run', it('P3.selftest').status === 'ok', JSON.stringify(it('P3.selftest')));
    ok(D.tag + ': doctor: навыки одинаковы для обоих ИИ', it('skills').status === 'ok', JSON.stringify(it('skills')));
    ok(D.tag + ': doctor: «не проверено» не даёт код 0 (код 2, если провалов нет, или 1)', r.code !== 0 && dj.summary.notchecked >= 1, r.code + ' ' + JSON.stringify(dj.summary));
    ok(D.tag + ': doctor: обратное направление названо', /Обратное направление/.test(it('direction.reverse').title || ''));
  }
  const login0 = skill(root, 'doctor', 'doctor.js', ['--json', '--live'], { env: { STUB_LOGIN: 'none', STUB_CLAUDE_LOGIN: 'none' } });
  let dl = null; try { dl = JSON.parse(login0.out); } catch (_) { /* ниже */ }
  ok(D.tag + ': doctor --live без входа в оба ИИ: login = НЕТ с подсказкой «вход делает человек»', dl && dl.items.find((x) => x.id === 'login.codex').status === 'fail' && dl.items.find((x) => x.id === 'login.claude').status === 'fail' && /вход делает человек/.test(dl.items.find((x) => x.id === 'login.codex').fix), login0.all);
  const apikey = skill(root, 'doctor', 'doctor.js', ['--json'], { env: { STUB_LOGIN: 'apikey' } });
  let da = null; try { da = JSON.parse(apikey.out); } catch (_) { /* ниже */ }
  ok(D.tag + ': doctor: вход Codex по ключу API = НЕТ (платный)', da && da.items.find((x) => x.id === 'login.codex').status === 'fail' && /ключу API/.test(da.items.find((x) => x.id === 'login.codex').detail), apikey.all);
  const human = skill(root, 'doctor', 'doctor.js', []);
  ok(D.tag + ': doctor человекочитаемый вывод с итогом и строками починки', /Итог:/.test(human.out) && /не проверено/.test(human.out), human.out.slice(-400));
  const snap = (d) => walk(d, '').sort().map((f) => f + ':' + sha(path.join(d, f))).join('\n');
  const s0 = snap(root); skill(root, 'doctor', 'doctor.js', []); ok(D.tag + ': doctor ничего не пишет (дерево главной папки то же)', snap(root) === s0);

  // --- тест вшитой ошибки в doctor: проверяющий «слепнет» -> самопроверка красная
  const root2 = makeRoot(D.main, D.tag + '-blind');
  if (root2) {
    const sb = skill(root2, 'cross-check', 'selftest-run.js', ['--timeout', '60'], { env: { STUB_MODE: 'blind' } });
    ok(D.tag + ': слепой проверяющий: selftest-run не проходит (код 1, «слепая»)', sb.code === 1 && /НЕ пройдена|не пройдена/i.test(sb.out) && /слепая/.test(sb.out), sb.all);
    const sl = skill(root2, 'cross-check', 'selftest-run.js', ['--timeout', '60'], { env: { STUB_MODE: 'lazy' } });
    ok(D.tag + ': ленивый проверяющий (GREEN на ошибочной копии): selftest-run не проходит', sl.code === 1 && /не пройдена/i.test(sl.out), sl.all);
    const d2 = skill(root2, 'doctor', 'doctor.js', ['--json']);
    let j2 = null; try { j2 = JSON.parse(d2.out); } catch (_) { /* ниже */ }
    const st = j2 && j2.items.find((x) => x.id === 'P3.selftest');
    ok(D.tag + ': doctor: после слепого проверяющего самопроверка = НЕТ, код 1, есть команда починки', st && st.status === 'fail' && d2.code === 1 && /selftest-run\.js/.test(st.fix) && st.needsYes, JSON.stringify(st));
    const s3 = wp(root2, ['verify', 'P3.selftest']);
    ok(D.tag + ': wp.js verify P3.selftest красный после слепого проверяющего', s3.code === 1, s3.all);
  }
}

// ============ C. вне главной папки ============
section('C. запуск вне главной папки');
const pkgRun = node(path.join(SKILLS, 'cross-check', 'scripts', 'prepare-check.js'), ['--name', 'x', '--task', 'x', '--result', 'a.md'], { cwd: TMP });
ok('скрипт из пакета без главной папки: отказ, ничего не записано', pkgRun.code === 1 && /главной папки/.test(pkgRun.all) && !fs.existsSync(path.join(TMP, 'checks')), pkgRun.all);

section('Итог');
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* временная папка */ }
process.stdout.write('Проверок пройдено: ' + pass + ', падений: ' + failed + '\n');
if (failed) { process.stdout.write('Падения:\n' + failures.map((f) => ' - ' + f).join('\n') + '\n'); process.exit(1); }
