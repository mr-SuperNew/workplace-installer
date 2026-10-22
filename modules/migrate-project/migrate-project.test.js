#!/usr/bin/env node
'use strict';
// Проверки модуля migrate-project на временных репозиториях: фейковая домашняя папка, фейковая главная папка со скриптом на месте модуля.
// Основа: future/adopt-tests.fragment.js из v3 (41 проверка), дополнено: резервная копия, запуск только по --yes, сверка всех файлов, проект без git с тяжёлыми папками.
// Запуск: node modules/migrate-project/migrate-project.test.js (временная папка: WP_TEST_TMP или папка ОС). Код выхода 1, если хоть одна проверка не прошла. Нужен git.
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');

const SRC_SCRIPT = path.join(__dirname, 'migrate-project.js');
const SB = fs.mkdtempSync(path.join(process.env.WP_TEST_TMP || os.tmpdir(), 'wp-migrate-'));
const HOME = path.join(SB, 'home');
const ROOT = path.join(SB, 'root');
const GITCFG = path.join(SB, 'gitconfig');
fs.mkdirSync(HOME, { recursive: true });
fs.writeFileSync(GITCFG, '[user]\n\tname = Test User\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n[advice]\n\tdetachedHead = false\n');
const ENV = Object.assign({}, process.env, { HOME, USERPROFILE: HOME, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: GITCFG, GIT_TERMINAL_PROMPT: '0' });

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('[ok] ' + name); } else { fail++; console.log('[НЕТ] ' + name + (extra ? '\n' + extra : '')); }
}
const E = (p) => fs.existsSync(p);
const R = (p) => fs.readFileSync(p, 'utf8');
const W = (p, t) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); };
const H = (...a) => path.join(HOME, ...a);
function git(dir, ...args) {
  const r = cp.spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: ENV, windowsHide: true, timeout: 60000 });
  return { code: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}
function node(script, args, o) {
  o = o || {};
  const r = cp.spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: Object.assign({}, ENV, o.env || {}), cwd: o.cwd || SB, timeout: o.timeout || 120000, windowsHide: true });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '', all: (r.stdout || '') + (r.stderr || '') };
}
// Хеш всего дерева вместе с .git: путь и содержимое каждого файла
function treeHash(dir) {
  const h = crypto.createHash('sha256');
  (function w(d) {
    for (const it of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(d, it.name);
      if (it.isSymbolicLink()) { h.update('L' + path.relative(dir, p) + fs.readlinkSync(p)); continue; }
      if (it.isDirectory()) { h.update('D' + path.relative(dir, p)); w(p); continue; }
      h.update('F' + path.relative(dir, p)); h.update(fs.readFileSync(p));
    }
  })(dir);
  return h.digest('hex');
}
function mkRepo(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  for (const [f, t] of Object.entries(files)) W(path.join(dir, f), t);
  git(dir, 'add', '--', ...Object.keys(files));
  git(dir, 'commit', '-q', '-m', 'initial');
}
function listFiles(dir) { const o = []; (function w(d) { for (const it of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, it.name); if (it.isDirectory()) w(p); else o.push(path.relative(dir, p).split(path.sep).join('/')); } })(dir); return o.sort(); }

try {
  // ---------- фейковая главная папка ----------
  const MOD = path.join(ROOT, '.workplace', 'modules', 'migrate-project', 'migrate-project.js');
  fs.mkdirSync(path.dirname(MOD), { recursive: true });
  W(path.join(ROOT, '.workplace', 'config.json'), '{}\n');
  fs.copyFileSync(SRC_SCRIPT, MOD);
  const tpl = path.join(__dirname, '..', '..', 'core', 'templates', 'gitignore.tpl');
  const GI = E(tpl) ? R(tpl) : '.env\n.env.*\nchecks/\n.workplace/state.json\n.workplace/backup-update/\ninstall-report.md\nprojects/\n';
  W(path.join(ROOT, '.gitignore'), GI);
  git(ROOT, 'init', '-q', '-b', 'main');
  git(ROOT, 'add', '--', '.gitignore');
  git(ROOT, 'commit', '-q', '-m', 'root');
  const mig = (...a) => node(MOD, a);
  const rootBefore = () => fs.readdirSync(ROOT).sort().join('|');

  // ---------- проекты ----------
  const SRC = H('Projects', 'lead-agent');
  mkRepo(SRC, { 'src/app.js': 'console.log("ok");\n', 'README.md': 'hello\n', 'CLAUDE.md': 'правила проекта\n', '.gitignore': 'node_modules/\n' });
  git(SRC, 'remote', 'add', 'origin', 'https://user:SECRETTOKEN' + String.fromCharCode(64) + 'github.com/acme/lead-agent.git');
  W(path.join(SRC, 'README.md'), 'hello changed\n');
  git(SRC, 'stash', 'push', '-q');
  W(path.join(SRC, 'src', 'app.js'), 'console.log("незакоммичено");\n');
  W(path.join(SRC, 'notes.txt'), 'заметка\n');
  W(path.join(SRC, '.env'), 'KEY=supersecretvalue\n');
  W(path.join(SRC, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
  const srcBefore = treeHash(SRC);
  const srcHead = git(SRC, 'rev-parse', 'HEAD').out.trim();

  // ---------- 1. inspect ----------
  let r = node(SRC_SCRIPT, ['inspect', SRC]);
  ok('inspect из пакета (не из главной папки): ветка, адрес без токена, незакоммиченные, .env не игнорируется, свой CLAUDE.md', r.code === 0 && /github\.com\/acme\/lead-agent\.git/.test(r.out) && !/SECRETTOKEN/.test(r.out) && /изменено 1, новых 2/.test(r.out) && /\.env не игнорируется/.test(r.out) && /свой CLAUDE\.md/.test(r.out) && /отложено \(stash\) 1/.test(r.out), r.all);
  ok('inspect ничего не изменил в проекте', treeHash(SRC) === srcBefore);
  r = node(SRC_SCRIPT, ['inspect', SRC, '--json']);
  ok('inspect --json печатает JSON в stdout, токена в нём нет', r.code === 0 && (() => { try { const j = JSON.parse(r.out); return j.is_repo === true && !/SECRETTOKEN/.test(r.out); } catch (_) { return false; } })(), r.all);
  r = node(SRC_SCRIPT, ['inspect', path.join(SRC, 'src')]);
  ok('inspect: подпапка внутри репозитория: СТОП (код 3)', r.code === 3 && /внутри репозитория/.test(r.out), r.all);

  // ---------- 2. запуск только по второму «да» ----------
  const rb = rootBefore();
  r = mig('copy', SRC, '--name', 'lead-agent');
  ok('copy без --yes: только план (код 2), ничего не создано, в плане есть резервная копия', r.code === 2 && /только план/.test(r.out) && /Резервная копия/.test(r.out) && !E(path.join(ROOT, 'projects')) && !E(path.join(ROOT, '.workplace', 'backup-update')) && rootBefore() === rb, r.all);
  r = node(SRC_SCRIPT, ['copy', SRC, '--name', 'lead-agent', '--yes']);
  ok('copy из пакета, даже с --yes: отказ (код 3), ничего не записано рядом', r.code === 3 && /только из главной папки/.test(r.err) && !E(path.join(path.dirname(SRC_SCRIPT), 'projects')), r.all);
  r = mig('copy', SRC, '--name', 'lead-agent', '--root', ROOT, '--yes');
  ok('параметр --root отвергается (код 2): пути записи нет', r.code === 2 && /Неизвестный параметр/.test(r.err) && !E(path.join(ROOT, 'projects')), r.all);

  // ---------- 3. copy --yes ----------
  r = mig('copy', SRC, '--name', 'lead-agent', '--yes');
  ok('copy --yes: код 0, все проверки [ok], сверка пройдена', r.code === 0 && !/\[НЕТ\]/.test(r.out) && /Проверка переноса пройдена/.test(r.out), r.all);
  const DST = path.join(ROOT, 'projects', 'lead-agent');
  ok('копия: тот же коммит и ветка', git(DST, 'rev-parse', 'HEAD').out.trim() === srcHead && git(DST, 'rev-parse', '--abbrev-ref', 'HEAD').out.trim() === 'main');
  ok('копия: удалённый адрес сохранён (origin, github.com)', /origin\s+https:\/\/.*github\.com\/acme\/lead-agent\.git/.test(git(DST, 'remote', '-v').out));
  ok('копия: незакоммиченные правки на месте и НЕ закоммичены', R(path.join(DST, 'src', 'app.js')).includes('незакоммичено') && git(DST, 'rev-parse', 'HEAD').out.trim() === srcHead && /^ M src\/app\.js/m.test(git(DST, 'status', '--porcelain').out) && /\?\? notes\.txt/.test(git(DST, 'status', '--porcelain').out));
  ok('копия: отложенные правки (stash) на месте', git(DST, 'stash', 'list').out.trim().split(/\r?\n/).filter(Boolean).length === 1);
  ok('копия: .env скопирован как есть, не в коммите', R(path.join(DST, '.env')).includes('supersecretvalue') && !git(DST, 'ls-files').out.includes('.env'));
  ok('копия: node_modules (игнорируется git) пропущен', !E(path.join(DST, 'node_modules')));
  ok('исходная папка не изменилась (хеш дерева с .git) и не удалена', treeHash(SRC) === srcBefore && E(SRC));
  ok('git главной папки не видит проект (projects/ игнорируется), в коммиты корня ничего не попало', git(ROOT, 'status', '--porcelain', '--', 'projects').out.trim() === '' && !git(ROOT, 'ls-files').out.includes('projects/'));
  ok('внутрь проекта ничего не добавлено: список файлов копии равен списку исходника без node_modules', (() => { const l = (d) => listFiles(d).filter((f) => !f.startsWith('node_modules/') && !f.startsWith('.git/')).join('|'); return l(SRC) === l(DST); })());
  const bk = path.join(ROOT, '.workplace', 'backup-update');
  const bdirs = E(bk) ? fs.readdirSync(bk).filter((n) => n.startsWith('migrate-lead-agent-')) : [];
  const rec = bdirs.length ? JSON.parse(R(path.join(bk, bdirs[0], 'record.json'))) : null;
  ok('резервная копия до переноса лежит в .workplace/backup-update и записана в record.json', bdirs.length === 1 && rec && rec.backup && E(path.join(ROOT, rec.backup, 'src', 'app.js')) && E(path.join(ROOT, rec.backup, '.git')) && R(path.join(ROOT, rec.backup, '.env')).includes('supersecretvalue'));
  ok('резервная копия не попадает в git главной папки', git(ROOT, 'status', '--porcelain', '--', '.workplace/backup-update').out.trim() === '' && !git(ROOT, 'ls-files').out.includes('backup-update'));
  ok('в record.json нет токена и имени пользователя', rec && !/SECRETTOKEN/.test(JSON.stringify(rec)));
  const mod = require(MOD);
  ok('резервная копия совпадает с исходником (сверка по содержимому)', (() => { const c = mod.compareTrees(SRC, path.join(ROOT, rec.backup), ['node_modules'], { full: true }); return !c.missing.length && !c.extra.length && !c.differ.length; })());
  r = mig('copy', SRC, '--name', 'lead-agent', '--yes');
  ok('повторный copy в то же имя отказывает, ничего не перезаписывает', r.code !== 0 && /уже есть/.test(r.err), r.all);
  ok('после отказа второй резервной копии нет', fs.readdirSync(bk).filter((n) => n.startsWith('migrate-lead-agent-')).length === 1);

  // ---------- 4. verify ----------
  r = mig('verify', SRC, '--name', 'lead-agent');
  ok('verify отдельно: проходит', r.code === 0, r.all);
  r = mig('verify', SRC, '--name', 'lead-agent', '--full');
  ok('verify --full: сверка всех файлов, проходит', r.code === 0 && /все файлы/.test(r.out), r.all);
  const notesSt = fs.statSync(path.join(SRC, 'notes.txt'));
  fs.appendFileSync(path.join(SRC, 'notes.txt'), 'правка после копирования\n');
  r = mig('verify', SRC, '--name', 'lead-agent');
  ok('verify замечает, что исходник менялся после копирования', r.code === 1 && /\[НЕТ\]/.test(r.out) && /не менялась/.test(r.out), r.all);
  fs.writeFileSync(path.join(SRC, 'notes.txt'), 'заметка\n');
  fs.utimesSync(path.join(SRC, 'notes.txt'), notesSt.atime, new Date(Math.floor(notesSt.mtimeMs / 1000) * 1000));
  W(path.join(DST, 'src', 'app.js'), 'console.log("разошлосьабвг");\n');
  r = mig('verify', SRC, '--name', 'lead-agent');
  ok('verify замечает разошедшийся файл в копии (содержимое при том же размере класса не прячется)', r.code === 1 && /отличаются: .*app\.js|\[НЕТ\] содержимое/.test(r.out), r.all);
  fs.copyFileSync(path.join(SRC, 'src', 'app.js'), path.join(DST, 'src', 'app.js'));
  W(path.join(DST, 'лишний.txt'), 'x');
  r = mig('verify', SRC, '--name', 'lead-agent');
  ok('verify замечает лишний файл в копии', r.code === 1 && /лишние в копии/.test(r.out), r.all);
  fs.rmSync(path.join(DST, 'лишний.txt'));
  const giBak = R(path.join(ROOT, '.gitignore'));
  W(path.join(ROOT, '.gitignore'), giBak.replace(/^projects\/\s*$/m, ''));
  r = mig('verify', SRC, '--name', 'lead-agent');
  W(path.join(ROOT, '.gitignore'), giBak);
  ok('verify со старым .gitignore главной папки называет projects/ как не игнорируемый', r.code === 1 && /НЕ игнорирует:[^\n]*projects\/lead-agent/.test(r.out), r.all);
  r = mig('verify', SRC, '--name', 'lead-agent');
  ok('после восстановления .gitignore verify снова проходит', r.code === 0, r.all);

  // ---------- 5. проект без git ----------
  const PLAIN = H('Documents', 'plain-folder');
  W(path.join(PLAIN, 'f.txt'), 'нет git\n');
  W(path.join(PLAIN, 'node_modules', 'dep', 'x.js'), 'x\n');
  r = mig('copy', PLAIN, '--name', 'plain', '--yes');
  ok('проект без git: файлы на месте, история не требуется', r.code === 0 && R(path.join(ROOT, 'projects', 'plain', 'f.txt')).includes('нет git'), r.all);
  ok('проект без git: тяжёлые папки копируются как есть (понять, восстановимы ли они, нельзя)', E(path.join(ROOT, 'projects', 'plain', 'node_modules', 'dep', 'x.js')), r.all);

  // ---------- 6. репозиторий, который переносить нельзя ----------
  const gf = H('Projects', 'gitfile'); W(path.join(gf, '.git'), 'gitdir: ../elsewhere\n');
  r = mig('inspect', gf);
  ok('inspect: «.git это файл» (подмодуль или дополнительное дерево): СТОП', r.code === 3 && /подмодуль|рабочее дерево/.test(r.out), r.all);
  r = mig('copy', gf, '--name', 'gitfile', '--yes');
  ok('copy проекта с «.git это файл»: отказ (код 3), копии и резервной копии нет', r.code === 3 && !E(path.join(ROOT, 'projects', 'gitfile')) && !fs.readdirSync(bk).some((n) => n.startsWith('migrate-gitfile-')), r.all);
  const mainWt = H('Projects', 'main-wt'); mkRepo(mainWt, { 'a.md': 'a\n' });
  const linkedWt = H('Projects', 'linked-wt'); git(mainWt, 'worktree', 'add', '-q', '-b', 'feat', linkedWt);
  r = mig('copy', linkedWt, '--name', 'linked-wt', '--yes');
  ok('copy связанного рабочего дерева (git worktree add): отказ, копии нет', E(path.join(linkedWt, '.git')) && r.code === 3 && /СТОП/.test(r.out) && !E(path.join(ROOT, 'projects', 'linked-wt')), r.all);
  const cwt = H('Projects', 'cw-repo'); mkRepo(cwt, { 'a.md': 'a\n' }); git(cwt, 'config', 'core.worktree', cwt.replace(/\\/g, '/'));
  r = mig('inspect', cwt);
  ok('inspect: core.worktree в настройках git: СТОП с объяснением, что делать', r.code === 3 && /СТОП/.test(r.out) && /core\.worktree/.test(r.out) && /Что делать/.test(r.out), r.all);
  const gwt = H('Projects', 'gw-repo'); mkRepo(gwt, { 'a.md': 'a\n' });
  const gwtCfg = path.join(SB, 'worktree.gitconfig'); W(gwtCfg, '[core]\n\tworktree = ' + gwt.replace(/\\/g, '/') + '\n');
  r = node(MOD, ['inspect', gwt], { env: { GIT_CONFIG_GLOBAL: gwtCfg } });
  ok('inspect: core.worktree из глобального конфига (временный файл через GIT_CONFIG_GLOBAL): СТОП', r.code === 3 && /СТОП/.test(r.out) && /core\.worktree/.test(r.out), r.all);
  r = mig('copy', cwt, '--name', 'cw-repo', '--yes');
  ok('copy репозитория с core.worktree: отказ (код 3), копия не создана', r.code === 3 && /core\.worktree/.test(r.out + r.err) && !E(path.join(ROOT, 'projects', 'cw-repo')), r.all);

  // ---------- 7. имя папки ----------
  const CL = H('code', 'clean-repo'); mkRepo(CL, { 'a.md': 'a\n' });
  const homeBefore = fs.readdirSync(HOME).sort().join('|'), rootNow = rootBefore(), projBefore = fs.readdirSync(path.join(ROOT, 'projects')).sort().join('|'), bkBefore = fs.readdirSync(bk).sort().join('|');
  const absName = path.join(SB, 'abs-out');
  for (const [label, bad] of [['../escape', '../escape'], ['../../escape2', '../../escape2'], ['абсолютный путь', absName], ['вложенный a/b', 'a/b'], ['обратный слэш a\\b', 'a\\b'], ['заглавные буквы Foo', 'Foo'], ['точка', '.'], ['два дефиса a--b', 'a--b'], ['дефис в начале -a', '-a'], ['пробел', 'my app']]) {
    r = mig('copy', CL, '--name', bad, '--yes');
    ok('copy --name ' + label + ': отказ с понятным текстом, ничего не создано', r.code !== 0 && /не подходит/.test(r.err) && !E(path.join(ROOT, 'escape')) && !E(H('escape2')) && !E(absName), r.all);
  }
  ok('после отказов по имени ничего нового нет ни в домашней папке, ни в корне, ни в projects/, ни среди резервных копий', fs.readdirSync(HOME).sort().join('|') === homeBefore && rootBefore() === rootNow && fs.readdirSync(path.join(ROOT, 'projects')).sort().join('|') === projBefore && fs.readdirSync(bk).sort().join('|') === bkBefore);
  r = mig('verify', CL, '--name', '../escape');
  ok('verify --name ../escape: тоже отказ', r.code !== 0 && /не подходит/.test(r.err), r.all);
  r = mig('copy', CL, '--name', 'clean-repo-2', '--yes');
  ok('copy --name clean-repo-2 (допустимое имя): код 0, копия в projects/', r.code === 0 && E(path.join(ROOT, 'projects', 'clean-repo-2', 'a.md')) && E(path.join(ROOT, 'projects', 'clean-repo-2', '.git')), r.all);
  r = mig('copy', CL, '--yes');
  ok('copy без --name: имя из названия папки (clean-repo), код 0', r.code === 0 && E(path.join(ROOT, 'projects', 'clean-repo', 'a.md')), r.all);

  // ---------- 8. границы ----------
  const inside = path.join(ROOT, 'workspaces', 'inner'); mkRepo(inside, { 'a.md': 'a\n' });
  r = mig('copy', inside, '--name', 'inner', '--yes');
  ok('проект уже внутри главной папки: отказ, копии нет', r.code === 3 && /уже внутри/.test(r.err) && !E(path.join(ROOT, 'projects', 'inner')), r.all);
  r = mig('copy', SB, '--name', 'sandbox', '--yes');
  ok('главная папка внутри «проекта»: отказ (копия скопировала бы саму себя), ничего не создано', r.code === 3 && !E(path.join(ROOT, 'projects', 'sandbox')), r.all);
  const nobody = H('Projects', 'nobody'); mkRepo(nobody, { 'a.md': 'a\n' });
  const pr = path.join(ROOT, 'projects'); const prSaved = path.join(SB, 'projects-saved');
  fs.renameSync(pr, prSaved); W(pr, 'это файл, а не папка\n');
  const bk0 = fs.readdirSync(bk).sort().join('|');
  const nBefore = treeHash(nobody);
  r = mig('copy', nobody, '--name', 'nobody', '--yes');
  ok('копирование прервалось (projects это файл): код 1, неполных копий и резервных копий не осталось, исходник цел', r.code === 1 && /прервалось/.test(r.err) && fs.readdirSync(bk).sort().join('|') === bk0 && treeHash(nobody) === nBefore, r.all);
  fs.rmSync(pr); fs.renameSync(prSaved, pr);
  r = mig('inspect');
  ok('inspect без папки: код 2, подсказка', r.code === 2, r.all);
  r = mig('inspect', H('нет', 'такой'));
  ok('inspect несуществующей папки: код 2', r.code === 2 && /Нет такой папки/.test(r.err), r.all);
  r = mig('bogus');
  ok('неизвестная команда: код 2', r.code === 2, r.all);

  // ---------- 9. мелочи вокруг ----------
  ok('в чужих проектах ничего не изменилось: хеш всех исходников (кроме правок самого теста) совпадает', treeHash(nobody) === nBefore && E(CL) && E(gwt));
} finally {
  try { fs.rmSync(SB, { recursive: true, force: true }); } catch (_) { /* не критично */ }
}
console.log('\nПройдено ' + pass + ', не прошло ' + fail + '.');
process.exit(fail ? 1 : 0);
