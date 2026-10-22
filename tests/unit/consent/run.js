#!/usr/bin/env node
'use strict';
// Библиотека подтверждения (core/lib/consent.js), копий (backup.js), правил и ролей (rules.js), приёма проектов (adopt.js): таблицы без запуска хуков.
// Здесь «да» и «без проверки» разбираются построчно: что считается подтверждением, что нет, какая цель считается названной.
//   node tests/unit/consent/run.js
const fs = require('fs');
const path = require('path');
const H = require('../../lib/harness');

const S = new H.Suite('consent');
const ok = (n, c, d) => S.ok(n, c, d);
const TMP = H.mkTmp('wp-consent-');
const HOME = path.join(TMP, 'home');
fs.mkdirSync(HOME, { recursive: true });
process.env.WP_HOME = HOME;                      // lib/util.homeDir() и ~ в тестах: фейковая домашняя папка
const consent = require(path.join(H.KIT, 'core', 'lib', 'consent.js'));
const backup = require(path.join(H.KIT, 'core', 'lib', 'backup.js'));
const rules = require(path.join(H.KIT, 'core', 'lib', 'rules.js'));
const adopt = require(path.join(H.KIT, 'core', 'lib', 'adopt.js'));

let n = 0;
const newRoot = () => { const r = path.join(TMP, 'root' + (++n)); fs.mkdirSync(path.join(r, '.workplace'), { recursive: true }); return r; };
const say = (root, ...texts) => texts.forEach((t) => consent.record(root, { prompt: t }));

try {
  S.section('isYes: что считается «да»');
  for (const t of ['да', 'Да', 'ДА!', 'да.', 'yes', 'Yes', 'да, удаляй', 'Да, поставь', 'yes please', 'да удали', '  да  ', 'Да!!!', 'ну да', 'да, ставь ffmpeg']) ok('«да»: «' + t + '»', consent.isYes(t));
  for (const t of ['', '   ', 'нет', 'не надо', 'ок', 'давай', 'угу', 'ага', 'delete', 'daa', 'дата', 'надо', 'вода', 'да нет', 'да, но не удаляй', 'да, не надо', 'stop, yes', 'нет, да не надо', 'yes, cancel', 'no', 'да отмена', "yes but don't", 'стоп',
    'Я смотрю на эту папку уже давно, и там да, лежит много старого, но я пока не решил, что с ней делать, и хочу сначала посмотреть остальное']) ok('не «да»: «' + t.slice(0, 50) + '»', !consent.isYes(t));
  ok('«да» в начале длинного сообщения', consent.isYes('Да, удаляй. ' + 'Я смотрел папку, там только старые архивы, всё нужное лежит в другом месте и уже скопировано. '.repeat(2)));
  ok('«да» в конце длинного сообщения', consent.isYes('Я посмотрел папку, там только старые архивы, которые мне не нужны, всё нужное лежит в другом месте и уже скопировано, поэтому удаляй. Да.'));
  ok('слова, где «да» часть слова, не считаются', !consent.isYes('данные') && !consent.isYes('дано') && !consent.isYes('yesterday'));

  S.section('noCheck: «без проверки» только в последнем сообщении');
  const r1 = newRoot();
  for (const [t, want] of [['запушь без проверки', true], ['Без проверки', true], ['без кросс-проверки', true], ['без чека', true], ['не надо проверять', true], ['не нужно кросс-проверку', true], ['не проверяй', true], ['пропусти проверку', true], ['skip the review', true], ['without a check', true], ['no review', true],
    ['проверь', false], ['с проверкой', false], ['запушь', false], ['проверка нужна', false], ['да', false], ['проверяй обязательно', false]]) {
    fs.rmSync(path.join(r1, '.workplace', 'human-messages.json'), { force: true });
    say(r1, t);
    ok('«' + t + '» -> ' + (want ? 'без проверки' : 'нет'), !!consent.noCheck(r1, null) === want, JSON.stringify(consent.noCheck(r1, null)));
  }
  fs.rmSync(path.join(r1, '.workplace', 'human-messages.json'), { force: true });
  say(r1, 'запушь без проверки', 'ладно');
  ok('«без проверки» было раньше последнего сообщения: не действует', consent.noCheck(r1, null) === null);
  ok('фраза в записи короткая и читаемая', (() => { fs.rmSync(path.join(r1, '.workplace', 'human-messages.json'), { force: true }); say(r1, 'сделай push, без проверки пожалуйста'); const x = consent.noCheck(r1, null); return x && x.phrase === 'без проверки'; })());

  S.section('evaluate: «да» последнего сообщения и цель в последних двух сообщениях');
  const ev = (texts, targets, session) => { const r = newRoot(); texts.forEach((t) => (typeof t === 'string' ? say(r, t) : t.plan ? consent.registerPlan(r, t.plan) : consent.record(r, { prompt: t.say, session: t.session }))); return consent.evaluate(r, session || null, { kind: targets ? 'target' : 'yes', targets: targets || [] }); };
  const P = (rel) => ({ kind: 'path', abs: path.join(HOME, rel) });
  ok('нет записей: no-record', ev([], [P('old-tmp')]).why === 'no-record');
  ok('нет «да»: no-yes', ev(['удали ~/old-tmp'], [P('old-tmp')]).why === 'no-yes');
  ok('«да» и цель в предыдущем сообщении: ok', ev(['удали ~/old-tmp', 'да'], [P('old-tmp')]).ok);
  ok('«да» и цель в том же сообщении: ok', ev(['удали ~/old-tmp, да'], [P('old-tmp')]).ok);
  ok('цель не названа: not-named и названа в missing', (() => { const x = ev(['удали ~/old-tmp', 'да'], [P('other')]); return x.why === 'not-named' && x.missing.length === 1; })());
  ok('только действие без цели (kind yes): хватает «да»', ev(['откати', 'да'], null).ok);
  ok('цель названа три сообщения назад: не считается', ev(['удали ~/old-tmp', 'ок', 'да'], [P('old-tmp')]).why === 'not-named');
  ok('несколько целей: нужно назвать каждую', ev(['удали ~/a', 'да'], [P('a'), P('b')]).why === 'not-named' && ev(['удали ~/a и ~/b', 'да'], [P('a'), P('b')]).ok);
  ok('сессия: «да» чужой сессии не считается', ev([{ say: 'удали ~/old-tmp', session: 'A' }, { say: 'да', session: 'A' }], [P('old-tmp')], 'B').why === 'no-record');
  ok('сессия: «да» своей сессии считается', ev([{ say: 'удали ~/old-tmp', session: 'A' }, { say: 'да', session: 'A' }], [P('old-tmp')], 'A').ok);
  ok('запись без номера сессии считается для любой', ev(['удали ~/old-tmp', 'да'], [P('old-tmp')], 'B').ok);

  S.section('названа ли цель-путь');
  const t = (text, rel) => consent.textNamesPath(text, path.join(HOME, rel));
  ok('~/old-tmp называет ~/old-tmp', t('удали ~/old-tmp', 'old-tmp'));
  ok('полный путь называет себя', t('удали ' + path.join(HOME, 'old-tmp'), 'old-tmp'));
  ok('полный путь с прямыми слэшами (как пишут на Windows)', t('удали ' + path.join(HOME, 'old-tmp').replace(/\\/g, '/'), 'old-tmp'));
  ok('имя папки без пути называет её', t('Удали old-tmp', 'old-tmp'));
  ok('имя с точкой в конце фразы', t('удали папку old-tmp.', 'old-tmp'));
  ok('имя в кавычках-ёлочках', t('удали «old-tmp»', 'old-tmp'));
  ok('родительская папка называет содержимое', t('очисти ~/work/shop', 'work/shop/src/app.js'));
  ok('вложенная папка не называет родителя', !t('удали ~/old-tmp/cache', 'old-tmp'));
  ok('соседняя папка с общим началом не считается (~/old-tmp2)', !t('удали ~/old-tmp2', 'old-tmp'));
  ok('другой путь с тем же именем в конце не называет (/mnt/data/old-tmp, ../old-tmp)', !t('удали /mnt/data/old-tmp', 'old-tmp') && !t('удали ../old-tmp', 'old-tmp') && t('удали ./old-tmp/', 'old-tmp') && t('удали old-tmp/', 'old-tmp'));
  ok('домашняя папка (~) не называет ничего внутри', !t('работай в ~', 'old-tmp') && !t('поправь файлы в ' + HOME, 'old-tmp'));
  ok('слишком короткое имя (до 3 знаков) само по себе не называет', !t('удали ab', 'ab'));
  ok('чужое имя не называет', !t('удали ~/other', 'old-tmp'));
  ok('регистр: на Windows и Mac имя без учёта регистра', process.platform === 'linux' || t('удали OLD-TMP', 'old-tmp'));
  ok('пробел в пути', t('удали «' + path.join(HOME, 'Мои документы', 'старое') + '»', 'Мои документы/старое'));

  S.section('названа ли программа');
  const nm = (text, ...names) => consent.textNamesName(text, names);
  ok('codex называет @openai/codex', nm('поставь codex', '@openai/codex'));
  ok('Claude Code называет @anthropic-ai/claude-code@latest', nm('Обнови Claude Code', '@anthropic-ai/claude-code@latest') && nm('обнови claude', '@anthropic-ai/claude-code'));
  ok('по-русски: Кодекс, Клод', nm('поставь Кодекс', 'codex') && nm('обнови клода', 'claude'));
  ok('ffmpeg называет Gyan.FFmpeg', nm('Поставь ffmpeg', 'Gyan.FFmpeg'));
  ok('другая программа не называется', !nm('поставь python', 'codex') && !nm('поставь claude', '@openai/codex'));
  ok('общее слово code не называет Claude Code', !nm('открой code', '@anthropic-ai/claude-code'));
  ok('слово внутри другого слова не считается (codexx)', !nm('поставь codexx', 'codex'));

  S.section('план: на него отвечает первое сообщение человека после плана');
  const planRoot = (events) => { const r = newRoot(); for (const e of events) { if (e.plan) consent.registerPlan(r, e.plan); else say(r, e.say); } return r; };
  ok('план и сразу «да»: принят', !!consent.approvedPlan(planRoot([{ plan: 'Удалю ~/x' }, { say: 'да' }]), null));
  ok('план без ответа: не принят', !consent.approvedPlan(planRoot([{ plan: 'Удалю ~/x' }]), null));
  ok('план, потом не «да»: не принят', !consent.approvedPlan(planRoot([{ plan: 'Удалю ~/x' }, { say: 'подожди' }]), null));
  ok('план, потом другое сообщение, потом «да»: не принят', !consent.approvedPlan(planRoot([{ plan: 'Удалю ~/x' }, { say: 'а зачем?' }, { say: 'да' }]), null));
  ok('«да» раньше плана: не принят', !consent.approvedPlan(planRoot([{ say: 'да' }, { plan: 'Удалю ~/x' }]), null));
  ok('второй план заменяет первый', (() => { const r = planRoot([{ plan: 'Удалю ~/a' }, { plan: 'Удалю ~/b' }, { say: 'да' }]); const p = consent.approvedPlan(r, null); return p && /~\/b/.test(p.text) && !/~\/a/.test(p.text); })());
  ok('время плана ставит сама библиотека: прошлым числом записать нельзя', (() => { const r = newRoot(); say(r, 'да'); consent.registerPlan(r, 'Удалю ~/x'); const p = JSON.parse(fs.readFileSync(consent.planFile(r), 'utf8')); const m = JSON.parse(fs.readFileSync(consent.messagesFile(r), 'utf8')).messages[0]; return p.ms > m.ms; })());
  ok('план без текста: ошибка кода 2', (() => { try { consent.registerPlan(newRoot(), '  '); return false; } catch (e) { return e.code === 2; } })());
  ok('цель «весь набор» (kind plan) требует принятого плана', ev([{ plan: 'Обновлю всё' }, 'да'], [{ kind: 'plan' }]).ok && ev(['обнови всё', 'да'], [{ kind: 'plan' }]).why === 'not-named');

  S.section('запись сообщений');
  const r2 = newRoot();
  for (let i = 1; i <= 10; i++) say(r2, 'сообщение ' + i);
  const stored = JSON.parse(fs.readFileSync(consent.messagesFile(r2), 'utf8')).messages;
  ok('хранятся последние 8, порядок и время строго растут', stored.length === 8 && stored[0].text === 'сообщение 3' && stored.every((m, i) => i === 0 || m.ms > stored[i - 1].ms));
  ok('пустое сообщение и не строка не записываются', consent.record(r2, { prompt: '  ' }) === false && consent.record(r2, { prompt: 5 }) === false && consent.record(r2, {}) === false);
  ok('строка с ключом скрыта, остальное цело', (() => { const r = newRoot(); say(r, 'вот\npassword = "' + 'Xk92' + 'mPq7Lz4wR1' + '"\nда'); const s = fs.readFileSync(consent.messagesFile(r), 'utf8'); return !s.includes('Xk92') && s.includes('да') && s.includes('скрыта'); })());
  ok('очень длинное сообщение обрезается', (() => { const r = newRoot(); say(r, 'а'.repeat(20000)); return JSON.parse(fs.readFileSync(consent.messagesFile(r), 'utf8')).messages[0].text.length <= 4000; })());
  ok('путь к файлам подтверждения опознаётся (в том числе временный файл записи)', ['.workplace/human-messages.json', 'C:\\x\\.workplace\\consent-plan.json', '/a/.workplace/human-messages.json.tmp-123'].every((p) => consent.isProtectedPath(p)) && !consent.isProtectedPath('.workplace/config.json') && !consent.isProtectedPath('human-messages.json'));

  S.section('backup: копия файла перед правкой');
  const r3 = newRoot();
  const f1 = path.join(HOME, 'settings.json');
  fs.writeFileSync(f1, '{"a":1}\n');
  let b = backup.backupFile(r3, f1);
  ok('копия создана, содержимое то же, лежит в .workplace/backups', b.made && fs.readFileSync(path.join(r3, b.file), 'utf8') === '{"a":1}\n' && /^\.workplace\/backups\//.test(b.file), JSON.stringify(b));
  b = backup.backupFile(r3, f1);
  ok('та же версия второй раз не копируется', !b.made && /уже есть/.test(b.reason));
  fs.writeFileSync(f1, '{"a":2}\n');
  b = backup.backupFile(r3, f1);
  ok('изменённый файл копируется снова (две разные копии)', b.made && fs.readdirSync(path.join(r3, '.workplace', 'backups')).filter((x) => x !== 'index.jsonl').length === 2);
  ok('файла нет: копировать нечего, ошибки нет', (() => { const x = backup.backupFile(r3, path.join(HOME, 'нет-такого.txt')); return !x.made && !x.error && x.reason === 'нет файла'; })());
  ok('папка вместо файла не копируется как файл', !backup.backupFile(r3, HOME).made);
  ok('список копий (index.jsonl) называет исходный путь и хеш', (() => { const l = fs.readFileSync(path.join(r3, '.workplace', 'backups', 'index.jsonl'), 'utf8').trim().split('\n').map((x) => JSON.parse(x)); return l.length === 2 && l[0].from === path.resolve(f1) && /^[0-9a-f]{64}$/.test(l[0].sha256); })());
  ok('копия папки: тяжёлые папки пропускаются, файлы на месте, повтор в той же секунде не затирает', (() => {
    const proj = path.join(HOME, 'p'); H.write(path.join(proj, 'a.txt'), 'a'); H.write(path.join(proj, 'node_modules', 'x', 'i.js'), 'x'); H.write(path.join(proj, 'src', 'b.txt'), 'b');
    const x = backup.backupDir(r3, proj, 'adopt-p'), y = backup.backupDir(r3, proj, 'adopt-p');
    return x.made && y.made && x.dir !== y.dir && fs.existsSync(path.join(r3, x.dir, 'src', 'b.txt')) && !fs.existsSync(path.join(r3, x.dir, 'node_modules')) && x.skipped.includes('node_modules');
  })());
  ok('слишком большая папка не копируется и об этом сказано', (() => { const x = backup.backupDir(r3, path.join(HOME, 'p'), 'big', { limitBytes: 1 }); return !x.made && /больше/.test(x.reason); })());

  S.section('rules.syncRoles: роли в AGENTS.md');
  const cfgCodex = { main: 'codex', reviewer: 'claude' }, cfgClaude = { main: 'claude', reviewer: 'codex' };
  const fullClaude = rules.render('claude', 'codex'), fullCodex = rules.render('codex', 'claude');
  ok('шаблон различает направления (есть строки с ролями)', rules.roleLines(cfgClaude).length >= 2 && fullClaude !== fullCodex);
  let sy = rules.syncRoles(fullClaude, cfgCodex);
  ok('не правленный файл заменяется целиком', sy.changed && sy.how === 'full' && sy.text === fullCodex);
  sy = rules.syncRoles(fullCodex, cfgCodex);
  ok('роли уже верные: без изменений', !sy.changed && sy.how === 'same');
  sy = rules.syncRoles(fullClaude + '\n- Моя строка.\n', cfgCodex);
  ok('файл с правкой человека: меняются только строки с ролями, правка цела', sy.changed && sy.how === 'lines' && sy.text === fullCodex + '\n- Моя строка.\n' && sy.left.length === 0, sy.how);
  const l0 = rules.roleLines(cfgClaude)[0];
  sy = rules.syncRoles(fullClaude.replace(l0, l0 + ' По-своему.'), cfgCodex);
  ok('строка роли переписана человеком: остальные меняются, эта остаётся и названа в left', sy.changed && sy.left.length === 1 && sy.text.includes('По-своему.'), JSON.stringify(sy.left));
  sy = rules.syncRoles('совсем другой файл\n', cfgCodex);
  ok('файл без строк шаблона не трогается', !sy.changed && sy.how === 'none' && sy.text === 'совсем другой файл\n');
  sy = rules.syncRoles(fullClaude.replace(/\n/g, '\r\n'), cfgCodex);
  ok('окончания строк CRLF сохраняются', sy.changed && sy.text.includes('\r\n') && !/[^\r]\n/.test(sy.text));
  ok('roleLines у двух направлений не пересекаются', rules.roleLines(cfgClaude).every((l) => !rules.roleLines(cfgCodex).includes(l)));

  S.section('Codex как исполнитель: codex exec --sandbox workspace-write');
  const codex = require(path.join(H.KIT, 'core', 'providers', 'codex.js'));
  const ra = codex.runArgs({ dir: '/d', outFile: '/o.md' });
  ok('run: exec, --sandbox workspace-write, -C папка, -o файл, задание через stdin', ra[0] === 'exec' && ra[ra.indexOf('--sandbox') + 1] === 'workspace-write' && ra[ra.indexOf('-C') + 1] === '/d' && ra[ra.indexOf('-o') + 1] === '/o.md' && ra[ra.length - 1] === '-', ra.join(' '));
  ok('run не read-only, а проверяющий остался read-only (две разные роли)', !ra.includes('read-only') && codex.reviewArgs({ dir: '/d', outFile: '/o.md' }).includes('read-only'));
  ok('run: модель из параметра; ключи API из окружения убираются у запуска (описание команды)', codex.runArgs({ dir: '/d', outFile: '/o.md', model: 'terra' }).includes('terra') && /OPENAI_API_KEY/.test(codex.runCommand({ dir: '/d', outFile: '/o.md' }).note));
  ok('у провайдера Codex есть run, у Claude запуска задач пока нет (честный отказ в delegate)', typeof codex.run === 'function' && typeof require(path.join(H.KIT, 'core', 'providers', 'claude.js')).run === 'undefined');

  S.section('adopt: строки .gitignore и поиск вложенных репозиториев');
  ok('giLine: корневой путь со слэшем на конце', adopt.giLine('shop') === '/shop/' && adopt.giLine('a/b c/d') === '/a/b c/d/');
  ok('giLine: знаки шаблонов экранируются', adopt.giLine('a[1]*') === '/a\\[1\\]\\*/');
  const gr = newRoot();
  H.write(path.join(gr, 'a', '.git', 'HEAD'), 'ref: refs/heads/main\n'); H.write(path.join(gr, 'a', 'src', 'x.js'), '1');
  H.write(path.join(gr, 'b', 'c', 'd', '.git'), 'gitdir: ../../x\n');                        // .git как файл (подмодуль, рабочее дерево)
  H.write(path.join(gr, 'node_modules', 'm', '.git', 'HEAD'), 'x');                            // тяжёлая папка не обходится
  H.write(path.join(gr, 'e', '.git', 'HEAD'), 'x'); H.write(path.join(gr, 'e', 'inner', '.git', 'HEAD'), 'x');   // внутрь найденного репозитория не заходим
  fs.mkdirSync(path.join(gr, '.git'), { recursive: true });                                   // свой .git корня не считается вложенным
  const found = adopt.nestedRepos(gr, gr).map((d) => path.relative(gr, d).split(path.sep).join('/')).sort();
  ok('nestedRepos: a, b/c/d, e; без node_modules, без вложенного в e, без самого корня', JSON.stringify(found) === JSON.stringify(['a', 'b/c/d', 'e']), JSON.stringify(found));
  H.write(path.join(gr, 'deep1', 'deep2', 'deep3', 'deep4', 'deep5', 'deep6', 'deep7', 'p', '.git', 'HEAD'), 'x');
  ok('глубже семи уровней не ищется (предел обхода)', !adopt.nestedRepos(gr, gr).some((d) => /deep7/.test(d)));
} catch (e) {
  ok('набор дошёл до конца без исключения', false, e && e.stack);
} finally {
  H.rmTree(TMP);
}
process.exit(S.finish());
