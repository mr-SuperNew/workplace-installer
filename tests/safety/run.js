#!/usr/bin/env node
'use strict';
// Безопасность: чужое не трогаем. Основа - раздел 8 из v3/tests/run.js, ожидания под v4: установки программ БЫВАЮТ, но только после «да» и объявляются.
//   node tests/safety/run.js
// Фейковый HOME со всем «личным» (профили оболочки, ~/.claude, ~/.codex, настройки VS Code, чужой проект с git, старый проект без git), ловушка во временной
// папке ОС (TEMP, TMP, TMPDIR указывают на «чужой проект»). Критерии: К6 разведка ничего не меняет, К12 отказы init, К19-К20 три класса записей вне корня,
// К21 git только свои пути и чужой индекс побайтно тот же, К22 чужой проект с git (изменённый, индексированный, неотслеживаемый файлы, stash) байт-в-байт тот же.
const fs = require('fs');
const path = require('path');
const H = require('../lib/harness');
const stubsLib = require('../lib/stubs');

const S = new H.Suite('safety');
const ok = (n, c, d) => S.ok(n, c, d);
const TMP = H.mkTmp('wp-safety-');
const HOME = path.join(TMP, 'home');
const TRAP = path.join(TMP, 'trap');                    // «временная папка ОС»: чужой проект, в нём ничего не должно появиться
const BIN = stubsLib.prepare(path.join(TMP, 'bin'), ['codex', 'claude', 'python', 'python3']);
const LOG = path.join(TMP, 'stub.log');
const ENV = H.sandboxEnv(HOME, { path: H.minPath([BIN]), trap: TRAP, extra: { STUB_LOG: LOG } });
const IS_WIN = H.IS_WIN, IS_MAC = process.platform === 'darwin';
const H2 = (...p) => path.join(HOME, ...p);

// ---------- фейковый HOME: личное ----------
const VSC = IS_WIN ? ['AppData', 'Roaming', 'Code', 'User', 'settings.json'] : IS_MAC ? ['Library', 'Application Support', 'Code', 'User', 'settings.json'] : ['.config', 'Code', 'User', 'settings.json'];
const PERSONAL = {
  gitconfig: ['.gitconfig', '[user]\n\tname = Test Person\n\temail = test@example.com\n'],
  zshrc: ['.zshrc', '# мой zshrc\nexport EDITOR=vim\n'],
  zprofile: ['.zprofile', '# мой zprofile\nexport PATH="$HOME/bin:$PATH"\n'],
  claudeSettings: [path.join('.claude', 'settings.json'), JSON.stringify({ model: 'opus', permissions: { allow: ['Bash(ls)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo личный хук' }] }] } }, null, 2) + '\n'],
  claudeMd: [path.join('.claude', 'CLAUDE.md'), 'Мои личные правила для всех проектов\n'],
  claudeSkill: [path.join('.claude', 'skills', 'my-skill', 'SKILL.md'), '---\nname: my-skill\n---\n'],
  claudeAgent: [path.join('.claude', 'agents', 'helper.md'), '---\nname: helper\nmodel: haiku\n---\n'],
  codexCfg: [path.join('.codex', 'config.toml'), 'model = "gpt-5"\napproval_policy = "never"\nsandbox_mode = "danger-full-access"\n'],
  codexAgents: [path.join('.codex', 'AGENTS.md'), 'личные правила Codex\n'],
  codexAuth: [path.join('.codex', 'auth.json'), '{"fake":"TOKEN-DO-NOT-COPY-12345"}\n'],
  vscode: [path.join(...VSC), '{ "editor.fontSize": 15 }\n'],
};
const personalSums = () => Object.fromEntries(Object.values(PERSONAL).map(([rel]) => [rel, H.exists(H2(rel)) ? H.sha(H2(rel)) : null]));

const ROOT = H2('workplace'), ER = H2('empty-root'), R3 = H2('root-three'), R4 = H2('root-four');
const OWN_ROOTS = ['workplace', 'empty-root', 'root-three', 'root-four'];
const homeMap = () => H.treeMap(HOME, OWN_ROOTS);
const same = (a, b) => H.mapDiffText(a, b) === 'изменено: ; добавлено: ; убрано: ';
const wpPkg = (args, o) => H.node(H.WP_SRC, args, Object.assign({ cwd: TMP, env: ENV }, o || {}));
const wpIn = (root, args, o) => H.node(path.join(root, '.workplace', 'core', 'cli', 'wp.js'), args, Object.assign({ cwd: root, env: ENV }, o || {}));

try {
  H.write(path.join(TRAP, 'package.json'), '{"name":"foreign-tmp"}\n');
  H.write(path.join(TRAP, 'README.md'), '# чужой проект во временной папке\n');
  H.write(path.join(TRAP, 'wp-recon-123.json'), '{"victim":true}\n');
  H.write(path.join(TRAP, 'wp-check-victim', 'input', 'a.md'), 'не удалять\n');
  fs.mkdirSync(path.join(TRAP, '.git'), { recursive: true }); H.write(path.join(TRAP, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  for (const [rel, text] of Object.values(PERSONAL)) H.write(H2(rel), text);
  const PRJ = H.makeForeignRepo(H2('Projects', 'lead-agent'), ENV, 'lead-agent');
  const OLD = H2('Documents', 'old-scripts');
  H.write(path.join(OLD, 'requirements.txt'), 'requests\n'); H.write(path.join(OLD, 'run.py'), 'print("old")\n');
  H.write(H2('Documents', 'notes', 'a.txt'), 'просто файлы\n');
  fs.mkdirSync(ER, { recursive: true });
  const sums00 = personalSums();
  const trapHash0 = H.treeHash(TRAP), prjHash0 = H.treeHash(PRJ), oldHash0 = H.treeHash(OLD);
  const prjState0 = H.repoState(PRJ, ENV);
  const home0 = homeMap();
  const prjUnchanged = () => H.treeHash(PRJ) === prjHash0 && H.treeHash(OLD) === oldHash0;

  // ================= К6: разведка и план ничего не меняют =================
  S.section('К6. Разведка и план не меняют ни байта (cwd внутри чужого проекта)');
  let r = wpPkg(['recon'], { cwd: PRJ });
  ok('recon (текст) из папки чужого проекта: код 0, «НЕ ТРОГАЮ»', r.code === 0 && /НЕ ТРОГАЮ/.test(r.out), r.all);
  r = wpPkg(['recon', '--json'], { cwd: PRJ });
  let rj = null; try { rj = JSON.parse(r.out); } catch (_) { /* ниже */ }
  ok('recon --json: найден проект с git (lead-agent) и без git (old-scripts), заметки в Documents не считаются проектом', !!rj && rj.projects.repos.some((p) => /lead-agent$/.test(p.path)) && rj.projects.others.some((p) => /old-scripts$/.test(p.path)) && !rj.projects.others.some((p) => /notes$/.test(p.path)), JSON.stringify(rj && rj.projects));
  const userRx = new RegExp('\\b' + require('os').userInfo().username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
  ok('в JSON разведки нет абсолютного пути фейковой домашней папки и имени пользователя системы', r.out.indexOf(HOME) < 0 && r.out.indexOf(HOME.replace(/\\/g, '/')) < 0 && r.out.indexOf(JSON.stringify(HOME).slice(1, -1)) < 0 && !userRx.test(r.out),
    (() => { const i = [r.out.indexOf(HOME), r.out.indexOf(HOME.replace(/\\/g, '/')), r.out.search(userRx)].filter((x) => x >= 0).sort((a, b) => a - b)[0]; return i === undefined ? '' : '...' + r.out.slice(Math.max(0, i - 120), i + 160) + '...'; })());
  r = wpPkg(['plan', '--json'], { cwd: PRJ });
  ok('plan из папки чужого проекта: код 0', r.code === 0, r.all);
  ok('хеш фейкового HOME до и после разведки и плана совпадает', same(home0, homeMap()), H.mapDiffText(home0, homeMap()));
  ok('чужой проект с .git (хеш всего дерева) и старый проект те же', prjUnchanged());
  ok('разведка не создала файлов во временной папке ОС (ловушка TEMP)', H.treeHash(TRAP) === trapHash0);

  // ================= К12: отказы init ничего не создают =================
  S.section('К12. init отказывает на чужом, ничего не создавая и не меняя');
  const refusals = [
    ['внутри проекта с git', H2('Projects', 'lead-agent', 'workplace'), H2('Projects', 'lead-agent', 'workplace')],
    ['глубоко внутри проекта с git (родители не создаются)', H2('Projects', 'lead-agent', 'x', 'y', 'workplace'), H2('Projects', 'lead-agent', 'x')],
    ['внутри проекта без git (requirements.txt)', H2('Documents', 'old-scripts', 'workplace'), H2('Documents', 'old-scripts', 'workplace')],
    ['существующая непустая папка', H2('Documents'), null],
    ['домашняя папка', HOME, null],
    ['корень диска', path.parse(HOME).root, null],
  ];
  for (const [label, root, mustNot] of refusals) {
    r = wpPkg(['init', '--root', root, '--main', 'claude', '--no-scan'], { cwd: PRJ });
    ok('init отказывает (код 3): ' + label, r.code === 3 && (!mustNot || !H.exists(mustNot)), r.all);
  }
  try {
    fs.symlinkSync(H2('Documents', 'notes'), H2('link-root'), IS_WIN ? 'junction' : 'dir');
    r = wpPkg(['init', '--root', H2('link-root'), '--main', 'claude', '--no-scan']);
    ok('init отказывает на ссылке (junction или symlink), цель не тронута', r.code === 3 && H.read(H2('Documents', 'notes', 'a.txt')) === 'просто файлы\n' && !H.exists(H2('Documents', 'notes', '.workplace')), r.all);
    try { fs.unlinkSync(H2('link-root')); } catch (_) { try { fs.rmdirSync(H2('link-root')); } catch (_2) { /* уже убрана */ } }
  } catch (e) { ok('ссылка для проверки создана (' + e.code + ')', false, 'без ссылки отказ на ссылке не проверить'); }
  ok('после отказов домашняя папка, чужой проект и ловушка TEMP байт-в-байт те же', same(home0, homeMap()) && prjUnchanged() && H.treeHash(TRAP) === trapHash0, H.mapDiffText(home0, homeMap()));

  // ================= К22: полная установка из папки чужого проекта =================
  S.section('К22. init, layout, hooks, snapshot, verify, report с cwd внутри чужого проекта: проект и всё личное те же');
  r = wpPkg(['init', '--root', ER, '--main', 'claude', '--no-scan'], { cwd: PRJ });
  ok('init принимает существующую ПУСТУЮ папку', r.code === 0 && H.exists(path.join(ER, '.workplace', 'state.json')), r.all);
  r = wpPkg(['init', '--root', ROOT, '--main', 'claude'], { cwd: PRJ });
  const rb = H.exists(path.join(ROOT, '.workplace', 'recon-before.json')) ? H.readJson(path.join(ROOT, '.workplace', 'recon-before.json')) : null;
  ok('init с поиском проектов: корень создан, разведка внутри init видит lead-agent и old-scripts', r.code === 0 && rb && rb.projects.repos.some((p) => /lead-agent$/.test(p.path)) && rb.projects.others.some((p) => /old-scripts$/.test(p.path)), r.all);
  const flow = [['layout'], ['hooks', 'wire'], ['hooks', 'test'], ['state', 'next'], ['snapshot', 'before', '--force'], ['new-workspace', 'weekly-report'], ['gitignore', 'check'], ['verify', 'P1.root', 'P2.core', 'P2.hooks', 'P3.hooks-test'], ['snapshot', 'after'], ['report']];
  for (const a of flow) { r = wpIn(ROOT, a, { cwd: PRJ }); ok('wp.js ' + a.join(' ') + ' (cwd в чужом проекте): код 0', r.code === 0, r.all); }
  ok('чужой проект с .git (изменённый, индексированный, неотслеживаемый файлы, stash) и старый проект: хеш всего дерева тот же', prjUnchanged(), '');
  const prjState1 = H.repoState(PRJ, ENV);
  ok('git чужого проекта: статус, stash, HEAD, индекс (diff --cached) и настройки побайтно те же', JSON.stringify(prjState1) === JSON.stringify(prjState0), JSON.stringify(Object.keys(prjState0).filter((k) => prjState0[k] !== prjState1[k])));
  ok('ловушка во временной папке ОС (TEMP) не тронута: ничего не создано и не удалено', H.treeHash(TRAP) === trapHash0);
  ok('вне главных папок вся домашняя папка байт-в-байт та же (профили оболочки, ~/.claude, ~/.codex, VS Code)', same(home0, homeMap()), H.mapDiffText(home0, homeMap()));
  ok('11 личных файлов (.gitconfig, .zshrc, .zprofile, ~/.claude/*, ~/.codex/*, настройки VS Code) после полной установки побайтно те же', JSON.stringify(personalSums()) === JSON.stringify(sums00), Object.keys(sums00).filter((k) => sums00[k] !== personalSums()[k]).join(', '));
  const rep = H.read(path.join(ROOT, 'install-report.md'));
  ok('отчёт: «Ни один отслеживаемый файл вне главной папки не изменён», класса A нет', /Ни один отслеживаемый файл вне главной папки не изменён/.test(rep) && !/ТРЕВОГА: запись не объявлена/.test(rep), rep.split('\n').filter((l) => /вне/.test(l)).join('\n'));
  ok('в главной папке нет чужих проектов и нет папки projects', !H.exists(path.join(ROOT, 'projects', 'lead-agent')) && !rb.projects.repos.some((p) => H.exists(path.join(ROOT, path.basename(p.path)))));
  ok('файл входа Codex не скопирован в главную папку', !(function grep(d) { for (const it of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, it.name); if (it.isDirectory()) { if (grep(p)) return true; } else if (it.isFile() && fs.readFileSync(p).includes('TOKEN-DO-NOT-COPY')) return true; } return false; })(ROOT));

  // ================= К21: git только свои пути =================
  S.section('К21. git-init: только свои пути, чужое и неотслеживаемое не коммитится, чужой индекс побайтно тот же');
  const mine = { 'private.txt': 'личное\n', 'notes.md': 'заметки\n', '.env': 'KEY_VALUE=not-a-real-secret\n', 'projects/p/a.js': 'x\n', 'workspaces/weekly-report/data/d.csv': 'a;b\n1;2\n' };
  for (const [rel, text] of Object.entries(mine)) H.write(path.join(ROOT, rel), text);
  r = wpIn(ROOT, ['git-init'], { cwd: PRJ });
  ok('git-init: код 0, коммит создан', r.code === 0 && /Коммит создан/.test(r.out), r.all);
  const tracked = H.git(ROOT, ['ls-files'], ENV).out.split(/\r?\n/).filter(Boolean);
  const OWN = /^(AGENTS\.md|CLAUDE\.md|tasks\.md|MEMORY\.md|\.gitignore|\.claude\/|\.agents\/|\.codex\/|\.workplace\/)/;
  ok('в коммите только свои пути (' + tracked.length + ' файлов)', tracked.length > 0 && tracked.every((f) => OWN.test(f)), tracked.filter((f) => !OWN.test(f)).join(', '));
  ok('в коммите нет служебных и личных файлов: state.json, снимки, .env, backup, личное и проекты', !tracked.some((f) => /^\.env/.test(f) || /\.workplace\/(state|recon-before)\.json|\.workplace\/(snapshots|backup-update|npm-cache)\//.test(f) || /settings\.local\.json|\.bak-/.test(f) || Object.keys(mine).includes(f)), tracked.filter((f) => /state\.json|snapshots|\.env|private|notes\.md|projects\//.test(f)).join(', '));
  const st = H.git(ROOT, ['status', '--porcelain'], ENV).out;
  const ignored = (p) => H.git(ROOT, ['check-ignore', '-q', p], ENV).code === 0;
  ok('личные файлы private.txt и notes.md остались неотслеживаемыми, .env и projects/ игнорируются, в индексе после коммита ничего нет', /\?\? private\.txt/.test(st) && /\?\? notes\.md/.test(st) && ignored('.env') && ignored('projects/p/a.js') && !/^[AM] /m.test(st), st);
  ok('git главной папки: один коммит, удалённых адресов нет (push невозможен), имя и почта локально не записаны (взяты из настроек git)', H.git(ROOT, ['rev-list', '--count', 'HEAD'], ENV).out.trim() === '1' && H.git(ROOT, ['remote'], ENV).out.trim() === '' && !/user\.(name|email)/.test(H.git(ROOT, ['config', '--local', '--list'], ENV).out), H.git(ROOT, ['config', '--local', '--list'], ENV).out);
  ok('git-init из чужого проекта не затронул чужой индекс и дерево', prjUnchanged() && JSON.stringify(H.repoState(PRJ, ENV)) === JSON.stringify(prjState0));
  // исходные тексты: ни одной команды push, добавления всего подряд и общей настройки git
  const bad = [];
  (function scan(d) {
    for (const it of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, it.name);
      if (it.isDirectory()) { if (!['node_modules', '.git'].includes(it.name)) scan(p); continue; }
      if (!/\.js$/.test(it.name) || /\.test\.js$/.test(it.name) || /[\\/]hooks[\\/]/.test(p)) continue;
      const text = fs.readFileSync(p, 'utf8');
      const rx = new RegExp(['[\'"]pu' + 'sh[\'"]', '[\'"]-' + 'A[\'"]', '[\'"]--' + 'global[\'"]', 'git add -' + 'A', 'git pu' + 'sh'].join('|'));
      const m = text.match(rx); if (m) bad.push(path.relative(H.KIT, p) + ': ' + m[0]);
    }
  })(path.join(H.KIT, 'core')); (function scanMods(d) { for (const it of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, it.name); if (it.isDirectory()) scanMods(p); else if (/\.js$/.test(it.name) && !/\.test\.js$/.test(it.name)) { const t = fs.readFileSync(p, 'utf8'); const m = t.match(new RegExp(['[\'"]pu' + 'sh[\'"]', '[\'"]-' + 'A[\'"]', '[\'"]--' + 'global[\'"]'].join('|'))); if (m) bad.push(path.relative(H.KIT, p) + ': ' + m[0]); } } })(path.join(H.KIT, 'modules'));
  ok('в скриптах ядра, навыков и модулей нет вызовов отправки (push), добавления всего подряд (-A) и общей настройки git', bad.length === 0, bad.join('; '));

  // корень внутри чужого репозитория с проиндексированными файлами: git-init отказывает, индекс чужого побайтно тот же
  r = wpPkg(['init', '--root', R3, '--main', 'claude', '--no-scan'], { cwd: TMP });
  ok('init третьего корня', r.code === 0, r.all);
  r = wpIn(R3, ['layout']); ok('layout третьего корня', r.code === 0, r.all);
  const INNER = path.join(PRJ, 'inner-root');
  fs.renameSync(R3, INNER);                               // теперь главная папка лежит внутри чужого репозитория (как если бы человек перенёс её сам)
  const prjIdx0 = H.repoState(PRJ, ENV);
  const lsFiles0 = H.git(PRJ, ['ls-files', '-s'], ENV).out;
  const outer0 = H.treeMap(PRJ, ['inner-root']);
  r = wpIn(INNER, ['git-init'], { cwd: INNER });
  ok('git-init внутри чужого репозитория: отказ (код 3), «внутри чужого репозитория»', r.code === 3 && /внутри чужого репозитория/.test(r.all), r.all);
  for (const a of [['gitignore', 'check'], ['verify', 'P2.git'], ['report']]) wpIn(INNER, a, { cwd: INNER });
  const prjIdx1 = H.repoState(PRJ, ENV);
  ok('чужой репозиторий: git diff --cached побайтно тот же (' + prjIdx0.cached.length + ' байт), stash, HEAD, настройки и список индекса те же', prjIdx1.cached === prjIdx0.cached && prjIdx1.stash === prjIdx0.stash && prjIdx1.head === prjIdx0.head && prjIdx1.config === prjIdx0.config && H.git(PRJ, ['ls-files', '-s'], ENV).out === lsFiles0, JSON.stringify(Object.keys(prjIdx0).filter((k) => prjIdx0[k] !== prjIdx1[k])));
  ok('файлы чужого проекта вне inner-root байт-в-байт те же', same(outer0, H.treeMap(PRJ, ['inner-root'])), H.mapDiffText(outer0, H.treeMap(PRJ, ['inner-root'])));
  fs.renameSync(INNER, R3);                               // вернули: дальше проект снова как был
  ok('после возврата папки чужой проект снова байт-в-байт как в самом начале', prjUnchanged() && JSON.stringify(H.repoState(PRJ, ENV)) === JSON.stringify(prjState0));

  // свои проиндексированные файлы пользователя в репозитории главной папки: git-init не коммитит и не сбрасывает их
  r = wpPkg(['init', '--root', R4, '--main', 'codex', '--no-scan']);
  ok('init четвёртого корня (основной Codex)', r.code === 0, r.all);
  wpIn(R4, ['layout']);
  H.run('git', ['init', '-q', '-b', 'main', R4], { env: ENV });
  H.write(path.join(R4, 'stray.txt'), 'чьё-то\n'); H.git(R4, ['add', 'stray.txt'], ENV);
  const cached4 = H.git(R4, ['diff', '--cached'], ENV).out;
  r = wpIn(R4, ['git-init']);
  ok('git-init при чужих файлах в индексе: отказ (код 3), индекс побайтно тот же, коммита нет', r.code === 3 && H.git(R4, ['diff', '--cached'], ENV).out === cached4 && H.git(R4, ['rev-list', '--count', 'HEAD'], ENV).code !== 0, r.all);

  // ================= запись вне корня: параметры путей не принимаются =================
  S.section('Параметры путей вне корня отвергаются');
  const victim = path.join(PRJ, 'README.md'), victimText = H.read(victim);
  const evil = [
    ['layout --root <проект>', ['layout', '--root', PRJ], 3],
    ['report --out <файл проекта>', ['report', '--out', victim], 2],
    ['snapshot after --root <проект>', ['snapshot', 'after', '--root', PRJ], 3],
    ['state declare без ~/', ['state', 'declare', PRJ], 2],
    ['module add <проект без module.json>', ['module', 'add', PRJ], 2],
  ];
  for (const [label, args, code] of evil) {
    r = wpIn(ROOT, args, { cwd: PRJ });
    ok('отказ (код ' + code + '): ' + label + '; проект и его README байт-в-байт те же', r.code === code && H.read(victim) === victimText && prjUnchanged(), r.all);
  }
  r = wpIn(ROOT, ['new-workspace', '../../Projects/lead-agent/x'], { cwd: PRJ });
  ok('new-workspace с «../» в имени: папка создаётся только внутри workspaces/, чужое не тронуто', r.code === 0 && fs.readdirSync(path.join(ROOT, 'workspaces')).some((n) => /lead-agent/.test(n)) && prjUnchanged(), r.all);
  r = H.node(path.join(ROOT, '.workplace', 'modules', 'migrate-project', 'migrate-project.js'), ['copy', PRJ, '--root', PRJ, '--yes'], { cwd: PRJ, env: ENV });
  ok('migrate-project --root отвергается, ничего не скопировано, проект тот же', r.code !== 0 && prjUnchanged() && !H.exists(path.join(ROOT, 'projects', 'lead-agent')), r.all);
  r = H.node(path.join(ROOT, '.workplace', 'modules', 'migrate-project', 'migrate-project.js'), ['copy', PRJ, '--name', 'lead-agent'], { cwd: PRJ, env: ENV });
  ok('migrate-project copy без второго «да» (--yes): только план, код 2, ничего не скопировано', r.code === 2 && !H.exists(path.join(ROOT, 'projects', 'lead-agent')) && prjUnchanged(), r.all);

  // ================= К19-К20: записи вне корня по трём классам =================
  S.section('К19-К20. Записи вне корня: после «да» объявлены, без «да» тревога');
  r = wpIn(ROOT, ['snapshot', 'diff', '--live', '--json'], { cwd: PRJ });
  let dj = null; try { dj = JSON.parse(r.out); } catch (_) { /* ниже */ }
  ok('после всей установки без установок программ: класса A нет, код 0', r.code === 0 && dj && !dj.alarm, r.all);
  // штатная запись самой программы: Codex переписал файл входа и записал сессию
  H.write(H2('.codex', 'auth.json'), '{"fake":"TOKEN-ROTATED-67890"}\n'); H.write(H2('.codex', 'sessions', '2026', '10', '21', 'rollout-x.jsonl'), '{}\n');
  H.write(H2('.claude', 'projects', 'c--x', 'chat.jsonl'), '{}\n');
  r = wpIn(ROOT, ['snapshot', 'diff', '--live', '--json'], { cwd: PRJ }); dj = null; try { dj = JSON.parse(r.out); } catch (_) { /* ниже */ }
  ok('~/.codex/auth.json, сессии и история чатов Claude: класс B (штатно), тревоги нет, код 0, содержимое файла входа не напечатано', r.code === 0 && dj && !dj.alarm && dj.classes.B.length >= 1 && !r.out.includes('TOKEN-ROTATED'), r.all);
  // установщик программы дописал PATH в профиль: без объявления тревога, после «да» и state declare объявлено
  fs.appendFileSync(H2('.zprofile'), 'export PATH="$HOME/.local/bin:$PATH"  # дописал установщик\n');
  r = wpIn(ROOT, ['snapshot', 'diff', '--live'], { cwd: PRJ });
  ok('запись в профиль без объявления: класс A, ТРЕВОГА, код 1', r.code === 1 && /\[A\]/.test(r.out) && /\.zprofile/.test(r.out), r.all);
  r = wpIn(ROOT, ['state', 'declare', '~/.zprofile'], { cwd: PRJ }); ok('state declare ~/.zprofile', r.code === 0, r.all);
  r = wpIn(ROOT, ['snapshot', 'diff', '--live', '--json'], { cwd: PRJ }); dj = null; try { dj = JSON.parse(r.out); } catch (_) { /* ниже */ }
  ok('та же запись после объявления: класс D, тревоги нет, код 0', r.code === 0 && dj && !dj.alarm && dj.classes.D.some((x) => /zprofile/.test(x.id)), r.all);
  // модуль vscode по «да»: ключ claudeCode.focusView
  H.humanSays(ROOT, 'да, включи focus view в VS Code', ENV);
  r = H.node(path.join(ROOT, '.workplace', 'modules', 'vscode', 'focus-view.js'), ['apply', '--yes'], { cwd: PRJ, env: ENV });
  ok('модуль vscode apply --yes: код 0, включён claudeCode.focusView', r.code === 0 && /claudeCode\.focusView/.test(fs.readFileSync(H2(...VSC), 'utf8')), r.all);
  r = wpIn(ROOT, ['snapshot', 'diff', '--live', '--json'], { cwd: PRJ }); dj = null; try { dj = JSON.parse(r.out); } catch (_) { /* ниже */ }
  ok('запись модуля vscode (ключ claudeCode.focusView): объявленная запись установщика, класс D, тревоги нет, код 0', r.code === 0 && dj && !dj.alarm && dj.classes.D.some((x) => /settings\.json/.test(x.id) && /focusView/.test(x.note || '')), r.all);
  fs.writeFileSync(H2(...VSC), fs.readFileSync(H2(...VSC), 'utf8').replace('"editor.fontSize": 15', '"editor.fontSize": 18'));
  r = wpIn(ROOT, ['snapshot', 'diff', '--live', '--json'], { cwd: PRJ }); dj = null; try { dj = JSON.parse(r.out); } catch (_) { /* ниже */ }
  ok('другой ключ в том же файле (размер шрифта) правил человек: класс C («это вы меняли?»), код 0; ключ модуля остаётся объявленным', r.code === 0 && dj && !dj.alarm && dj.classes.C.some((x) => /settings\.json/.test(x.id) && /editor\.fontSize/.test(x.note || '')) && !/fontSize": 18/.test(r.out), r.all);
  fs.writeFileSync(H2(...VSC), fs.readFileSync(H2(...VSC), 'utf8').replace('{', '{\n  "claude.somethingElse": true,'));
  r = wpIn(ROOT, ['snapshot', 'diff', '--live', '--json'], { cwd: PRJ }); dj = null; try { dj = JSON.parse(r.out); } catch (_) { /* ниже */ }
  ok('чужой ключ, похожий на наш и не объявленный: класс A, ТРЕВОГА, код 1', r.code === 1 && dj && dj.alarm && dj.classes.A.some((x) => /somethingElse/.test(x.note || '')), r.all);
  fs.appendFileSync(H2('.zshrc'), 'export SOME_TOKEN=abcdef0123456789abcdef  # дописал неизвестно кто\n');
  r = wpIn(ROOT, ['snapshot', 'diff', '--live'], { cwd: PRJ });
  ok('запись в ~/.zshrc без объявления: тревога, значение токена в выводе не показано', r.code === 1 && /\.zshrc/.test(r.out) && !r.out.includes('abcdef0123456789abcdef'), r.all);
  const sums1 = personalSums();
  const changed = Object.keys(sums00).filter((k) => sums00[k] !== sums1[k]).sort();
  const expectChanged = [path.join('.codex', 'auth.json'), path.join(...VSC), '.zprofile', '.zshrc'].sort();
  ok('изменились только файлы, которые этот тест менял сам (файл входа Codex, настройки VS Code, .zprofile, .zshrc); .gitconfig, ~/.claude/*, ~/.codex/config.toml и AGENTS.md те же', JSON.stringify(changed) === JSON.stringify(expectChanged), JSON.stringify(changed));
  ok('ловушка во временной папке ОС (TEMP) по итогам всего прогона не тронута', H.treeHash(TRAP) === trapHash0);
  ok('чужой проект с .git и старый проект по итогам всего прогона байт-в-байт те же', prjUnchanged() && JSON.stringify(H.repoState(PRJ, ENV)) === JSON.stringify(prjState0));
} catch (e) {
  ok('прогон дошёл до конца без исключения', false, e && e.stack);
} finally {
  H.rmTree(TMP);
}
process.exit(S.finish());
