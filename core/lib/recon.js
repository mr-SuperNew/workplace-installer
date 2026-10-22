'use strict';
// Разведка компьютера. ТОЛЬКО ЧТЕНИЕ: ничего не ставит, не создаёт и не меняет, на диск не пишет. Только встроенные модули Node.
// Основа - recon.js из v3. Что изменилось:
//  - Codex в расширении VS Code не ищется: расширение это строка «расширение Codex: есть», консольный Codex ищется отдельно и симметрично Claude;
//  - оба CLI ищутся одинаково (core/providers/*.detect), без запуска оболочки с профилями человека (PATH читается из окружения процесса);
//  - определяется случай: empty | claude-only | codex-only | scattered (всё есть, но разбросано) и предлагается направление;
//  - чего не хватает, то «поставлю после да», а не «с наставником».
// `claude auth status` не вызывается (он создаёт файлы): вход показывается пассивным признаком.
const fs = require('fs');
const os = require('os');
const path = require('path');
const u = require('./util');
const vscode = require('./vscode');
const macsupport = require('./macsupport');
const providers = require('../providers');

const MIN = { node: [18, 0, 0], claude: [2, 1, 277], vscode: [1, 94, 0], macos: [13, 0, 0] };
const OUR_SKILLS = ['cross-check', 'end-session', 'new-workspace', 'doctor', 'handoff'];
// Действия плана: «поставить» и «спросить» теперь есть; запрета ставить нет.
const ACT = { keep: 'оставлю', install: 'поставлю после да', ask: 'спрошу', hands: 'не трогаю', human: 'сделает человек', optional: 'по выбору', note: 'к сведению' };

function sh(cmd, args, timeout) { return u.run(cmd, args || [], { timeout: timeout || 8000 }); }

// ---------- сбор ----------
function collectNode() {
  const found = u.findAll('node');
  const running = { version: process.version, path: u.tilde(process.execPath) };
  const copies = found.map((c) => ({ path: u.tilde(c.path), kind: u.kindOf(c.path), version: u.versionOf(c.path).version, via: c.via }));
  const npm = u.findAll('npm')[0];
  return { running, copies, npm: npm ? { path: u.tilde(npm.path), version: u.versionOf(npm.path).version } : null, ok: u.atLeast(u.ver(process.version), MIN.node) };
}
// Заглушка python: на Mac без Command Line Tools /usr/bin/python3 открыла бы системное окно установки, на Windows псевдоним магазина WindowsApps открывает Microsoft Store. Не запускаем.
function collectPython(cltOk) {
  const names = u.IS_WIN ? ['python', 'py'] : ['python3', 'python'];
  const stubs = [];
  for (const n of names) {
    for (const c of u.findAll(n)) {
      const p = c.path.replace(/\\/g, '/');
      if (u.IS_WIN && /WindowsApps/i.test(p)) { stubs.push(u.tilde(c.path)); continue; }
      if (u.IS_MAC && !cltOk && /^\/usr\/bin\/python3?$/.test(p)) { stubs.push(u.tilde(c.path)); continue; }
      const args = n === 'py' ? ['-3', '--version'] : ['--version'];
      const r = u.run(c.path, args, { timeout: 8000 });
      const m = (r.out + ' ' + r.err).match(/Python (\d+\.\d+\.\d+)/);
      if (r.ok && m) return { cmd: n, path: u.tilde(c.path), version: m[1], stubs };
    }
  }
  return { cmd: null, path: null, version: null, stubs };
}
// git можно вызывать? На Mac без Command Line Tools «git» это заглушка: запуск открыл бы системное окно установки.
function gitStatus() {
  const git = u.findAll('git')[0];
  if (!git) return { ok: false, stub: false, path: null, note: 'git не найден' };
  if (u.IS_MAC && !sh('xcode-select', ['-p']).ok) return { ok: false, stub: true, path: git.path, note: 'git есть, но это заглушка: Command Line Tools не установлены' };
  return { ok: true, stub: false, path: git.path, note: '' };
}
function collectTools(claudeNpm) {
  const t = {};
  t.node = collectNode();
  t.npm = t.node.npm;
  const cltOk = !u.IS_MAC || sh('xcode-select', ['-p']).ok;
  t.python = collectPython(cltOk);
  const g = gitStatus();
  if (g.stub) t.git = { path: u.tilde(g.path), version: null, note: g.note };
  else if (g.ok) {
    const v = u.versionOf(g.path);
    t.git = { path: u.tilde(g.path), version: v.version, has_name: !!u.run(g.path, ['-C', u.homeDir(), 'config', 'user.name']).out, has_email: !!u.run(g.path, ['-C', u.homeDir(), 'config', 'user.email']).out };
  } else t.git = null;
  if (u.IS_MAC) t.command_line_tools = cltOk;
  t.managers = claudeNpm || [];
  return t;
}

function userFiles() {
  const h = u.homeDir();
  const hooksOf = (f) => { const s = u.readJson(f); return s && s.hooks && typeof s.hooks === 'object' ? Object.keys(s.hooks) : []; };   // только имена событий
  return {
    claude: {
      skills: (u.listDir(path.join(h, '.claude', 'skills')) || []).filter((n) => !n.startsWith('.')),
      global_claude_md: u.exists(path.join(h, '.claude', 'CLAUDE.md')),
      settings_json: u.exists(path.join(h, '.claude', 'settings.json')),
      user_hooks: hooksOf(path.join(h, '.claude', 'settings.json')),
    },
    codex: {
      skills: (u.listDir(path.join(h, '.agents', 'skills')) || []).filter((n) => !n.startsWith('.')),
      global_agents_md: u.exists(path.join(u.codexHome(), 'AGENTS.md')),
      config_toml: u.exists(path.join(u.codexHome(), 'config.toml')),
      user_hooks: hooksOf(path.join(u.codexHome(), 'hooks.json')),
    },
  };
}

// ---------- проекты: только имена и наличие файлов-признаков ----------
const SKIP = new Set(['node_modules', 'library', 'applications', 'appdata', 'application data', 'local settings', 'movies', 'music', 'pictures', 'videos', '.trash', 'venv', '.venv',
  'site-packages', 'dist', 'build', 'target', 'onedrivetemp', '$recycle.bin', 'system volume information', 'public', 'steam', 'games']);
const DEV_NAMES = ['Documents', 'Desktop', 'Developer', 'Projects', 'projects', 'dev', 'Dev', 'code', 'Code', 'work', 'Work', 'src', 'repos', 'Repos', 'GitHub', 'github', 'git', 'Sites', 'workspace', 'Workspace', 'IdeaProjects', 'PycharmProjects', 'WebstormProjects'];
const PROJECT_MARKERS = ['package.json', 'pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile', 'go.mod', 'Cargo.toml', 'pom.xml', 'CLAUDE.md', 'AGENTS.md', '.claude', '.codex'];
function repoInfo(repo) {
  return {
    path: u.tilde(repo),
    has_claude_md: u.exists(path.join(repo, 'CLAUDE.md')), has_agents_md: u.exists(path.join(repo, 'AGENTS.md')),
    has_gitignore: u.exists(path.join(repo, '.gitignore')), has_dot_claude: u.exists(path.join(repo, '.claude')),
    git_is_file: u.isFile(path.join(repo, '.git')),
  };
}
function scanProjects(extra) {
  const HOME = u.homeDir();
  const roots = [];
  for (const n of DEV_NAMES) { const d = path.join(HOME, n); if (u.exists(d)) roots.push({ dir: d, depth: 3 }); }
  for (const d of extra || []) if (u.exists(d)) roots.push({ dir: path.resolve(d), depth: 3 });
  roots.push({ dir: HOME, depth: 1 });
  const seen = new Set(), repos = [], installs = [], others = [];
  const rootKeys = new Set(roots.map((x) => u.real(x.dir).toLowerCase()));
  const deadline = Date.now() + 25000;
  let visited = 0;
  function walk(dir, depth) {
    if (depth < 0 || visited > 4000 || Date.now() > deadline) return;
    const key = u.real(dir).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key); visited++;
    if (u.isDir(path.join(dir, '.workplace'))) { installs.push(u.tilde(dir)); return; }   // это рабочее место, а не проект
    if (dir !== HOME && u.exists(path.join(dir, '.git'))) { repos.push(repoInfo(dir)); return; }
    if (dir !== HOME && !rootKeys.has(key)) { const mk = PROJECT_MARKERS.find((m) => u.exists(path.join(dir, m))); if (mk) { others.push({ path: u.tilde(dir), marker: mk }); return; } }
    let items = [];
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const it of items) {
      if (!it.isDirectory() || it.isSymbolicLink()) continue;
      const low = it.name.toLowerCase();
      if (SKIP.has(low) || (it.name.startsWith('.') && it.name !== '.git')) continue;
      if (/^onedrive|^dropbox|^google drive|^icloud/i.test(it.name) && dir === HOME) { walk(path.join(dir, it.name), 3); continue; }
      walk(path.join(dir, it.name), depth - 1);
    }
  }
  for (const r of roots) walk(r.dir, r.depth);
  if (u.IS_MAC) { const icloud = path.join(HOME, 'Library/Mobile Documents/com~apple~CloudDocs'); if (u.exists(icloud)) walk(icloud, 2); }
  return { repos, others, installs: [...new Set(installs)], visited };
}

// ---------- случай ----------
// empty        ни Claude Code, ни Codex (ни консольных, ни расширений)
// claude-only  Claude Code есть (консоль или расширение), Codex нет
// codex-only   Codex есть (консольный или расширение), Claude Code нет
// scattered    есть и то и другое («всё есть, но разбросано»), либо повторные копии, либо есть только расширение без консольной команды
function detectCase(r) {
  const c = r.claude, x = r.codex;
  const why = [];
  const signals = [];
  const dup = (d) => new Set(d.copies.filter((k) => k.usable).map((k) => k.path)).size >= 2;
  if (dup(c)) signals.push('консольных копий Claude Code больше одной');
  if (dup(x)) signals.push('консольных копий Codex больше одной');
  if (c.extension && !c.console) signals.push('Claude Code есть только в расширении VS Code, консольной команды нет');
  if (x.extension && !x.console) signals.push('Codex есть только в расширении VS Code, консольной команды нет (расширение консольным Codex не считается)');
  const offPath = (d) => d.copies.filter((k) => k.usable && !k.via.includes('PATH'));
  if (offPath(c).length) signals.push('Claude Code найден вне PATH: ' + offPath(c).map((k) => k.path).join(', '));
  if (offPath(x).length) signals.push('Codex найден вне PATH: ' + offPath(x).map((k) => k.path).join(', '));
  let id;
  if (!c.present && !x.present) { id = 'empty'; why.push('ни Claude Code, ни Codex не найдено'); }
  else if (c.present && !x.present) { id = 'claude-only'; why.push('есть Claude Code, Codex нет'); }
  else if (!c.present && x.present) { id = 'codex-only'; why.push('есть Codex, Claude Code нет'); }
  else { id = 'scattered'; why.push('есть и Claude Code, и Codex'); }
  if (id !== 'scattered' && signals.length) {
    // единственный ИИ, но с повторными копиями или только в расширении: это тоже «разбросано», если есть повторные копии
    if (signals.some((s) => /больше одной|вне PATH/.test(s))) id = 'scattered';
  }
  why.push(...signals);
  const clean = id === 'scattered' && !signals.length;
  // Предлагаемое направление: решает человек одним словом. Выпуск 1 первым выпускает направление «основной Claude Code, проверяет Codex» (решение владельца продукта, PROJECT.md раздел 2):
  // даже при «только Codex» основным предлагается Claude Code (он будет поставлен), а Codex становится проверяющим. Основной Codex работает (смена ролей одной командой role set, самопроверка вшитой ошибкой проходит); не проверено вживую только одно: сторожа Codex включаются, когда человек один раз подтвердит проект командой /hooks.
  const main = 'claude';
  if (id === 'codex-only') why.push('основным по умолчанию предлагается Claude Code (будет поставлен), Codex станет проверяющим; основным можно сделать и Codex, если человек этого хочет (сторожа Codex включаются после одного подтверждения проекта командой /hooks)');
  return { id, why, signals, clean, suggested: { main, reviewer: main === 'claude' ? 'codex' : 'claude' } };
}

// ---------- сбор целиком ----------
function collect(opts) {
  opts = opts || {};
  const r = { at: new Date().toISOString(), recon_version: 4 };
  r.os = {
    platform: process.platform, name: u.IS_MAC ? 'macOS' : u.IS_WIN ? 'Windows' : process.platform,
    version: u.IS_MAC ? sh('sw_vers', ['-productVersion']).out : os.release(), build: os.version ? os.version() : null,
    arch: process.arch, machine: u.IS_WIN ? process.env.PROCESSOR_ARCHITECTURE : sh('uname', ['-m']).out,
    // Apple Silicon: Node под Rosetta сообщает x64, поэтому спрашиваем систему (только чтение; на Intel ключа нет, ответ пустой)
    apple_silicon: u.IS_MAC ? (process.arch === 'arm64' || sh('sysctl', ['-n', 'hw.optional.arm64']).out.trim() === '1') : false,
    shell: u.IS_WIN ? 'cmd/PowerShell' : path.basename(process.env.SHELL || ''),
  };
  r.vscode = vscode.collect();
  r.claude = providers.get('claude').detect();
  r.codex = providers.get('codex').detect();
  r.tools = collectTools(r.claude.managers);
  r.user = userFiles();
  try { const s = fs.statfsSync(u.homeDir()); r.disk_free_gb = Math.round((s.bavail * s.bsize) / 1e9); } catch (_) { r.disk_free_gb = null; }
  r.cwd = u.tilde(process.cwd());
  r.projects = opts.scan === false ? { repos: [], others: [], installs: [], visited: 0, skipped: true } : scanProjects(opts.extraScan);
  r.case = detectCase(r);
  r.warnings = warnings(r);
  r.plan = plan(r);
  return r;
}

// ---------- выводы ----------
function warnings(r) {
  const w = [];
  const cc = r.claude.copies.filter((c) => c.usable);
  const distinct = new Set(cc.map((c) => c.path));
  if (distinct.size >= 2) w.push('Консольных копий Claude Code: ' + distinct.size + ' (' + cc.map((c) => c.path + ' ' + (c.version || '?')).join('; ') + '). Ничего не удаляю и не меняю без «да»; запускается первая в списке.');
  const cx = r.codex.copies.filter((c) => c.usable);
  if (new Set(cx.map((c) => c.path)).size >= 2) w.push('Консольных копий Codex: ' + new Set(cx.map((c) => c.path)).size + '. Ничего не удаляю и не меняю без «да».');
  if (cc[0] && cc[0].version && !u.atLeast(u.ver(cc[0].version), MIN.claude)) w.push('Первая копия Claude Code ' + cc[0].version + ' старше рекомендуемой ' + MIN.claude.join('.') + '. Не обновляю без «да» (это не мешает установке).');
  if (cc[0] && /системная папка/.test(cc[0].kind)) w.push('Claude Code лежит в системной папке. Ничего в ней не меняю.');
  if (r.os.platform === 'darwin' && !u.atLeast(u.ver(r.os.version), MIN.macos)) w.push('macOS ' + r.os.version + ' старше 13.0: Claude Code официально её не поддерживает. Это предупреждение, а не блок: установка продолжается, работу проверит живая проба.');
  if (r.os.platform === 'darwin') {
    const bs = macsupport.brewSupport(r.os);
    if (!bs.supported) w.push('Homebrew для вашего Mac не поддерживается (' + bs.why + '). Не предлагаю и не ставлю его: Node беру официальным архивом с nodejs.org в ~/.local/node (без пароля), Python и git через Command Line Tools.' + (r.tools.managers.some((m) => m.name === 'brew') ? ' Уже стоящий Homebrew не трогаю.' : ''));
  }
  if (r.vscode.version && !u.atLeast(u.ver(r.vscode.version), MIN.vscode)) w.push('VS Code ' + r.vscode.version + ' старше 1.94: расширение Claude Code может не работать.');
  const clash = r.user.claude.skills.filter((s) => OUR_SKILLS.includes(s));
  if (clash.length) w.push('В личной папке ~/.claude/skills уже есть навыки с теми же именами: ' + clash.join(', ') + '. Личные навыки главнее проектных: наши могут не запуститься.');
  if (r.user.claude.global_claude_md) w.push('Есть личный ~/.claude/CLAUDE.md: он читается вместе с правилами главной папки. Не трогаю.');
  if (r.user.claude.user_hooks.length) w.push('В личных настройках ~/.claude/settings.json есть свои хуки (' + r.user.claude.user_hooks.join(', ') + '): они работают вместе с нашими. Не трогаю.');
  if (r.user.codex.user_hooks.length) w.push('В личном ~/.codex/hooks.json есть свои хуки (' + r.user.codex.user_hooks.join(', ') + '): они работают вместе с нашими. Не трогаю.');
  if (r.codex.codex_home_overridden) w.push('Задана переменная CODEX_HOME: вход в Codex лежит не в ~/.codex.');
  if (r.user.codex.global_agents_md) w.push('Есть личный AGENTS.md у Codex (~/.codex/AGENTS.md): он читается вместе с правилами главной папки. Не трогаю.');
  if (r.tools.git && r.tools.git.note) w.push(r.tools.git.note);
  if (r.tools.python && r.tools.python.stubs && r.tools.python.stubs.length && !r.tools.python.version) w.push('Python не найден: найдена только заглушка системы (' + r.tools.python.stubs.join(', ') + '), её запуск открыл бы окно магазина или установки. Не запускаю.');
  if (/OneDrive|iCloud|Mobile Documents|CloudStorage|Dropbox/i.test(process.cwd())) w.push('Текущая папка лежит в облачной синхронизации: главную папку лучше создать вне её.');
  if (r.disk_free_gb !== null && r.disk_free_gb < 3) w.push('Свободного места мало: ' + r.disk_free_gb + ' ГБ.');
  if (r.projects.repos.length + (r.projects.others || []).length) w.push('Найдено папок с проектами: ' + r.projects.repos.length + ' с git и ' + (r.projects.others || []).length + ' без git. Все они помечены «не трогаю»: не читаю их файлы, не копирую, не пишу в них, git-команд в них нет.');
  return w;
}

function row(item, state, action, why) { return { item, state, action, why: why || '' }; }
function consoleState(d, label) {
  if (d.console) {
    const n = new Set(d.copies.filter((c) => c.usable).map((c) => c.path)).size;
    return label + ' ' + (d.primary.version || '?') + (n >= 2 ? ' (копий: ' + n + ')' : '');
  }
  const bad = d.copies.filter((c) => !c.usable);
  return bad.length ? 'найден, но не запускается (' + (bad[0].error || '?') + ')' : 'нет';
}
// Таблица «есть / нет / версия» и что с каждым пунктом. Направление не нужно: план по направлению строится в plan.js.
function plan(r) {
  const p = [];
  const extC = r.claude.extension, extX = r.codex.extension;
  p.push(row('VS Code', r.vscode.version ? 'есть ' + r.vscode.version : 'нет', r.vscode.version ? ACT.keep : ACT.optional, r.vscode.version ? '' : 'нужен только если вы работаете в редакторе; ставится модулем vscode по «да»'));
  p.push(row('Расширение Claude Code в VS Code', extC ? 'есть ' + extC.version : 'нет', ACT.keep, ''));
  p.push(row('Расширение Codex в VS Code', extX ? 'есть ' + extX.version : 'нет', ACT.keep, 'консольным Codex не считается: ниже отдельная строка про консольную программу'));
  const cc = r.claude;
  const ccLow = cc.console && !u.atLeast(u.ver(cc.primary.version), MIN.claude);
  p.push(row('Claude Code, консольная команда claude', consoleState(cc, 'есть'), cc.console ? (ccLow ? ACT.ask : ACT.keep) : ACT.install, cc.console ? (ccLow ? 'версия ниже ' + MIN.claude.join('.') + ': не обновляю без «да»' : '') : (extC ? 'в расширении своя копия; консольная нужна, чтобы Claude проверял работу Codex и работал в терминале' : 'официальный установщик, запасной путь npm без sudo')));
  p.push(row('Вход в Claude', cc.login_hint.state === 'present' ? 'признак входа есть' : 'признака входа нет', cc.login_hint.state === 'present' ? ACT.keep : ACT.human, cc.login_hint.state === 'present' ? 'вход проверит `claude auth status` после «да»' : 'вход в браузере'));
  const cx = r.codex;
  p.push(row('Codex, консольная команда codex', consoleState(cx, 'есть'), cx.console ? ACT.keep : ACT.install, cx.console ? '' : (cx.extension ? 'расширение Codex консольную программу не заменяет; ставлю консольный Codex CLI (официальный установщик, запасной путь npm без sudo)' : 'официальный установщик, запасной путь npm без sudo')));
  p.push(row('Вход в Codex', cx.login_hint.state === 'present' ? 'файл входа есть' : 'файла входа нет', cx.login_hint.state === 'present' ? ACT.keep : ACT.human, cx.login_hint.state === 'present' ? 'вход проверит `codex login status`' : 'вход через ChatGPT в браузере'));
  const t = r.tools;
  const nodeOk = t.node.copies.length && t.node.ok;
  p.push(row('Node.js', t.node.copies.length ? 'есть ' + (t.node.copies[0].version || t.node.running.version) : 'нет', nodeOk ? ACT.keep : (t.node.copies.length ? ACT.ask : ACT.install), nodeOk ? '' : (t.node.copies.length ? 'нужна версия 18 или новее; чужую версию не заменяю без «да»' : 'нужен скриптам и сторожам, версия 18 или новее')));
  p.push(row('Python', t.python.version ? 'есть ' + t.python.version : 'нет', t.python.version ? ACT.keep : ACT.install, t.python.version ? '' : 'ставится вместе с пакетом'));
  const gitOk = t.git && !t.git.note;
  p.push(row('git', t.git ? (t.git.version ? 'есть ' + t.git.version : 'есть заглушка') : 'нет', gitOk ? ACT.keep : ACT.ask, gitOk ? '' : 'желателен: без него главная папка не ведёт историю; ставится по «да»'));
  p.push(row('Твои проекты с git', r.projects.repos.length ? 'найдено ' + r.projects.repos.length : (r.projects.skipped ? 'поиск пропущен' : 'не найдено'), ACT.hands, 'не читаю файлы, не копирую, не пишу в них, git-команд в них нет; перенос только отдельной командой migrate-project по второму «да»'));
  p.push(row('Твои проекты без git', (r.projects.others || []).length ? 'найдено ' + r.projects.others.length : (r.projects.skipped ? 'поиск пропущен' : 'не найдено'), ACT.hands, 'то же самое'));
  return p;
}

const CASE_TITLE = { empty: 'пусто', 'claude-only': 'только Claude Code', 'codex-only': 'только Codex', scattered: 'всё есть, но разбросано' };

function md(r) {
  const L = [];
  L.push('Система: ' + r.os.name + ' ' + r.os.version + ', ' + (r.os.machine || r.os.arch) + ', оболочка ' + (r.os.shell || '?') + '; свободно ' + (r.disk_free_gb === null ? '?' : r.disk_free_gb + ' ГБ') + '; текущая папка ' + r.cwd);
  L.push('');
  L.push('Случай: **' + CASE_TITLE[r.case.id] + '** (' + r.case.id + '). ' + r.case.why.join('; ') + '.');
  L.push('Предлагаемое направление: основной ' + r.case.suggested.main + ', проверяет ' + r.case.suggested.reviewer + '. Решает человек одним словом.');
  L.push('');
  L.push('| Что | Есть? | Версия, где | План |');
  L.push('|---|---|---|---|');
  for (const x of r.plan) L.push('| ' + x.item + ' | ' + (/^поиск/.test(x.state) ? '?' : (/^(нет|не найдено|найден, но не запускается|признака входа нет|файла входа нет)/.test(x.state) ? 'нет' : 'есть')) + ' | ' + x.state + ' | ' + x.action + (x.why ? ': ' + x.why : '') + ' |');
  L.push('');
  const cp = (d, n) => d.copies.length ? n + ': ' + d.copies.map((c) => c.path + ' (' + (c.version || '?') + ', ' + c.kind + (c.usable ? '' : ', не запускается') + ')').join('; ') : null;
  for (const s of [cp(r.claude, 'Копии claude'), cp(r.codex, 'Копии codex')]) if (s) L.push(s);
  if (r.claude.extension && r.claude.extension.bundled) L.push('Копия Claude Code внутри расширения: ' + r.claude.extension.version);
  L.push('');
  if (r.projects.repos.length) { L.push('Проекты с git:'); for (const p of r.projects.repos) L.push('- ' + p.path + (p.has_claude_md ? ' (есть CLAUDE.md)' : '') + (p.has_agents_md ? ' (есть AGENTS.md)' : '')); L.push(''); }
  if ((r.projects.others || []).length) { L.push('Папки проектов без git:'); for (const p of r.projects.others) L.push('- ' + p.path + ' (признак: ' + p.marker + ')'); L.push(''); }
  if (r.projects.repos.length + (r.projects.others || []).length) L.push('НЕ ТРОГАЮ: все папки проектов из списков выше. Не читаю их файлы, не пишу в них, не копирую, не создаю в них файлов, git-команд в них нет.', '');
  if (r.projects.installs.length) L.push('Уже начатая установка рабочего места: ' + r.projects.installs.join(', ') + ' (можно продолжить с места остановки).', '');
  const todo = r.plan.filter((x) => x.action === ACT.install);
  if (todo.length) { L.push('Поставлю после «да»:'); todo.forEach((x) => L.push('- ' + x.item + ': ' + x.state + (x.why ? '. ' + x.why : ''))); L.push(''); }
  if (r.warnings.length) { L.push('Замечания:'); r.warnings.forEach((w) => L.push('- ' + w)); }
  return L.join('\n');
}

module.exports = { collect, plan, md, warnings, detectCase, gitStatus, collectTools, scanProjects, MIN, ACT, CASE_TITLE, OUR_SKILLS };
