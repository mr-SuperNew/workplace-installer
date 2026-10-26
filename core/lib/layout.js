'use strict';
// Создание и раскладка главной папки (корня): init, layout, hooks, gitignore, git-init, new-workspace, module add.
// Основа - init/layout/mergeSettings/gitignore/git-init/new-agent из v3 setup.js. Различие с v3:
//  - метка корня `.workplace/` (config.json, state.json); пакет копируется в `.workplace/` (core, modules, VERSION, INSTALL.md);
//  - сторожа и навыки подключаются симметрично: `.claude/settings.json` + `.claude/skills/` и `.codex/hooks.json` + `.agents/skills/`;
//  - правила одни: AGENTS.md ({{MAIN}}/{{REVIEWER}}), CLAUDE.md содержит `@AGENTS.md`.
const fs = require('fs');
const os = require('os');
const path = require('path');
const u = require('./util');
const rootLib = require('./root');
const config = require('./config');
const state = require('./state');
const wiring = require('./wiring');
const providers = require('../providers');
const rules = require('./rules');
const backup = require('./backup');
const consent = require('./consent');
const { makeGuard } = require('./fsguard');

const TPL = path.join(__dirname, '..', 'templates');
const BOOT_MARK = '<!-- wp-bootstrap -->';
// Признаки «здесь чей-то проект»: главная папка не создаётся ни в самой такой папке, ни внутри неё.
const PROJECT_MARKERS = ['.git', 'package.json', 'pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile', 'go.mod', 'Cargo.toml', 'pom.xml', 'CLAUDE.md', 'AGENTS.md', '.claude', '.codex', '.workplace'];

function tpl(name) { return fs.readFileSync(path.join(TPL, name), 'utf8'); }
function names(cfg) { return rules.names(cfg); }

// ---------- копирование ----------
// managed = пакет, хуки, навыки (обновляются флагом update); не managed = файлы человека (никогда не перезаписываются).
function copyFile(g, src, dst, managed, report, o) {
  const data = fs.readFileSync(src);
  if (!u.exists(dst)) { g.wf(dst, data); report.push(['создан', g.rel(dst)]); return; }
  if (u.sha256(fs.readFileSync(dst)) === u.sha256(data)) { report.push(['без изменений', g.rel(dst)]); return; }
  if (managed && o && o.update) { const bk = g.root ? backup.backupFile(g.root, dst) : null; g.wf(dst, data); report.push(['обновлён', g.rel(dst) + (bk && bk.made ? ' (копия прежнего: ' + bk.file + ')' : '')]); return; }
  report.push(['ОТЛИЧАЕТСЯ, не перезаписан', g.rel(dst)]);
}
const COPY_SKIP = new Set(['node_modules', '.git']);
function copyDir(g, src, dst, managed, report, o) {
  for (const it of fs.readdirSync(src, { withFileTypes: true })) {
    if (COPY_SKIP.has(it.name) || /\.tmp-\d+$/.test(it.name)) continue;
    const s = path.join(src, it.name), d = path.join(dst, it.name);
    if (it.isDirectory()) copyDir(g, s, d, managed, report, o); else if (it.isFile()) copyFile(g, s, d, managed, report, o);
  }
}
function putText(g, dst, text, report, o) {
  if (!u.exists(dst)) { g.wf(dst, text); report.push(['создан', g.rel(dst)]); return; }
  if (fs.readFileSync(dst, 'utf8') === text) { report.push(['без изменений', g.rel(dst)]); return; }
  report.push(['ОТЛИЧАЕТСЯ, не перезаписан', g.rel(dst)]);
}

// ---------- init ----------
// Проверки ДО создания чего-либо на диске: текст отказа или null. Содержимое чужих файлов не читается, смотрятся только имена.
function rootRefusal(root) {
  const home = u.homeDir();
  if (u.same(root, home) || u.same(root, path.parse(root).root)) return 'Главная папка не может быть домашней папкой или корнем диска: нужна новая папка внутри, например ' + path.join(home, 'workplace') + '.';
  if (u.same(root, path.dirname(home))) return 'Главная папка не может быть папкой над домашней.';
  let lst = null; try { lst = fs.lstatSync(root); } catch (_) { lst = null; }
  if (lst && lst.isSymbolicLink()) return 'Путь ' + root + ' это ссылка (или junction): главная папка должна быть настоящей новой папкой. Ничего не создано.';
  if (u.exists(root)) {
    if (!u.isDir(root)) return 'Путь ' + root + ' существует и это не папка. Назови другой.';
    if ((u.listDir(root) || []).length) return 'Папка ' + root + ' не пуста. init принимает только отсутствующую или пустую папку (чужое не трогаем). Если установка в ней уже начата, продолжай скриптом из этой папки: node .workplace/core/cli/wp.js state next; иначе назови другую новую папку. Ничего не изменено.';
  }
  let cur = root;
  while (!u.exists(cur)) { const up = path.dirname(cur); if (up === cur) break; cur = up; }
  for (let dir = cur; ; dir = path.dirname(dir)) {
    if (u.same(dir, home) || dir === path.dirname(dir)) break;
    if (u.same(dir, root)) continue;
    const hit = PROJECT_MARKERS.find((m) => u.exists(path.join(dir, m)));
    if (hit) return 'Путь ' + root + ' лежит внутри папки ' + dir + ', где есть ' + hit + ' (похоже на чей-то проект или репозиторий). Главная папка не создаётся внутри чужих проектов: выбери другое место, например ' + path.join(home, 'workplace') + '. Ничего не создано.';
  }
  return null;
}
function rootWarnings(root) {
  const w = [];
  if (/OneDrive|iCloud|Mobile Documents|CloudStorage|Dropbox|[\\/]Documents([\\/]|$)|[\\/]Desktop([\\/]|$)/i.test(root)) w.push('Папка лежит в облачной синхронизации, «Документах» или на «Рабочем столе»: система может задавать лишние вопросы о доступе. Лучше домашняя папка.');
  if (/\s|[^\x00-\x7f]/.test(root)) w.push('В пути есть пробелы или не латинские буквы. Это работает, но иногда ломает команды; лучше латиница без пробелов.');
  return w;
}

// o: { root, kit, main, reviewer, reviewerModel, recon, plan, instruction }
function init(o) {
  const root = path.resolve(o.root);
  const refusal = rootRefusal(root);
  if (refusal) throw new u.WpError(refusal, 3);
  if (!config.PROVIDERS.includes(o.main)) throw new u.WpError('Нужен --main claude|codex.', 2);
  const reviewer = o.reviewer || config.other(o.main);
  const cfg = Object.assign(config.defaults(), { main: o.main, reviewer, reviewer_model: o.reviewerModel || null });
  const bad = config.validate(cfg);
  if (bad.length) throw new u.WpError(bad.join('; '), 2);
  const g = makeGuard(root);
  const report = [];
  const kitVersion = (u.readText(path.join(o.kit, 'VERSION')) || '4.0.0-rc.2').trim();
  g.mk(root);
  const wp = path.join(root, rootLib.MARK);
  g.mk(wp);
  consent.ensureIgnore(root);
  // пакет в .workplace/: core, modules, docs, VERSION, INSTALL.md
  copyDir(g, path.join(o.kit, 'core'), path.join(wp, 'core'), true, report);
  if (u.isDir(path.join(o.kit, 'modules'))) copyDir(g, path.join(o.kit, 'modules'), path.join(wp, 'modules'), true, report);
  if (u.isDir(path.join(o.kit, 'docs'))) copyDir(g, path.join(o.kit, 'docs'), path.join(wp, 'docs'), true, report);
  copyFile(g, path.join(o.kit, 'VERSION'), path.join(wp, 'VERSION'), true, report);
  let instSha = 'не передан', instRel = '(не передана)';
  const inst = o.instruction ? path.resolve(o.instruction) : path.join(o.kit, 'INSTALL.md');
  if (u.isFile(inst)) { copyFile(g, inst, path.join(wp, 'INSTALL.md'), true, report); instSha = u.sha256File(inst); instRel = '.workplace/INSTALL.md'; }
  config.save(root, cfg);
  report.push(['создан', '.workplace/config.json']);
  if (o.recon) { g.wf(path.join(wp, 'recon-before.json'), JSON.stringify(o.recon, null, 2) + '\n'); report.push(['создан', '.workplace/recon-before.json']); }
  // состояние
  const s = state.newState({ root, kit_version: kitVersion, main: o.main, reviewer, case: o.recon ? o.recon.case.id : null });
  s.stages['P0.recon'] = Object.assign(s.stages['P0.recon'], { status: 'done', action: 'present', at: new Date().toISOString() });
  s.stages['P1.root'] = Object.assign(s.stages['P1.root'], { status: 'done', action: 'created', note: u.tilde(root), at: new Date().toISOString() });
  if (o.plan) require('./plan').applyToState(s, o.plan);
  s.instruction = { sha256: instSha, path: instRel };
  s.files = pkgHashes(root);   // хеши установленных файлов пакета: по ним update отличает правки человека (H4)
  state.save(root, s);
  report.push(['создан', '.workplace/state.json']);
  // журнал: первая запись — версия и sha256 инструкции (сама инструкция лежит в .workplace/INSTALL.md)
  g.wf(path.join(root, 'STATE.md'), u.fill(tpl('STATE.md.tpl'), { KIT_VERSION: kitVersion, INSTRUCTION_SHA: instSha, INSTRUCTION_PATH: instRel, MAIN: names(cfg).MAIN, REVIEWER: names(cfg).REVIEWER, CASE: o.recon ? o.recon.case.id : 'не определён' }));
  report.push(['создан', 'STATE.md']);
  state.log(root, 'главная папка создана: ' + u.tilde(root));
  // временные правила на время установки (заменятся при раскладке) и CLAUDE.md с импортом
  const nm = names(cfg);
  if (!u.exists(path.join(root, 'AGENTS.md'))) { g.wf(path.join(root, 'AGENTS.md'), u.fill(tpl('AGENTS.bootstrap.md.tpl'), nm)); report.push(['создан', 'AGENTS.md (временный, заменится при раскладке)']); }
  if (!u.exists(path.join(root, 'CLAUDE.md'))) { g.wf(path.join(root, 'CLAUDE.md'), tpl('CLAUDE.md.tpl')); report.push(['создан', 'CLAUDE.md']); }
  return { root, cfg, report, warnings: rootWarnings(root), kitVersion };
}

// Хеши файлов пакета в .workplace (core, modules, docs, VERSION, INSTALL.md): ключ это путь от корня с прямым слэшем, как в update.items().
function pkgHashes(root) {
  const wp = path.join(root, rootLib.MARK);
  const out = {};
  const walk = (dir) => {
    for (const it of fs.readdirSync(dir, { withFileTypes: true })) {
      if (COPY_SKIP.has(it.name) || /\.tmp-\d+$/.test(it.name)) continue;
      const p = path.join(dir, it.name);
      if (it.isDirectory()) walk(p); else if (it.isFile()) out[u.toPosix(path.relative(root, p))] = u.sha256File(p);
    }
  };
  for (const d of ['core', 'modules', 'docs']) if (u.isDir(path.join(wp, d))) walk(path.join(wp, d));
  for (const f of ['VERSION', 'INSTALL.md']) if (u.isFile(path.join(wp, f))) out[rootLib.MARK + '/' + f] = u.sha256File(path.join(wp, f));
  return out;
}

// ---------- layout ----------
function skillSources(root) {
  const base = path.join(root, '.workplace', 'core', 'skills');
  return (u.listDir(base) || []).filter((n) => u.isDir(path.join(base, n)));
}
function layout(root, o) {
  o = o || {};
  const g = makeGuard(root);
  const p = rootLib.paths(root);
  const cfg = config.load(root);
  const nm = names(cfg);
  const report = [];
  for (const d of [p.handoffs, p.checks, p.workspaces, p.claudeSkills, p.agentsSkills]) g.mk(d);
  consent.ensureIgnore(root);
  // правила: временный AGENTS.md (с меткой) заменяем, чужой не трогаем
  const full = u.fill(tpl('AGENTS.md.tpl'), nm);
  const am = path.join(root, 'AGENTS.md');
  const amText = u.exists(am) ? u.readText(am) : null;
  if (amText === null) { g.wf(am, full); report.push(['создан', 'AGENTS.md']); }
  else if (amText.startsWith(BOOT_MARK)) { g.wf(am, full); report.push(['заменён временный', 'AGENTS.md']); }
  else if (amText === full) report.push(['без изменений', 'AGENTS.md']);
  else if (o.update && o.managedRules) { backup.backupFile(root, am); g.wf(am, full); report.push(['обновлён', 'AGENTS.md']); }
  else if (o.update) {
    // layout --update приводит к настройкам роли в AGENTS.md (config.json: main, reviewer): файл целиком, если его не правили, иначе только строки с ролями
    const sy = rules.syncRoles(amText, cfg);
    if (sy.changed) {
      backup.backupFile(root, am);
      g.wf(am, sy.text);
      report.push([sy.how === 'full' ? 'роли обновлены' : 'роли обновлены (только строки с ролями: ' + sy.replaced + ')', 'AGENTS.md']);
      if (sy.left.length) report.push(['ОТЛИЧАЕТСЯ, не перезаписан', 'AGENTS.md (строки с прежними ролями не найдены в файле, исправь их вручную: ' + sy.left.slice(0, 2).map((l) => '«' + l.slice(0, 50) + '»').join(', ') + ')']);
    } else report.push(['ОТЛИЧАЕТСЯ, не перезаписан', 'AGENTS.md']);
  } else report.push(['ОТЛИЧАЕТСЯ, не перезаписан', 'AGENTS.md']);
  const cm = path.join(root, 'CLAUDE.md');
  const cmText = u.exists(cm) ? u.readText(cm) : null;
  if (cmText === null) { g.wf(cm, tpl('CLAUDE.md.tpl')); report.push(['создан', 'CLAUDE.md']); }
  else if (!/^\s*@AGENTS\.md\s*$/m.test(cmText)) report.push(['ОТЛИЧАЕТСЯ, не перезаписан', 'CLAUDE.md (нет строки @AGENTS.md: предложи человеку дописать её первой строкой, с «да»)']);
  else report.push(['без изменений', 'CLAUDE.md']);
  putText(g, path.join(root, 'tasks.md'), tpl('tasks.md.tpl'), report);
  putText(g, path.join(root, 'MEMORY.md'), tpl('MEMORY.md.tpl'), report);
  // .gitignore: новый создаём, существующий не трогаем (дополнение: gitignore append, с «да»)
  const gi = path.join(root, '.gitignore');
  if (!u.exists(gi)) { g.wf(gi, tpl('gitignore.tpl')); report.push(['создан', '.gitignore']); }
  else { const miss = gitignoreMissing(root); report.push([miss.length ? 'ОТЛИЧАЕТСЯ, не перезаписан' : 'без изменений', '.gitignore' + (miss.length ? ' (не хватает строк: ' + miss.length + '; gitignore append только с «да»)' : '')]); }
  // навыки: одинаковый SKILL.md в .claude/skills и .agents/skills
  const src = skillSources(root);
  if (!src.length) report.push(['НЕТ В ПАКЕТЕ', '.workplace/core/skills (навыки пока не положены в пакет)']);
  for (const sk of src) for (const dstBase of [p.claudeSkills, p.agentsSkills]) copyDir(g, path.join(root, '.workplace', 'core', 'skills', sk), path.join(dstBase, sk), true, report, o);
  // основной Codex вызывает проверяющего Claude из своей песочницы: ей нужна сеть (H3)
  if (cfg.main === 'codex') report.push(codexNetworkConfig(g, root));
  return report;
}

// ---------- сеть в песочнице основного Codex ----------
// Основной Codex запускает `claude -p` из своей песочницы workspace-write; без сети этот вызов виснет ~2 минуты (опыт 4, research/2026-10-21-experiments.md).
// Нужная настройка Codex: sandbox_workspace_write.network_access = true. Флаг -c с этим ключом подтверждён опытом; та же настройка в config.toml проекта
// (<корень>/.codex/config.toml, читается в доверенной папке) - TODO: verify на живом Codex. Запасной путь: запустить основной Codex с этим флагом.
const CODEX_NET_MARK = '# wp-managed: основной Codex вызывает проверяющего Claude из песочницы workspace-write, ей нужна сеть';
const CODEX_NET_BLOCK = CODEX_NET_MARK + '\n[sandbox_workspace_write]\nnetwork_access = true\n';
function codexNetConfigState(text) {
  if (text === null) return 'absent';
  const m = /^\[sandbox_workspace_write\]\s*$([\s\S]*?)(?=^\s*\[|(?![\s\S]))/m.exec(text);
  if (!m) return 'no-table';
  return /^\s*network_access\s*=\s*true\b/m.test(m[1]) ? 'ok' : 'differs';
}
function codexNetworkConfig(g, root) {
  const f = path.join(root, '.codex', 'config.toml');
  const text = u.exists(f) ? fs.readFileSync(f, 'utf8') : null;
  const st = codexNetConfigState(text);
  if (st === 'ok') return ['без изменений', '.codex/config.toml (сеть в песочнице основного Codex)'];
  if (st === 'absent') { g.wf(f, CODEX_NET_BLOCK); return ['создан', '.codex/config.toml (сеть в песочнице основного Codex: sandbox_workspace_write.network_access = true)']; }
  if (st === 'no-table') { g.af(f, (text.endsWith('\n') ? '' : '\n') + '\n' + CODEX_NET_BLOCK); return ['дописан', '.codex/config.toml (блок sandbox_workspace_write.network_access = true)']; }
  return ['ОТЛИЧАЕТСЯ, не перезаписан', '.codex/config.toml (в [sandbox_workspace_write] нет network_access = true: проверяющий Claude из песочницы Codex без сети не вызовется; покажи человеку)'];
}

// ---------- .gitignore ----------
function giRequired() { return tpl('gitignore.tpl').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')); }
function giLines(f) { return u.exists(f) ? fs.readFileSync(f, 'utf8').split(/\r?\n/).map((l) => l.trim()) : []; }
function gitignoreMissing(root) { const have = new Set(giLines(path.join(root, '.gitignore'))); return giRequired().filter((l) => !have.has(l)); }
// Пути, которые git обязан игнорировать (проверка через git check-ignore, когда git можно вызывать).
const GI_PROBES = ['.env', '.env.local', 'checks/x/input/y.md', 'checks/x/manifest.json', 'checks/POLICY.md', '.workplace/state.json', '.workplace/recon-before.json', '.workplace/snapshots/before.json',
  '.workplace/backup-update/20260101-000000/x', '.workplace/npm-cache/x', 'workspaces/a/data/d.csv', 'workspaces/a/out/o.md', 'projects/p/file.js', 'install-report.md', '.claude/settings.local.json'];
function gitignoreAppend(g, root, dry) {
  const miss = gitignoreMissing(root);
  if (!miss.length) return { added: 0, text: 'Нечего добавлять.' };
  const block = '\n# --- рабочее место (добавлено установщиком ' + u.today() + ') ---\n' + miss.join('\n') + '\n';
  if (dry) return { added: miss.length, text: 'Добавил бы:' + block };
  const gi = path.join(root, '.gitignore');
  g.af(gi, (u.exists(gi) && !fs.readFileSync(gi, 'utf8').endsWith('\n') ? '\n' : '') + block);
  return { added: miss.length, text: 'Добавлено строк: ' + miss.length };
}

// ---------- git главной папки ----------
function gitTop(gitPath, dir) { const r = u.run(gitPath, ['-C', dir, 'rev-parse', '--show-toplevel']); return r.ok ? path.resolve(r.out) : null; }
function gitInit(root, o) {
  const recon = require('./recon');
  const gs = recon.gitStatus();
  if (!gs.ok) throw new u.WpError('git недоступен (' + gs.note + '): главная папка не ведёт историю изменений. Установка git по «да» (шаг P1.git); остальное работает.', 6);
  const git = gs.path;
  const run = (a, ro) => u.run(git, ['-C', root, ...a], ro);
  const out = [];
  const top = gitTop(git, root);
  if (top && !u.same(top, root)) throw new u.WpError('Главная папка внутри чужого репозитория ' + top + ': git-init не выполняю.', 3);
  if (!top) {
    let r = u.run(git, ['init', '-b', 'main'], { cwd: root });
    if (!r.ok) { r = u.run(git, ['init'], { cwd: root }); if (r.ok) run(['symbolic-ref', 'HEAD', 'refs/heads/main']); }
    if (!r.ok) throw new u.WpError('git init не удался: ' + r.err, 1);
    out.push('git init: готово');
  } else out.push('git-репозиторий главной папки уже есть: не переинициализирую');
  const hasName = run(['config', 'user.name']).out, hasMail = run(['config', 'user.email']).out;
  if (!hasName || !hasMail) {
    if (!o.name || !o.email) throw new u.WpError('Для коммита git нужны имя и почта, а в настройках git их нет. Спроси человека и повтори: git-init --name "Имя" --email адрес. Они запишутся только в этот репозиторий.', 4);
    run(['config', '--local', 'user.name', o.name]); run(['config', '--local', 'user.email', o.email]);
    out.push('Имя и почта записаны только в этот репозиторий (локально).');
  } else out.push('Имя и почта для коммитов уже есть в настройках git: не меняю.');
  // коммит только своих путей (по именам): чужое в индексе и рабочей папке не трогаем
  const paths = ['AGENTS.md', 'CLAUDE.md', 'tasks.md', 'MEMORY.md', '.gitignore', '.claude', '.agents', '.codex', '.workplace'].filter((x) => u.exists(path.join(root, x)));
  const pre = run(['diff', '--cached', '--name-only']);
  if (pre.ok && pre.out.split(/\r?\n/).filter(Boolean).length) throw new u.WpError('В индексе git уже есть чьи-то изменения: коммит не делаю, покажи человеку.', 3);
  const add = run(['add', '--', ...paths]);
  if (!add.ok) throw new u.WpError('git add не удался: ' + add.err, 1);
  const staged = run(['diff', '--cached', '--name-only']).out.split(/\r?\n/).filter(Boolean);
  const badRx = /(^|\/)\.env($|\.(?!example$))|settings\.local\.json|\.workplace\/(state|recon-before|human-messages|consent-plan)\.json|\.workplace\/(snapshots|backup-update|npm-cache|backups|delegate)\/|\.bak-/;
  const bad = staged.filter((f) => badRx.test(f));
  if (bad.length) { run(['reset', '-q', '--', ...paths]); throw new u.WpError('В коммит попали служебные файлы: ' + bad.join(', ') + '. Откатил добавление; проверь .gitignore.', 3); }
  if (!staged.length) { out.push('Коммитить нечего: всё уже закоммичено.'); return out; }
  const c = run(['commit', '-q', '-m', 'Начальная раскладка рабочего места']);
  if (!c.ok) { run(['reset', '-q', '--', ...paths]); throw new u.WpError('commit не удался: ' + (c.err || c.out), 1); }
  out.push('Коммит создан: файлов ' + staged.length + ' (адреса и push не использовались).');
  return out;
}

// ---------- подключение сторожей ----------
// Подключает хуки в оба провайдера. Хуки, скриптов которых нет в пакете, пропускаются с сообщением.
function wireHooks(root, o) {
  o = o || {};
  const g = makeGuard(root);
  const tp = wiring.templatePaths();
  const res = { claude: null, codex: null, missing: [] };
  const wpDir = o.wpDir || path.join(root, rootLib.MARK);
  const c = wiring.filterAvailable(wiring.renderTemplate(tp.claude, root), wpDir);
  const x = wiring.filterAvailable(wiring.renderTemplate(tp.codex, root), wpDir);
  res.missing = [...new Set([...c.missing, ...x.missing])];
  res.claude = wiring.applyFile(path.join(root, '.claude', 'settings.json'), c.tpl, g, { dryRun: o.dryRun, prune: true });
  res.codex = wiring.applyFile(path.join(root, '.codex', 'hooks.json'), x.tpl, g, { dryRun: o.dryRun, prune: true });
  return res;
}
// Состояние подключения: по каждому хуку из шаблонов файл есть / подключён в Claude / подключён в Codex / синтаксис.
function hooksStatus(root) {
  const p = rootLib.paths(root);
  const tp = wiring.templatePaths();
  const want = {};
  for (const [prov, f] of Object.entries(tp)) {
    const t = wiring.renderTemplate(f, root);
    for (const groups of Object.values(t.hooks || {})) for (const grp of groups) for (const h of grp.hooks) { const k = wiring.hookKey(h.command); if (k) (want[k] = want[k] || {})[prov] = true; }
  }
  const wc = wiring.wiredKeys(p.claudeSettings), wx = wiring.wiredKeys(p.codexHooks);
  const rows = [];
  for (const k of Object.keys(want).sort()) {
    const file = path.join(p.mark, k);
    const present = u.exists(file);
    let syntax = null;
    if (present) syntax = u.run(process.execPath, ['--check', file]).ok;
    rows.push({ hook: k, present, syntax, claude: { wanted: !!want[k].claude, wired: wc.has(k) }, codex: { wanted: !!want[k].codex, wired: wx.has(k) } });
  }
  return rows;
}
// Пробные вводы: мусор молчит с кодом 0; сторож секретов отвечает как положено. Возвращает список проблем (пусто = всё отвечает).
function hookRun(root, name, input) {
  const file = path.join(root, '.workplace', 'core', 'hooks', name);
  const r = require('child_process').spawnSync(process.execPath, [file], { cwd: root, input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', timeout: 15000, env: u.childEnv({ CLAUDE_PROJECT_DIR: root }) });
  return { code: r.status, out: String(r.stdout || '').trim() };
}
function hooksTest(root) {
  const bad = [];
  const dir = path.join(root, '.workplace', 'core', 'hooks');
  const files = (u.listDir(dir) || []).filter((n) => /\.js$/.test(n) && !n.startsWith('_'));
  if (!files.length) return { checked: 0, bad: ['в пакете нет хуков (core/hooks пуст)'], skipped: true };
  for (const f of files) {
    for (const junk of ['', 'не json{{', '{}', '[1,2]']) {
      const r = hookRun(root, f, junk);
      if (r.code !== 0) bad.push(f + ': на мусорный ввод код ' + r.code + ' (должен быть 0)');
      else if (r.out && r.out.length > 20000) bad.push(f + ': на мусорный ввод длинный ответ');
    }
  }
  if (files.includes('secret-guard.js')) {
    const fake = 'password = "' + 'Zx9' + '-fake-Pass-4321"';
    const denies = (input) => /"deny"/.test(hookRun(root, 'secret-guard.js', input).out);
    const p = path.join(root, 'selftest-secret.txt');
    if (!denies({ tool_name: 'Write', tool_input: { file_path: p, content: fake + '\n' } })) bad.push('secret-guard: запись выдуманного пароля в файл не остановлена');
    if (denies({ tool_name: 'Write', tool_input: { file_path: p, content: 'обычный текст\n' } })) bad.push('secret-guard: остановил обычную запись (ложное срабатывание)');
    if (!denies({ tool_name: 'Read', tool_input: { file_path: path.join(root, '.env') } })) bad.push('secret-guard: не закрывает чтение .env');
    if (denies({ tool_name: 'Read', tool_input: { file_path: path.join(root, '.env.example') } })) bad.push('secret-guard: закрывает .env.example');
    if (!denies({ tool_name: 'Bash', tool_input: { command: 'cat .env' } })) bad.push('secret-guard: не закрывает cat .env');
    for (const ok of ['node -e "console.log(process.env.HOME)"', 'npm install -g @openai/codex', 'codex login status', 'git commit -m "x"']) {
      if (denies({ tool_name: 'Bash', tool_input: { command: ok } })) bad.push('secret-guard: остановил команду установки: ' + ok);
    }
  }
  if (files.includes('danger-guard.js') && config.guardEnabled(config.load(root), 'danger_guard')) {
    const denies = (input) => /"deny"/.test(hookRun(root, 'danger-guard.js', input).out);
    const outside = path.join(path.parse(root).root, 'wp-selftest-nonexistent-folder');   // вне главной папки и вне временных зон (тест: корень диска)
    if (!denies({ tool_name: 'Bash', tool_input: { command: 'rm -rf "' + outside.replace(/\\/g, '/') + '"' }, cwd: root })) bad.push('danger-guard: удаление вне главной папки без «да» человека не остановлено');
    if (!denies({ tool_name: 'Bash', tool_input: { command: 'rm -rf "' + outside.replace(/\\/g, '/') + '" # CONFIRMED' }, cwd: root })) bad.push('danger-guard: метка # CONFIRMED от ИИ открывает удаление (должна не значить ничего)');
    if (!denies({ tool_name: 'Write', tool_input: { file_path: path.join(root, '.workplace', 'human-messages.json'), content: '{}' }, cwd: root })) bad.push('danger-guard: ИИ может писать в файл сообщений человека (.workplace/human-messages.json)');
    if (denies({ tool_name: 'Write', tool_input: { file_path: path.join(root, 'selftest-ok.txt'), content: 'обычный текст\n' }, cwd: root })) bad.push('danger-guard: остановил обычную запись в главной папке (ложное срабатывание)');
  }
  return { checked: files.length, bad };
}

// ---------- новая рабочая папка под задачу ----------
const TRANSLIT = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'j', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
function slugify(text) {
  const t = String(text).toLowerCase().split('').map((ch) => (ch in TRANSLIT ? TRANSLIT[ch] : ch)).join('');
  return t.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}
function newWorkspace(root, nameOrTitle, o) {
  o = o || {};
  const g = makeGuard(root);
  const p = rootLib.paths(root);
  const raw = String(nameOrTitle || '').trim();
  if (!raw) throw new u.WpError('Назови задачу: new-workspace <имя-латиницей или название>.', 2);
  const slug = /^[a-z0-9]+(-[a-z0-9]+)*$/.test(raw) ? raw : slugify(raw);
  if (!slug) throw new u.WpError('Из названия не получилось имя папки (латиница, цифры, дефис). Назови имя латиницей.', 2);
  const dir = path.join(p.workspaces, slug);
  if (u.exists(dir)) throw new u.WpError('Папка workspaces/' + slug + ' уже есть. Не перезаписываю: покажи человеку.', 3);
  // похожая папка: тот же корень имени (до первого дефиса) или вложенность имён; не блокирует, но показывается
  const similar = (u.listDir(p.workspaces) || []).filter((n) => n !== slug && (n.startsWith(slug) || slug.startsWith(n) || n.split('-')[0] === slug.split('-')[0]));
  const map = { TITLE: o.title || raw, GOAL: o.goal || '(допиши цель одной фразой)' };
  for (const d of ['handoffs', 'data', 'out']) g.mk(path.join(dir, d));
  for (const f of ['AGENTS.md', 'tasks.md', 'MEMORY.md', 'CLAUDE.md']) g.wf(path.join(dir, f), u.fill(fs.readFileSync(path.join(TPL, 'workspace', f + '.tpl'), 'utf8'), map));
  return { slug, dir, similar, how: 'Открой эту папку в редакторе или запусти ИИ из неё: `cd workspaces/' + slug + '`.' };
}

// ---------- модуль (личные навыки и хуки поверх ядра) ----------
function rangeOk(range, version) {
  if (!range) return true;
  const v = u.ver(version);
  const m = String(range).trim().match(/^(>=|\^|~|=)?\s*(\d+\.\d+(?:\.\d+)?)$/);
  if (!m) return false;
  const base = u.ver(m[2]);
  if (m[1] === '^') return v[0] === base[0] && u.atLeast(v, base);
  if (m[1] === '~') return v[0] === base[0] && v[1] === base[1] && u.atLeast(v, base);
  if (m[1] === '>=') return u.atLeast(v, base);
  return v[0] === base[0] && v[1] === base[1] && v[2] === base[2];
}
function moduleAdd(root, modDir) {
  const src = path.resolve(modDir);
  const mj = u.readJson(path.join(src, 'module.json'));
  if (!mj) throw new u.WpError('В ' + src + ' нет module.json (или он не читается).', 2);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(String(mj.name || ''))) throw new u.WpError('module.json: name латиницей, цифры и дефис.', 2);
  const coreVersion = (u.readText(path.join(root, '.workplace', 'VERSION')) || '0.0.0').trim();
  if (!rangeOk(mj.requires_core, coreVersion)) throw new u.WpError('Модуль требует ядро ' + mj.requires_core + ', стоит ' + coreVersion + '. Ничего не сделано.', 2);
  const g = makeGuard(root);
  const p = rootLib.paths(root);
  const s = state.need(root);
  const prev = s.modules.find((m) => m.name === mj.name);
  const coreSkills = new Set(skillSources(root));
  const report = [];
  const skills = Array.isArray(mj.skills) ? mj.skills : [];
  for (const sk of skills) {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(sk)) throw new u.WpError('module.json: имя навыка «' + sk + '» не годится.', 2);
    if (coreSkills.has(sk)) throw new u.WpError('Навык «' + sk + '» есть и в ядре: конфликт имён, модуль не подключён. Переименуй навык модуля.', 3);
    if (!u.isDir(path.join(src, 'skills', sk))) throw new u.WpError('В модуле нет папки skills/' + sk + '.', 2);
    for (const base of [p.claudeSkills, p.agentsSkills]) {
      const d = path.join(base, sk);
      if (u.exists(d) && !(prev && (prev.skills || []).includes(sk))) throw new u.WpError('Папка ' + g.rel(d) + ' уже есть и не из этого модуля: не перезаписываю. Ничего не сделано.', 3);
    }
  }
  const files = {};
  const modRoot = path.join(p.modules, mj.name);
  const copyTracked = (from, to, rec) => {
    for (const it of fs.readdirSync(from, { withFileTypes: true })) {
      const f = path.join(from, it.name), t = path.join(to, it.name);
      if (it.isDirectory()) copyTracked(f, t, rec);
      else if (it.isFile()) { const data = fs.readFileSync(f); g.wf(t, data); rec[g.rel(t)] = u.sha256(data); }
    }
  };
  for (const sk of skills) for (const base of [p.claudeSkills, p.agentsSkills]) copyTracked(path.join(src, 'skills', sk), path.join(base, sk), files);
  for (const sub of ['hooks', 'files']) if (u.isDir(path.join(src, sub))) copyTracked(path.join(src, sub), path.join(modRoot, sub), files);
  const mod = { name: mj.name, version: mj.version || '0.0.0', requires_core: mj.requires_core || null, skills, hooks: [], files };
  // хуки под своим именем: .workplace/modules/<имя>/hooks/<файл>
  const hookDefs = Array.isArray(mj.hooks) ? mj.hooks : [];
  if (hookDefs.length) {
    const claudeTpl = { hooks: {} }, codexTpl = { hooks: {} };
    for (const h of hookDefs) {
      if (!h || !/^[\w.-]+\.js$/.test(h.file || '') || !/^[A-Za-z]+$/.test(h.event || '')) throw new u.WpError('module.json: у хука нужны file (*.js) и event.', 2);
      if (!u.exists(path.join(modRoot, 'hooks', h.file))) throw new u.WpError('В модуле нет hooks/' + h.file + '.', 2);
      const timeout = Number.isFinite(h.timeout) ? h.timeout : 10;
      const mk = (cmd, extra) => ({ matcher: h.matcher, hooks: [Object.assign({ type: 'command', command: cmd, timeout }, extra || {})] });
      const cc = 'node "$CLAUDE_PROJECT_DIR/.workplace/modules/' + mj.name + '/hooks/' + h.file + '"';
      const xc = 'node "' + u.toPosix(root) + '/.workplace/modules/' + mj.name + '/hooks/' + h.file + '"';
      (claudeTpl.hooks[h.event] = claudeTpl.hooks[h.event] || []).push(mk(cc));
      (codexTpl.hooks[h.event] = codexTpl.hooks[h.event] || []).push(mk(xc, { commandWindows: xc }));
      mod.hooks.push(h.file);
    }
    for (const t of [claudeTpl, codexTpl]) for (const ev of Object.keys(t.hooks)) t.hooks[ev] = t.hooks[ev].map((x) => (x.matcher ? x : { hooks: x.hooks }));
    wiring.applyFile(p.claudeSettings, claudeTpl, g, {});
    wiring.applyFile(p.codexHooks, codexTpl, g, {});
  }
  s.modules = s.modules.filter((m) => m.name !== mj.name).concat([mod]);
  state.save(root, s);
  state.log(root, 'модуль подключён: ' + mj.name + ' ' + mod.version);
  report.push(['модуль', mj.name + ' ' + mod.version + ': навыков ' + skills.length + ', хуков ' + mod.hooks.length + ', файлов ' + Object.keys(files).length]);
  return { mod, report };
}

module.exports = { pkgHashes, codexNetConfigState, codexNetworkConfig, BOOT_MARK, PROJECT_MARKERS, rootRefusal, rootWarnings, init, layout, skillSources, gitignoreMissing, gitignoreAppend, GI_PROBES, gitInit, gitTop, wireHooks, hooksStatus, hooksTest, hookRun, slugify, newWorkspace, moduleAdd, rangeOk, copyFile, copyDir, names, tpl, TPL };
