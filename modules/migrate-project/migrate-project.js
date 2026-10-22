#!/usr/bin/env node
'use strict';
// Модуль migrate-project: перенос существующего проекта в главную папку. Основа: future/adopt.js из v3.
// Только встроенные модули Node 18+. Mac и Windows.
//
//   node migrate-project.js inspect <папка проекта> [--json]
//       только чтение: что за проект и что нужно учесть. Работает откуда угодно и ничего не пишет.
//   node migrate-project.js copy <папка проекта> [--name имя] [--include-heavy] [--yes]
//       без --yes: только план (код 2). С --yes (это второе, отдельное «да» человека): резервная копия, копия в <главная папка>/projects/<имя>, сверка.
//   node migrate-project.js verify <папка проекта> [--name имя] [--full]
//       сверка копии с исходником и проверка .gitignore главной папки
//
// Главная папка определяется по расположению скрипта: <главная папка>/.workplace/modules/migrate-project/migrate-project.js. Параметра «куда писать» нет.
// Исходная папка НЕ изменяется и НЕ удаляется. Внутрь проекта ничего не добавляется.
// Копия содержит всё, что есть в исходнике: историю git, ветки, удалённые адреса, незакоммиченные правки (они так и остаются незакоммиченными: ничего не коммитится).
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');

const BOOL = new Set(['include-heavy', 'yes', 'json', 'full']);
const VALUE = new Set(['name']);
const HEAVY = ['node_modules', '.venv', 'venv', '__pycache__', '.next', '.nuxt', '.cache', '.gradle', 'target', '.pytest_cache', '.mypy_cache', '.parcel-cache', '.turbo'];
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const FULL_LIMIT_FILES = 5000;
const FULL_LIMIT_BYTES = 500 * 1e6;

function say(s) { process.stdout.write(s + '\n'); }
function die(s, code) { process.stderr.write(s + '\n'); process.exit(code || 1); }
function exists(p) { try { fs.accessSync(p); return true; } catch (_) { return false; } }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } }
function sha(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function shaFile(p) { const h = crypto.createHash('sha256'); const fd = fs.openSync(p, 'r'); const b = Buffer.alloc(1 << 20); try { for (;;) { const n = fs.readSync(fd, b, 0, b.length, null); if (!n) break; h.update(b.subarray(0, n)); } } finally { fs.closeSync(fd); } return h.digest('hex'); }
function lines(s) { return s ? s.split(/\r?\n/) : []; }
function human(n) { return n > 1e9 ? (n / 1e9).toFixed(1) + ' ГБ' : n > 1e6 ? (n / 1e6).toFixed(0) + ' МБ' : Math.max(1, Math.round(n / 1e3)) + ' КБ'; }
function slugify(n) { return String(n).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
function stamp() { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()); }
function norm(p) { let r = path.resolve(p); try { r = fs.realpathSync.native(r); } catch (_) {} return IS_CI ? r.toLowerCase() : r; }
const IS_CI = process.platform === 'win32' || process.platform === 'darwin';
function within(base, p) { const rel = path.relative(norm(base), norm(p)); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); }
function tilde(p) { const h = os.homedir().replace(/\\/g, '/'); const q = String(p).replace(/\\/g, '/'); return q.toLowerCase().startsWith(h.toLowerCase() + '/') ? '~' + q.slice(h.length) : q; }
// Адрес без логина и пароля
function cleanUrl(u) { return String(u).replace(/^([a-z+]+:\/\/)[^@/]*@/i, '$1'); }

function git(repo, args, timeout) {
  const r = cp.spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: timeout || 30000, windowsHide: true, env: Object.assign({}, process.env, { GIT_OPTIONAL_LOCKS: '0' }), maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: String(r.stdout || '').replace(/\r?\n$/, ''), err: String(r.stderr || '').trim() };
}

function parseArgs(argv) {
  const flags = {}, pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const k = a.slice(2);
    if (BOOL.has(k)) flags[k] = true;
    else if (VALUE.has(k)) { if (i + 1 >= argv.length) die('У параметра --' + k + ' нет значения. Ничего не сделано.', 2); flags[k] = argv[++i]; }
    else die('Неизвестный параметр ' + a + '. Путей записи у этой команды нет: главная папка определяется по расположению скрипта. Ничего не сделано.', 2);
  }
  return { flags, pos };
}

// Главная папка: <корень>/.workplace/modules/migrate-project/migrate-project.js. Иначе null.
function rootByScript() {
  if (path.basename(path.resolve(__dirname, '..', '..')) !== '.workplace') return null;
  const root = path.resolve(__dirname, '..', '..', '..');
  const wp = path.join(root, '.workplace');
  return exists(path.join(wp, 'config.json')) || exists(path.join(wp, 'state.json')) ? root : null;
}
function needRoot() {
  const root = rootByScript();
  if (!root) die('Эта команда запускается только из главной папки: .workplace/modules/migrate-project/migrate-project.js (копия пакета в ней появилась при init). Из пакета она ничего не пишет. Ничего не сделано.', 3);
  return root;
}
// Имя папки проекта: только латиница в нижнем регистре, цифры и дефис; результат обязан лежать внутри <корень>/projects
function checkedDst(root, name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) die('Имя папки «' + name + '» не подходит: можно только латинские строчные буквы, цифры и дефис, без точек, слэшей и пробелов (например, lead-agent). Ничего не скопировано. Задай другое имя через --name.', 2);
  const dst = path.join(root, 'projects', name);
  const rel = path.relative(path.resolve(root, 'projects'), path.resolve(dst));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) die('Имя папки «' + name + '» выводит копию за пределы projects/. Ничего не скопировано. Задай другое имя через --name.', 2);
  return dst;
}

// ---------- замеры ----------
// Размер папки и крупные файлы, с пропуском тяжёлых папок (если skipHeavy). Счётчик ограничен по времени: partial = true, если не успел.
function measure(dir, skipHeavy) {
  let size = 0, files = 0, partial = false; const symlinks = [], big = [], heavy = new Set();
  const deadline = Date.now() + 20000;
  (function walk(d) {
    if (Date.now() > deadline) { partial = true; return; }
    let items = [];
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const it of items) {
      const p = path.join(d, it.name);
      if (it.isSymbolicLink()) { let t = ''; try { t = fs.readlinkSync(p); } catch (_) { /* нет */ } symlinks.push(path.relative(dir, p).split(path.sep).join('/') + ' -> ' + t); continue; }
      if (it.isDirectory()) {
        if (it.name === '.git') continue;
        if (HEAVY.includes(it.name)) { heavy.add(path.relative(dir, p).split(path.sep).join('/')); if (skipHeavy) continue; }
        walk(p); continue;
      }
      let st; try { st = fs.statSync(p); } catch (_) { continue; }
      size += st.size; files++;
      if (st.size > 50 * 1e6) big.push(path.relative(dir, p).split(path.sep).join('/') + ' (' + human(st.size) + ')');
    }
  })(dir);
  return { size, files, symlinks, big, heavy: [...heavy], partial };
}
function dirSize(dir) { let t = 0; (function w(d) { let it = []; try { it = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; } for (const e of it) { const p = path.join(d, e.name); if (e.isDirectory()) w(p); else if (e.isFile()) { try { t += fs.statSync(p).size; } catch (_) { /* нет */ } } } })(dir); return t; }

// ---------- inspect ----------
function inspect(src) {
  if (!src || !exists(src)) die('Нет такой папки: ' + src, 2);
  src = path.resolve(src);
  const r = { path: tilde(src), blockers: [], warnings: [], info: [] };
  const dotGit = path.join(src, '.git');
  let isRepo = false;
  if (exists(dotGit)) {
    if (fs.statSync(dotGit).isFile()) r.blockers.push('.git здесь файл, а не папка: это подмодуль или дополнительное рабочее дерево. Копия потеряла бы связь с историей. Не переношу.');
    else isRepo = true;
  } else {
    const top = git(src, ['rev-parse', '--show-toplevel']);
    if (top.ok) r.blockers.push('Папка лежит внутри репозитория ' + tilde(top.out) + ': перенос подпапки потерял бы историю. Назови корень репозитория.');
    else r.info.push('Это не git-проект (папки .git нет): скопирую файлы как есть, истории нет.');
  }
  r.is_repo = isRepo;
  if (isRepo) {
    const top = git(src, ['rev-parse', '--show-toplevel']);
    if (top.ok && norm(top.out) !== norm(src)) r.blockers.push('Корень репозитория ' + tilde(top.out) + ' не совпадает с этой папкой.');
    r.head = git(src, ['rev-parse', 'HEAD']).out || null;
    r.branch = git(src, ['rev-parse', '--abbrev-ref', 'HEAD']).out || null;
    r.upstream = git(src, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).out || null;
    r.remotes = lines(git(src, ['remote', '-v']).out).filter((l) => /\(fetch\)/.test(l)).map((l) => { const [n, u] = l.split(/\s+/); return n + ' ' + cleanUrl(u); });
    const st = lines(git(src, ['status', '--porcelain']).out);
    r.changed = st.filter((l) => !l.startsWith('??')).map((l) => l.trim());
    r.untracked = st.filter((l) => l.startsWith('??')).length;
    r.stashes = lines(git(src, ['stash', 'list']).out).length;
    r.in_progress = ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'BISECT_LOG'].filter((n) => exists(path.join(dotGit, n)));
    r.worktrees = Math.max(0, lines(git(src, ['worktree', 'list']).out).length - 1);
    r.submodules = exists(path.join(src, '.gitmodules'));
    r.lfs = /filter=lfs/.test(exists(path.join(src, '.gitattributes')) ? fs.readFileSync(path.join(src, '.gitattributes'), 'utf8') : '');
    r.custom_hooks = (() => { try { return fs.readdirSync(path.join(dotGit, 'hooks')).filter((n) => !n.endsWith('.sample')); } catch (_) { return []; } })();
    r.core_worktree = git(src, ['config', '--get', 'core.worktree']).out || null;
    if (r.core_worktree) r.blockers.push('В настройках git этого проекта задан core.worktree (' + tilde(r.core_worktree) + '): репозиторий привязан к конкретной папке. Копия продолжила бы работать со старой папкой, и коммит из копии задел бы исходный проект. Что это значит: переносить такой проект нельзя. Что делать: ничего, проект остаётся на месте и работает как раньше. Если перенос нужен, настройку может убрать только владелец проекта (команда git config --unset core.worktree в его папке); без его «да» я её не трогаю.');
    r.git_size = dirSize(dotGit);
    if (r.in_progress.length) r.warnings.push('Идёт слияние, перебазирование или другая операция git (' + r.in_progress.join(', ') + '). Копия сохранит это состояние как есть.');
    if (r.changed.length || r.untracked) r.warnings.push('Есть незакоммиченные правки: изменено ' + r.changed.length + ', новых файлов ' + r.untracked + '. Они скопируются как есть и останутся незакоммиченными. Я их не коммичу.');
    if (r.stashes) r.warnings.push('В репозитории отложенных правок (stash): ' + r.stashes + '. Они лежат внутри .git и скопируются.');
    if (r.worktrees) r.warnings.push('У проекта есть дополнительные рабочие деревья (' + r.worktrees + '): они не копируются.');
    if (r.submodules) r.warnings.push('Есть подмодули (.gitmodules): их содержимое скопируется, но проверь после переноса, что они на месте.');
    if (r.lfs) r.warnings.push('Используется Git LFS: большие файлы могут быть только указателями; на новом месте может понадобиться git lfs pull.');
    if (r.custom_hooks.length) r.warnings.push('У проекта свои git-хуки (' + r.custom_hooks.join(', ') + '): скопируются; если они ссылаются на абсолютные пути, на новом месте могут не сработать.');
    if (!r.remotes.length) r.info.push('Удалённых адресов у проекта нет (GitHub не подключён).');
    const tracked = lines(git(src, ['ls-files']).out);
    r.tracked_files = tracked.length;
    r.tracked_secret_like = tracked.filter((f) => /(^|\/)\.env($|\.(?!example$))|\.pem$|\.key$|id_rsa|credentials/i.test(f));
    if (r.tracked_secret_like.length) r.warnings.push('В git отслеживаются файлы, похожие на секреты: ' + r.tracked_secret_like.slice(0, 5).join(', ') + '. Это уже в истории; перенос ничего не усугубляет, но сообщи человеку.');
  }
  r.ai_files = { claude_md: exists(path.join(src, 'CLAUDE.md')), agents_md: exists(path.join(src, 'AGENTS.md')), dot_claude: exists(path.join(src, '.claude')), gitignore: exists(path.join(src, '.gitignore')) };
  r.env_files = (() => { try { return fs.readdirSync(src).filter((n) => /^\.env($|\.)/.test(n) && n !== '.env.example'); } catch (_) { return []; } })();
  if (isRepo && r.env_files.length) {
    r.env_state = r.env_files.map((f) => ({ file: f, ignored: git(src, ['check-ignore', '-q', f]).ok, tracked: git(src, ['ls-files', '--error-unmatch', f]).ok }));
    r.env_state.filter((e) => !e.ignored && !e.tracked).forEach((e) => r.warnings.push(e.file + ' не игнорируется git: он может попасть в коммит. Предложи человеку добавить строку в .gitignore проекта (его правка, только с «да»).'));
    r.env_state.filter((e) => e.tracked).forEach((e) => r.warnings.push(e.file + ' уже отслеживается git: ключи в истории.'));
  }
  if (r.ai_files.claude_md) r.info.push('У проекта есть свой CLAUDE.md: он сохранится и будет работать, когда Claude читает файлы проекта. Не переписываю.');
  const m = measure(src, isRepo);
  r.size = m.size; r.files = m.files; r.big_files = m.big; r.symlinks = m.symlinks; r.heavy_dirs = m.heavy; r.size_partial = m.partial;
  if (m.partial) r.warnings.push('Замер размера не закончен за отведённое время: цифры ниже занижены.');
  if (m.big.length) r.warnings.push('Крупные файлы (больше 50 МБ): ' + m.big.slice(0, 5).join(', '));
  if (m.symlinks.length) r.warnings.push('Символические ссылки (' + m.symlinks.length + '): копируются как ссылки; ведущие наружу папки могут не заработать. Например: ' + m.symlinks.slice(0, 3).join('; '));
  if (m.heavy.length) r.info.push('Тяжёлые папки (' + m.heavy.join(', ') + '): ' + (isRepo ? 'если git их игнорирует, не копирую (восстанавливаются установкой зависимостей)' : 'в проекте без git копирую всё, как есть') + '. Параметр --include-heavy копирует их тоже.');
  r.info.push('Claude Code хранит историю чатов по пути папки: чаты, начатые в старой папке, в новой не появятся. Память проекта (CLAUDE.md) переносится вместе с файлами.');
  return r;
}

function printInspect(r) {
  say('Проект: ' + r.path);
  say('git: ' + (r.is_repo ? 'да, ветка ' + r.branch + ', коммит ' + String(r.head).slice(0, 8) + ', отслеживается файлов ' + r.tracked_files + ', .git ' + human(r.git_size) : 'нет'));
  if (r.is_repo) say('Удалённые адреса: ' + (r.remotes.join('; ') || 'нет') + (r.upstream ? '; ветка следит за ' + r.upstream : ''));
  if (r.is_repo) say('Незакоммичено: изменено ' + r.changed.length + ', новых ' + r.untracked + '; отложено (stash) ' + r.stashes);
  say('Файлов (без тяжёлых папок): ' + r.files + ', объём ' + human(r.size));
  say('CLAUDE.md: ' + (r.ai_files.claude_md ? 'есть' : 'нет') + '; AGENTS.md: ' + (r.ai_files.agents_md ? 'есть' : 'нет') + '; .claude/: ' + (r.ai_files.dot_claude ? 'есть' : 'нет') + '; .gitignore: ' + (r.ai_files.gitignore ? 'есть' : 'нет'));
  if (r.env_files.length) say('Файлы ключей рядом: ' + r.env_files.join(', ') + ' (значения не читаю)');
  r.blockers.forEach((b) => say('СТОП: ' + b));
  r.warnings.forEach((w) => say('Внимание: ' + w));
  r.info.forEach((w) => say('К сведению: ' + w));
}

// ---------- состояние исходника ----------
// Быстрый отпечаток файлов (имя, размер, время изменения с точностью до секунды) без .git и без тяжёлых папок: ловит правки в исходнике во время копирования. Содержимое не читается.
function fingerprint(dir) {
  const rows = [];
  (function walk(d) {
    let items = [];
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const it of items) {
      const p = path.join(d, it.name);
      if (it.isDirectory()) { if (d === dir && it.name === '.git') continue; if (HEAVY.includes(it.name)) continue; walk(p); continue; }
      let st; try { st = fs.lstatSync(p); } catch (_) { continue; }
      rows.push([path.relative(dir, p).split(path.sep).join('/'), st.size, Math.floor(st.mtimeMs / 1000)]);
    }
  })(dir);
  rows.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return sha(Buffer.from(JSON.stringify(rows)));
}
function snapshot(dir, isRepo) {
  const s = { repo: !!isRepo, files: fingerprint(dir) };
  if (!isRepo) return s;
  return Object.assign(s, {
    head: git(dir, ['rev-parse', 'HEAD']).out, branch: git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).out,
    status: sha(Buffer.from(git(dir, ['status', '--porcelain']).out)), stash: sha(Buffer.from(git(dir, ['stash', 'list']).out)),
    remotes: sha(Buffer.from(git(dir, ['remote', '-v']).out)),
  });
}

// ---------- копирование и сверка деревьев ----------
// Копия дерева. Возвращает список пропущенных тяжёлых папок. В проекте без git тяжёлые папки копируются тоже: там нельзя понять, восстановимы ли они.
function copyTree(src, dst, isRepo, includeHeavy) {
  const skipped = [];
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, {
    recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false, preserveTimestamps: true,
    filter: (s) => {
      const b = path.basename(s);
      if (isRepo && !includeHeavy && HEAVY.includes(b) && fs.statSync(s).isDirectory()) {
        const relp = path.relative(src, s).split(path.sep).join('/');
        if (git(src, ['check-ignore', '-q', relp]).ok) { skipped.push(relp); return false; }
      }
      return true;
    },
  });
  return skipped;
}
// Карта файлов дерева: относительный путь → { t: 'f', size } или { t: 'l', target }. Верхний .git и пропущенные папки не входят.
function listTree(dir, skip) {
  const map = new Map();
  (function walk(d) {
    let items = [];
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const it of items) {
      const p = path.join(d, it.name);
      const rel = path.relative(dir, p).split(path.sep).join('/');
      if (d === dir && it.name === '.git') continue;
      if (skip.some((s) => rel === s || rel.startsWith(s + '/'))) continue;
      if (it.isSymbolicLink()) { let t = ''; try { t = fs.readlinkSync(p); } catch (_) { /* нет */ } map.set(rel, { t: 'l', target: t }); continue; }
      if (it.isDirectory()) { walk(p); continue; }
      let st; try { st = fs.statSync(p); } catch (_) { continue; }
      map.set(rel, { t: 'f', size: st.size });
    }
  })(dir);
  return map;
}
// Сверка двух деревьев. must: файлы, которые сверяются по содержимому всегда (изменённые и новые).
function compareTrees(a, b, skip, o) {
  o = o || {};
  const A = listTree(a, skip), B = listTree(b, skip);
  const missing = [], extra = [], differ = [];
  for (const [k, v] of A) { const w = B.get(k); if (!w) missing.push(k); else if (v.t !== w.t || (v.t === 'l' && v.target !== w.target) || (v.t === 'f' && v.size !== w.size)) differ.push(k); }
  for (const k of B.keys()) if (!A.has(k)) extra.push(k);
  const files = [...A.keys()].filter((k) => A.get(k).t === 'f' && B.has(k) && B.get(k).t === 'f' && !differ.includes(k));
  const total = files.reduce((s, k) => s + A.get(k).size, 0);
  const all = o.full || (files.length <= FULL_LIMIT_FILES && total <= FULL_LIMIT_BYTES);
  const pick = new Set(o.must || []);
  const step = Math.max(1, Math.floor(files.length / 300));
  files.forEach((k, i) => { if (all || pick.has(k) || i % step === 0) pick.add(k); });
  let checked = 0;
  for (const k of files) {
    if (!pick.has(k)) continue;
    checked++;
    try { if (shaFile(path.join(a, k)) !== shaFile(path.join(b, k))) differ.push(k); } catch (_) { differ.push(k); }
  }
  return { missing, extra, differ, checked, count: A.size, mode: all ? 'все файлы' : 'выборка' };
}

// ---------- verify ----------
function latestRecord(root, name) {
  const base = path.join(root, '.workplace', 'backup-update');
  let dirs = [];
  try { dirs = fs.readdirSync(base).filter((n) => n.startsWith('migrate-' + name + '-')).sort(); } catch (_) { /* нет */ }
  if (!dirs.length) return null;
  const dir = path.join(base, dirs[dirs.length - 1]);
  const rec = readJson(path.join(dir, 'record.json'));
  return rec ? Object.assign({ dir }, rec) : null;
}

function verify(root, src, nameArg, o) {
  o = o || {};
  src = path.resolve(src);
  const name = nameArg || slugify(path.basename(src));
  const dst = checkedDst(root, name);
  let bad = 0;
  const chk = (ok, text) => { if (!ok) bad++; say('[' + (ok ? 'ok' : 'НЕТ') + '] ' + text); };
  if (!exists(dst)) die('Нет копии projects/' + name, 3);
  const isRepo = exists(path.join(src, '.git'));
  const rec = latestRecord(root, name) || {};
  const skipped = rec.skipped || [];
  const cur = snapshot(src, isRepo);
  if (isRepo) {
    const b = snapshot(dst, true);
    chk(cur.head === b.head, 'тот же последний коммит: ' + String(b.head).slice(0, 8));
    chk(cur.branch === b.branch, 'та же ветка: ' + b.branch);
    chk(cur.remotes === b.remotes, 'те же удалённые адреса (GitHub и другие): ' + (lines(git(dst, ['remote', '-v']).out).filter((l) => /fetch/.test(l)).map((l) => { const p = l.split(/\s+/); return p[0] + ' ' + cleanUrl(p[1]); }).join('; ') || 'нет'));
    chk(cur.status === b.status, 'тот же список незакоммиченных правок (копия не закоммичена, ничего не потеряно)');
    chk(cur.stash === b.stash, 'те же отложенные правки (stash)');
    const fsck = git(dst, ['fsck', '--connectivity-only', '--no-dangling'], 120000);
    chk(fsck.ok, 'история цела (git fsck): ' + (fsck.ok ? 'без ошибок' : fsck.err.slice(0, 160)));
    chk(lines(git(src, ['ls-files']).out).length === lines(git(dst, ['ls-files']).out).length, 'число отслеживаемых файлов то же: ' + lines(git(dst, ['ls-files']).out).length);
  } else chk(true, 'не git-проект: проверка истории не нужна');
  if (rec.before) chk(rec.before.files === cur.files && (!isRepo || (rec.before.head === cur.head && rec.before.status === cur.status)), 'исходная папка не менялась с момента копирования');
  else say('[--] записи о копировании нет: «исходная папка не менялась» проверить нельзя');
  const must = isRepo ? lines(git(src, ['status', '--porcelain']).out).map((l) => l.slice(3).replace(/^"|"$/g, '').split(' -> ').pop()) : [];
  const cmp = compareTrees(src, dst, skipped, { must, full: o.full });
  chk(!cmp.missing.length && !cmp.extra.length, 'состав файлов совпадает (' + cmp.count + ' в исходнике)' + (cmp.missing.length ? '; нет в копии: ' + cmp.missing.slice(0, 5).join(', ') : '') + (cmp.extra.length ? '; лишние в копии: ' + cmp.extra.slice(0, 5).join(', ') : ''));
  chk(!cmp.differ.length, 'содержимое файлов совпадает (сверено ' + cmp.checked + ': ' + cmp.mode + ')' + (cmp.differ.length ? '; отличаются: ' + cmp.differ.slice(0, 5).join(', ') : ''));
  chk(!cmp.extra.length, 'в проект не добавлено ни одного нового файла');
  if (rec.backup) {
    const bk = path.join(root, rec.backup);
    if (exists(bk)) { const bc = compareTrees(bk, dst, skipped, { full: o.full }); chk(!bc.missing.length && !bc.extra.length && !bc.differ.length, 'копия совпадает с резервной копией, сделанной до переноса' + (bc.differ.length ? ' (отличаются: ' + bc.differ.slice(0, 3).join(', ') + ')' : '')); }
    else say('[--] резервной копии ' + rec.backup + ' уже нет (её удалили): сверять не с чем');
  }
  // .gitignore главной папки: git корня не должен видеть проект и служебные файлы
  if (exists(path.join(root, '.git'))) {
    const probes = ['projects/' + name + '/any.file', '.env', 'checks/x/input/y.md', 'checks/x/manifest.json', '.workplace/state.json', '.workplace/backup-update/x', 'install-report.md'];
    const notIgnored = probes.filter((f) => !git(root, ['check-ignore', '-q', f]).ok);
    chk(!notIgnored.length, 'git главной папки игнорирует проект и служебные файлы' + (notIgnored.length ? ' (НЕ игнорирует: ' + notIgnored.join(', ') + ')' : ''));
    const leak = lines(git(root, ['status', '--porcelain', '--', 'projects']).out);
    chk(!leak.length, 'git главной папки не видит файлов проекта');
  }
  // рекомендации по .gitignore самого проекта (не применяются)
  if (isRepo) {
    const gi = exists(path.join(dst, '.gitignore')) ? fs.readFileSync(path.join(dst, '.gitignore'), 'utf8').split(/\r?\n/).map((l) => l.trim()) : [];
    const missingGi = ['.env', '.env.*', '.claude/settings.local.json', '.DS_Store'].filter((w) => !gi.includes(w) && !(w === '.env.*' && gi.includes('.env*')));
    if (missingGi.length) say('Совет (не применено): в .gitignore проекта нет строк ' + missingGi.join(', ') + '. Если человек хочет, добавь их отдельной правкой с его «да»: это правка его проекта.');
  }
  if (bad) { process.exitCode = 1; say('Сверка нашла расхождения (' + bad + '). Исходную папку я не менял.'); }
  else say('Проверка переноса пройдена. Исходную папку установщик не трогал и не удалял: удалять её можно только самому человеку, когда убедится, что всё работает.');
  return bad === 0;
}

// ---------- copy ----------
function logToState(root, text) {
  const wp = path.join(root, '.workplace', 'core', 'cli', 'wp.js');
  if (!exists(wp)) { say('Запиши в журнал сам: ' + text); return; }
  const r = cp.spawnSync(process.execPath, [wp, 'state', 'log', text], { cwd: root, encoding: 'utf8', timeout: 20000, windowsHide: true });
  if (r.status !== 0) say('В журнал записать не удалось. Запиши сам: ' + text);
}

function copy(src, flags) {
  const r = inspect(src);
  printInspect(r);
  if (r.blockers.length) die('Перенос невозможен, см. СТОП выше.', 3);
  src = path.resolve(src);
  const root = needRoot();
  if (within(root, src)) die('Проект уже внутри главной папки: переносить нечего. Ничего не сделано.', 3);
  if (within(src, root)) die('Главная папка лежит внутри этого проекта: копия проекта в главную папку скопировала бы саму себя. Ничего не сделано.', 3);
  const name = 'name' in flags ? flags.name : slugify(path.basename(src));
  if (!name) die('Не получилось придумать имя папки: задай --name (латиница, цифры, дефис). Ничего не сделано.', 2);
  const dst = checkedDst(root, name);
  if (exists(dst)) die('projects/' + name + ' уже есть. Не перезаписываю: выбери другое имя (--name). Ничего не сделано.', 3);
  const gitBytes = r.is_repo ? r.git_size : 0;
  const need = Math.round(((r.size + gitBytes) * 2) * 1.1) + 100 * 1e6;
  say('');
  say('План:');
  say('  1. Резервная копия исходного проекта: .workplace/backup-update/migrate-' + name + '-МЕТКА/project (места нужно столько же, сколько проект).');
  say('  2. Копия в projects/' + name + ': история git, ветки, адреса, незакоммиченные правки. Ничего не коммитится.');
  say('  3. Сверка копии с исходником и с резервной копией. Исходная папка не меняется и не удаляется.');
  say('  Свободного места нужно примерно ' + human(need) + '.');
  if (!flags.yes) { say('Это только план. Покажи его человеку; копия запускается только после его второго, отдельного «да»: повтори команду с --yes.'); process.exitCode = 2; return; }
  try {
    if (typeof fs.statfsSync === 'function') { const s = fs.statfsSync(root); if (s.bavail * s.bsize < need) die('Свободного места меньше, чем нужно (' + human(s.bavail * s.bsize) + ' из ' + human(need) + '). Ничего не сделано.', 3); }
  } catch (e) { if (e && e.code !== 'ERR_FS_EISDIR') { /* замер места не удался: продолжаем, ошибка копирования всё равно будет поймана */ } }
  const before = snapshot(src, r.is_repo);
  const rdir = path.join(root, '.workplace', 'backup-update', 'migrate-' + name + '-' + stamp());
  const bdir = path.join(rdir, 'project');
  let made = [];
  try {
    fs.mkdirSync(rdir, { recursive: true }); made.push(rdir);
    const skippedB = copyTree(src, bdir, r.is_repo, !!flags['include-heavy']);
    say('Резервная копия сделана: ' + path.relative(root, bdir).split(path.sep).join('/'));
    made.push(dst);
    const skipped = copyTree(src, dst, r.is_repo, !!flags['include-heavy']);
    const after = snapshot(src, r.is_repo);
    const untouched = JSON.stringify(before) === JSON.stringify(after);
    fs.writeFileSync(path.join(rdir, 'record.json'), JSON.stringify({ name, src: tilde(src), dst: 'projects/' + name, backup: path.relative(root, bdir).split(path.sep).join('/'), at: new Date().toISOString(), before, skipped: skipped.length ? skipped : skippedB }, null, 2) + '\n');
    say('Скопировано в projects/' + name + '. Пропущено тяжёлых папок: ' + skipped.length + (skipped.length ? ' (' + skipped.join(', ') + '; восстанавливаются установкой зависимостей, например npm install)' : '') + '.');
    say('Исходная папка ' + (untouched ? 'не изменилась (сверено до и после)' : 'ИЗМЕНИЛАСЬ во время копирования (скорее всего, в ней работали): запусти verify') + '; она не удалена.');
  } catch (e) {
    for (const d of made.reverse()) { try { if (within(root, d)) fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* не критично */ } }
    die('Копирование прервалось (' + e.message + '). Неполные копии удалены, исходная папка не тронута. Повтори.', 1);
  }
  verify(root, src, name, {});
  if (!process.exitCode) logToState(root, 'модуль migrate-project: проект перенесён в projects/' + name + ' (резервная копия и сверка пройдены, исходник не тронут)');
  say('Резервная копия лежит в .workplace/backup-update (в git главной папки не попадает). Когда убедитесь, что всё работает, её может удалить сам человек.');
}

function main() {
  const { flags, pos } = parseArgs(process.argv.slice(2));
  const cmd = pos[0];
  if (cmd === 'inspect') {
    if (!pos[1]) die('inspect <папка проекта>', 2);
    const r = inspect(pos[1]);
    if (flags.json) say(JSON.stringify(r, null, 2)); else printInspect(r);
    if (r.blockers.length) process.exitCode = 3;
  } else if (cmd === 'copy') {
    if (!pos[1]) die('copy <папка проекта> [--name имя] [--include-heavy] [--yes]', 2);
    copy(pos[1], flags);
  } else if (cmd === 'verify') {
    if (!pos[1]) die('verify <папка проекта> [--name имя] [--full]', 2);
    verify(needRoot(), pos[1], flags.name, { full: !!flags.full });
  } else die('Команды: inspect <папка> [--json], copy <папка> [--name имя] [--include-heavy] [--yes], verify <папка> [--name имя] [--full]', 2);
}

if (require.main === module) main();
module.exports = { inspect, compareTrees, listTree, NAME_RE };
