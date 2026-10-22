'use strict';
// `wp.js adopt <путь>`: проект человека становится рабочим в главной папке.
//  - проект уже лежит внутри главной папки (человек скопировал сам): перед первой правкой кладётся копия в `.workplace/backups/`, вложенный `.git` дописывается
//    в `.gitignore` главной папки по ЛЮБОМУ пути (не только projects/), проверяется, что git главной папки проект не видит;
//  - проект лежит снаружи: копия с историей git через modules/migrate-project (со своей резервной копией и сверкой), затем то же для `.gitignore`.
// Исходный внешний проект не меняется и не удаляется. Только встроенные модули Node.
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const u = require('./util');
const state = require('./state');
const backup = require('./backup');
const { makeGuard } = require('./fsguard');

const SKIP_DIRS = new Set(['node_modules', '.venv', 'venv', '__pycache__', '.next', '.nuxt', '.cache', '.gradle', 'target', '.pytest_cache', '.mypy_cache', '.parcel-cache', '.turbo', '.workplace']);
const MAX_DEPTH = 6;

// Папки с собственным .git (каталог или файл подмодуля) внутри dir, включая саму dir. Внутрь найденного репозитория не заходим.
function nestedRepos(dir, root, maxMs) {
  const out = [];
  const top = path.resolve(root);
  const deadline = maxMs ? Date.now() + maxMs : 0;     // хук на каждое сообщение человека: обход ограничен по времени
  (function walk(d, depth) {
    if (depth > MAX_DEPTH || (deadline && Date.now() > deadline)) return;
    if (!u.same(d, top) && u.exists(path.join(d, '.git'))) { out.push(d); return; }
    let items = [];
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const it of items) {
      if (!it.isDirectory() || it.isSymbolicLink() || SKIP_DIRS.has(it.name) || it.name === '.git') continue;
      walk(path.join(d, it.name), depth + 1);
    }
  })(path.resolve(dir), 0);
  return out;
}

function relPosix(root, abs) { return path.relative(root, abs).split(path.sep).join('/'); }
// Строка .gitignore для папки: от корня, со слэшем в конце; служебные знаки шаблонов экранируются.
function giLine(rel) { return '/' + rel.replace(/([\\*?\[\]])/g, '\\$1') + '/'; }

function ignored(root, rel, lines) {
  const l = giLine(rel);
  if (lines.some((x) => x === l || x === l.slice(0, -1) || x === rel + '/' || x === rel)) return true;
  // родительская папка в списке: projects/ закрывает projects/любой
  const parts = rel.split('/');
  for (let i = 1; i < parts.length; i++) { const par = parts.slice(0, i).join('/'); if (lines.some((x) => x === '/' + par + '/' || x === par + '/' || x === '/' + par)) return true; }
  try {
    const gs = require('./recon').gitStatus();
    if (gs.ok && u.exists(path.join(root, '.git'))) return u.run(gs.path, ['-C', root, 'check-ignore', '-q', '--', rel + '/any.file']).ok;
  } catch (_) { /* git недоступен: хватит текста */ }
  return false;
}

// Дописывает в .gitignore главной папки каждый вложенный репозиторий. Возвращает { repos, added, already }.
function gitignoreNested(root, o) {
  o = o || {};
  const repos = nestedRepos(o.dir || root, root, o.maxMs).filter((d) => !u.same(d, root));
  const gi = path.join(root, '.gitignore');
  const cur = u.exists(gi) ? fs.readFileSync(gi, 'utf8') : '';
  const lines = cur.split(/\r?\n/).map((l) => l.trim());
  const added = [], already = [];
  for (const d of repos) {
    const rel = relPosix(root, d);
    if (!rel || rel.startsWith('..')) continue;
    if (ignored(root, rel, lines)) already.push(rel); else added.push(rel);
  }
  if (added.length && !o.dryRun) {
    const g = makeGuard(root);
    const block = (cur && !cur.endsWith('\n') ? '\n' : '') + '\n# --- проекты внутри главной папки со своим git (добавлено установщиком ' + u.today() + ') ---\n' + added.map(giLine).join('\n') + '\n';
    g.af(gi, block);
  }
  return { repos: repos.map((d) => relPosix(root, d)), added, already };
}

function gitIn(dir, args) {
  const gs = require('./recon').gitStatus();
  if (!gs.ok) return null;
  return u.run(gs.path, ['-C', dir, ...args], { timeout: 20000 });
}

function slug(name) {
  const t = require('./layout').slugify(name);
  return t || 'project';
}

function adopt(root, p, o) {
  o = o || {};
  const say = o.say || (() => {});
  root = u.realish(root);   // ссылки раскрыты с обеих сторон: на Mac /var это ссылка на /private/var, и путь проекта относительно корня иначе выходит за корень
  const abs = u.realish(path.resolve(String(p || '').replace(/^~(?=[\/\\]|$)/, u.homeDir())));
  if (!p) throw new u.WpError('adopt: назови папку проекта (путь).', 2);
  if (!u.isDir(abs)) throw new u.WpError('Папки ' + abs + ' нет. Ничего не сделано.', 2);
  const res = { dir: null, kind: null, backup: null, ignore: null };
  const inside = u.within(root, abs) && !u.same(root, abs);
  if (u.same(root, abs)) throw new u.WpError('Это сама главная папка, не проект. Ничего не сделано.', 2);
  if (inside && u.within(path.join(root, '.workplace'), abs)) throw new u.WpError('Это служебная папка рабочего места, не проект. Ничего не сделано.', 3);
  if (u.within(abs, root)) throw new u.WpError('Главная папка лежит внутри этого проекта: копия скопировала бы саму себя. Ничего не сделано.', 3);

  if (inside) {
    res.kind = 'inside';
    res.dir = abs;
    const rel = relPosix(root, abs);
    say('Проект лежит внутри главной папки: ' + rel);
    // копия до первой правки (если проект большой, копия не делается и об этом говорится)
    const prev = ((state.load(root) || {}).projects || []).find((x) => x.dir === rel && x.backup && u.isDir(path.join(root, x.backup)));
    const b = o.dryRun ? { made: false, reason: 'пробный запуск' } : prev ? { made: false, kept: true, dir: prev.backup, reason: 'копия до первой правки уже есть' } : backup.backupDir(root, abs, 'adopt-' + slug(path.basename(abs)));
    res.backup = b;
    if (b.kept) say('Копия до первой правки уже сделана раньше: ' + b.dir);
    else if (b.made) say('Копия до правок: ' + b.dir + ' (файлов ' + b.files + (b.skipped.length ? '; тяжёлые папки не копировались: ' + b.skipped.join(', ') : '') + ')');
    else say('Копия НЕ сделана: ' + (b.reason || b.error) + (u.exists(path.join(abs, '.git')) ? '. История проекта в его .git, это тоже копия коммитов.' : '. Скажи человеку и спроси, продолжать ли без копии.'));
    res.ignore = gitignoreNested(root, { dir: abs, dryRun: o.dryRun });
  } else {
    res.kind = 'outside';
    const name = o.name || slug(path.basename(abs));
    const mod = path.join(root, '.workplace', 'modules', 'migrate-project', 'migrate-project.js');
    if (!u.isFile(mod)) throw new u.WpError('Нет модуля migrate-project в ' + path.relative(root, mod) + ': копию проекта с историей сделать нечем. Можно работать в проекте на месте, не копируя.', 3);
    say('Проект лежит снаружи: ' + u.tilde(abs) + '. Копирую в projects/' + name + ' с историей git (исходник не меняется).');
    if (o.dryRun) { say('Пробный запуск: ничего не скопировано.'); res.dir = path.join(root, 'projects', name); return res; }
    const r = cp.spawnSync(process.execPath, [mod, 'copy', abs, '--name', name, '--yes'], { cwd: root, encoding: 'utf8', timeout: 20 * 60 * 1000, env: u.childEnv() });
    const out = String(r.stdout || '') + String(r.stderr || '');
    out.split(/\r?\n/).filter(Boolean).forEach((l) => say('  ' + l));
    if (r.status !== 0) throw new u.WpError('Копия не удалась (код ' + r.status + '). Исходный проект не тронут. Что сказал модуль, показано выше.', r.status === 2 ? 2 : 1);
    res.dir = path.join(root, 'projects', name);
    res.ignore = gitignoreNested(root, { dir: res.dir });
  }
  const ig = res.ignore;
  if (ig.added.length) say('В .gitignore главной папки дописано: ' + ig.added.map(giLine).join(', '));
  if (ig.already.length) say('Уже закрыто в .gitignore: ' + ig.already.join(', '));
  if (!ig.repos.length) say('Своего .git у проекта нет: его файлы git главной папки увидит как обычные. Если нужна отдельная история, заведи git внутри проекта.');
  const rel = relPosix(root, res.dir);
  const gr = gitIn(root, ['ls-files', '--', rel]);
  if (gr && gr.ok && gr.out) say('ВНИМАНИЕ: файлы проекта уже числятся в git главной папки (' + gr.out.split(/\r?\n/).length + '). Покажи человеку: убрать их из индекса можно командой git rm -r --cached ' + rel + ' (с его «да»).');
  const st = gitIn(root, ['status', '--short', '--', rel]);
  if (st && st.ok) say('git главной папки видит в проекте: ' + (st.out ? st.out.split(/\r?\n/).length + ' строк' : 'ничего (проект закрыт .gitignore)'));
  if (!o.dryRun) {
    try {
      const s = state.need(root);
      if (!Array.isArray(s.projects)) s.projects = [];
      s.projects = s.projects.filter((x) => x.dir !== rel).concat([{ at: new Date().toISOString(), dir: rel, kind: res.kind, backup: res.backup && (res.backup.made || res.backup.kept) ? res.backup.dir : null, nested_git: ig.repos }]);
      state.save(root, s);
      state.log(root, 'проект принят в главную папку: ' + rel + ' (' + (res.kind === 'inside' ? 'лежал внутри' : 'скопирован снаружи') + ')');
    } catch (_) { /* журнал недоступен: сообщения выше уже показаны */ }
  }
  return res;
}

module.exports = { nestedRepos, giLine, gitignoreNested, adopt };
