'use strict';
// Общая обвязка тестов safety, matrix и unit/core: счётчик проверок, временные папки, фейковый HOME, PATH без настоящих claude и codex, хеши деревьев.
// Ничего не пишет вне временных папок. Настоящие ~/.claude и ~/.codex не трогаются: у дочерних процессов HOME, USERPROFILE, APPDATA, WP_HOME указывают на фейковую папку.
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');

const KIT = path.resolve(__dirname, '..', '..');            // build/v4 (или его копия: так негативные проверки подменяют код)
const WP_SRC = path.join(KIT, 'core', 'cli', 'wp.js');
const IS_WIN = process.platform === 'win32';

// ---------- счётчик ----------
class Suite {
  constructor(title) { this.title = title; this.pass = 0; this.failed = 0; this.failures = []; this.t0 = Date.now(); }
  section(t) { process.stdout.write('\n== ' + t + '\n'); }
  ok(name, cond, detail) {
    if (cond) { this.pass++; return true; }
    this.failed++; this.failures.push(name);
    process.stdout.write('  ПАДЕНИЕ: ' + name + (detail ? '\n    ' + String(detail).slice(0, 700).replace(/\n/g, '\n    ') : '') + '\n');
    return false;
  }
  // Итог в одном формате для всех наборов. Код выхода: 0 всё прошло, 1 есть падения.
  finish() {
    process.stdout.write('\nПроверок пройдено: ' + this.pass + ', падений: ' + this.failed + ' (' + Math.round((Date.now() - this.t0) / 1000) + ' с)\n');
    if (this.failed) process.stdout.write('Падения:\n' + this.failures.map((f) => ' - ' + f).join('\n') + '\n');
    return this.failed ? 1 : 0;
  }
}

// ---------- файлы ----------
function mkTmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function rmTree(dir) { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch (_) { /* временная папка */ } }
function write(p, text) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; }
const read = (p) => fs.readFileSync(p, 'utf8');
const exists = (p) => fs.existsSync(p);
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

// Хеш дерева: имена, виды и содержимое всех файлов, включая .git. skip: относительные пути (с прямым слэшем) верхнего уровня, которые не учитываются.
function treeHash(dir, skip) {
  const h = crypto.createHash('sha256');
  const skipSet = new Set((skip || []).map((s) => s.replace(/\\/g, '/')));
  (function walk(d, rel) {
    let items = [];
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const it of items.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const r = rel ? rel + '/' + it.name : it.name;
      if (skipSet.has(r)) continue;
      const p = path.join(d, it.name);
      if (it.isSymbolicLink()) { h.update('L:' + r + '>' + fs.readlinkSync(p)); continue; }
      if (it.isDirectory()) { h.update('D:' + r); walk(p, r); continue; }
      if (it.isFile()) { h.update('F:' + r); h.update(fs.readFileSync(p)); }
    }
  })(dir, '');
  return h.digest('hex');
}
// Список файлов с суммами (для понятного «что изменилось» в сообщении о падении).
function treeMap(dir, skip) {
  const m = new Map();
  const skipSet = new Set((skip || []).map((s) => s.replace(/\\/g, '/')));
  (function walk(d, rel) {
    let items = [];
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const it of items) {
      const r = rel ? rel + '/' + it.name : it.name;
      if (skipSet.has(r)) continue;
      const p = path.join(d, it.name);
      if (it.isDirectory()) walk(p, r); else if (it.isFile()) m.set(r, crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 12));
    }
  })(dir, '');
  return m;
}
function mapDiff(a, b) {
  return { changed: [...b.keys()].filter((k) => a.has(k) && a.get(k) !== b.get(k)), added: [...b.keys()].filter((k) => !a.has(k)), removed: [...a.keys()].filter((k) => !b.has(k)) };
}
const mapDiffText = (a, b) => { const d = mapDiff(a, b); return 'изменено: ' + d.changed.join(', ') + '; добавлено: ' + d.added.join(', ') + '; убрано: ' + d.removed.join(', '); };

// ---------- окружение ----------
// PATH из заданных папок, папки с node, git (настоящий, если withGit) и системных: настоящих claude, codex и python хозяина в нём нет.
function findOnPath(name) {
  const r = cp.spawnSync(IS_WIN ? 'where' : 'which', [name], { encoding: 'utf8' });
  const l = String(r.stdout || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean)[0];
  return l || null;
}
function minPath(extraFirst, o) {
  o = o || {};
  const gitExe = o.git === false ? null : findOnPath('git');
  const winRoot = process.env.SystemRoot || 'C:\\Windows';
  const sys = IS_WIN ? [path.join(winRoot, 'System32'), winRoot, path.join(winRoot, 'System32', 'WindowsPowerShell', 'v1.0')] : ['/usr/bin', '/bin'];
  const dirs = [...(extraFirst || []), path.dirname(process.execPath), gitExe ? path.dirname(gitExe) : null, ...sys].filter(Boolean);
  return [...new Set(dirs)].join(path.delimiter);
}
// Окружение дочерних процессов: фейковый HOME везде, пустой глобальный git, ловушка во временной папке ОС (trap), PATH из аргумента.
// o: { path, trap, extra, gitUser: {name,email} }. Файл .gitconfig в фейковом HOME пишется отдельно (writeGitConfig).
function sandboxEnv(home, o) {
  o = o || {};
  const e = Object.assign({}, process.env);
  for (const k of ['CODEX_HOME', 'CLAUDE_PROJECT_DIR', 'CODEX_SANDBOX_NETWORK_DISABLED', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'WP_TEST_TMP', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete e[k];
  Object.assign(e, {
    WP_HOME: home, HOME: home, USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0',
    STUB_MODE: 'smart', WP_NET_PROBE: 'off',   // проверка сети проверяющего Claude на заглушках не нужна (её тест в unit/fixes)
  });
  const p = o.path || minPath([]);
  e.PATH = p; e.Path = p;
  if (o.trap) { e.TEMP = o.trap; e.TMP = o.trap; e.TMPDIR = o.trap; }
  return Object.assign(e, o.extra || {});
}

// ---------- запуск ----------
const winQuote = (a) => (a === '' ? '""' : /[\s"&|<>^()%!]/.test(a) ? '"' + String(a).replace(/"/g, '\\"') + '"' : String(a));
function run(cmd, args, o) {
  o = o || {};
  const viaShell = IS_WIN && !/\.exe$/i.test(cmd) && cmd !== process.execPath;   // .cmd-обёртки Windows запускаются только через оболочку
  const r = viaShell
    ? cp.spawnSync([cmd, ...(args || [])].map(winQuote).join(' '), { cwd: o.cwd, input: o.input, encoding: 'utf8', timeout: o.timeout || 120000, env: o.env || process.env, windowsHide: true, shell: true })
    : cp.spawnSync(cmd, args, { cwd: o.cwd, input: o.input, encoding: 'utf8', timeout: o.timeout || 120000, env: o.env || process.env, windowsHide: true });
  return { code: r.status, out: String(r.stdout || ''), err: String(r.stderr || ''), all: String(r.stdout || '') + String(r.stderr || '') };
}
const node = (script, args, o) => run(process.execPath, [script, ...(args || [])], o);
// Асинхронный запуск (для параллельных прогонов): Promise<{code,out,err,all}>
function nodeAsync(script, args, o) {
  o = o || {};
  return new Promise((resolve) => {
    const c = cp.spawn(process.execPath, [script, ...(args || [])], { cwd: o.cwd, env: o.env || process.env, windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => { try { cp.spawnSync(IS_WIN ? 'taskkill' : 'kill', IS_WIN ? ['/PID', String(c.pid), '/T', '/F'] : ['-9', String(c.pid)], { stdio: 'ignore' }); } catch (_) { /* уже завершён */ } }, o.timeout || 900000);
    c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
    c.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err, all: out + err }); });
  });
}
// git настоящий: для подготовки чужих репозиториев и проверки результата.
const git = (cwd, args, env) => run('git', ['-C', cwd, ...args], { env: env || process.env, timeout: 60000 });

// Репозиторий с типичным «рабочим» состоянием: коммит, изменённый и проиндексированный файлы, неотслеживаемый, игнорируемый, stash, адрес с токеном.
function makeForeignRepo(dir, env, tag) {
  tag = tag || 'foreign';
  const g = (...a) => { const r = git(dir, a, env); if (r.code !== 0 && !/stash/.test(a[0])) throw new Error('git ' + a.join(' ') + ': ' + r.all); return r; };
  fs.mkdirSync(dir, { recursive: true });
  run('git', ['init', '-q', '-b', 'main', dir], { env });
  g('config', 'user.name', 'Test Person'); g('config', 'user.email', 'test@example.com');
  write(path.join(dir, 'README.md'), '# ' + tag + '\n');
  write(path.join(dir, 'AGENTS.md'), 'правила чужого проекта\n');
  write(path.join(dir, 'src', 'app.py'), 'print(1)\n');
  write(path.join(dir, '.gitignore'), 'node_modules\n.env\n');
  write(path.join(dir, '.claude', 'settings.json'), '{}\n');
  g('add', '.'); g('commit', '-q', '-m', 'first');
  write(path.join(dir, 'src', 'app.py'), 'print(2)\n'); g('stash', '-q');                    // есть stash
  write(path.join(dir, 'src', 'app.py'), 'print(3)  # не закоммичено\n');                    // изменён, не в индексе
  write(path.join(dir, 'staged.txt'), 'в индексе\n'); g('add', 'staged.txt');                // в индексе
  write(path.join(dir, 'notes.txt'), 'неотслеживаемый\n');                                    // неотслеживаемый
  write(path.join(dir, '.env'), 'KEY_VALUE=not-a-real-secret\n');                              // игнорируемый
  write(path.join(dir, 'node_modules', 'x', 'i.js'), 'x');
  g('remote', 'add', 'origin', 'https://example.com/org/' + tag + '.git');
  return dir;
}
const repoState = (dir, env) => ({
  status: git(dir, ['status', '--porcelain=v1', '--branch'], env).out,
  stash: git(dir, ['stash', 'list'], env).out,
  head: git(dir, ['rev-parse', 'HEAD'], env).out,
  cached: git(dir, ['diff', '--cached'], env).out,
  config: git(dir, ['config', '--local', '--list'], env).out,
});

// Сообщение человека так, как его записывает хук UserPromptSubmit главной папки (тот же скрипт, что работает в сессии). «Да» в тестах ставится только так.
function humanSays(root, text, env) {
  const hook = path.join(root, '.workplace', 'core', 'hooks', 'human-message.js');
  return node(hook, [], { cwd: root, env: Object.assign({}, env || process.env, { CLAUDE_PROJECT_DIR: root }), input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: text, cwd: root }) });
}

module.exports = {
  humanSays, KIT, WP_SRC, IS_WIN, Suite, mkTmp, rmTree, write, read, exists, sha, readJson, treeHash, treeMap, mapDiff, mapDiffText,
  findOnPath, minPath, sandboxEnv, run, node, nodeAsync, git, makeForeignRepo, repoState,
};
