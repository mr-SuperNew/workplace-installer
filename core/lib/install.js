'use strict';
// Установка недостающих программ после «да» человека: `wp.js install claude|codex|python|git --yes`.
// Зачем отдельная команда: установка идёт одним вызовом, записывается в состояние и журнал (что, откуда, чем кончилось, какие записи вне корня объявлены),
// а сторож опасных команд не видит в тексте команды цепочку `скачать | выполнить` (она внутри скрипта и только после «да»).
// Только официальные установщики и менеджеры пакетов (winget, brew). Пароль и права администратора человек вводит сам: команда их не просит и не обходит.
// Node ставится ДО wp.js (скрипты сами на Node): его команды показывает `plan`, здесь Node не ставится.
const cp = require('child_process');
const path = require('path');
const u = require('./util');
const state = require('./state');
const config = require('./config');
const consent = require('./consent');
const providers = require('../providers');
const recon = require('./recon');
const plan = require('./plan');

const fs = require('fs');
const PROFILES = ['~/.zprofile', '~/.zshrc', '~/.zshenv', '~/.bash_profile', '~/.bashrc', '~/.profile'];

function runInherit(spec, timeoutMs, extraEnv) {
  const env = u.childEnv(Object.assign({}, spec.env || {}, extraEnv || {}));
  const opts = { stdio: 'inherit', timeout: timeoutMs || 600000, windowsHide: true, env };
  try {
    const r = u.needsShell(spec.cmd)
      ? cp.spawnSync([spec.cmd, ...spec.args].map(u.q).join(' '), Object.assign({ shell: true }, opts))
      : cp.spawnSync(spec.cmd, spec.args, opts);
    if (r.error) return { ok: false, code: null, error: String(r.error.code || r.error.message) };
    return { ok: r.status === 0, code: r.status };
  } catch (e) { return { ok: false, code: null, error: String(e.message) }; }
}
function runCapture(spec, timeoutMs) {
  const r = u.run(spec.cmd, spec.args, { timeout: timeoutMs || 600000, env: spec.env });
  return r;
}

// «Да» человека для install и path-fix. Флаг --yes сам подтверждением не является: его ставит ИИ, поэтому он ничего не доказывает.
//  - Сторож сообщений человека подключён (в .workplace/human-messages.json есть записи): нужно «да» в последнем сообщении человека и название программы
//    в последних двух сообщениях либо в плане, на который он ответил «да» (wp.js consent plan). Иначе отказ.
//  - Записей нет (на этапе 1 хук ещё не подключён или сессия идёт вне главной папки): пакет подлинность «да» проверить НЕ МОЖЕТ. Цитату --human-said подставляет сам ИИ,
//    поэтому она доказательством не является и пометки «подтверждено» (verified) не получает. Настоящая проверка на этом этапе - родной запрос разрешения Claude Code или Codex:
//    в обычном режиме человек сам нажимает «разрешить» на каждой команде установки (INSTALL.md запрещает ИИ включать режимы без запросов и просить об этом человека).
//    Цитата остаётся условием (без слов с «да» команда отказывает: ИИ обязан сначала спросить), в state.json и install-report.md уходит как claimedByAi
//    с пометкой «подтверждено запросом разрешения программы, а не механизмом пакета» и verified: false.
// Возвращает запись о подтверждении для state.installs.
const NATIVE_PROMPT_ONLY = 'подтверждено запросом разрешения программы, а не механизмом пакета';
function requireHuman(o, what, names) {
  if (consent.hasRecords(o.root)) {
    const res = consent.evaluate(o.root, null, names && names.length ? { kind: 'target', targets: [{ kind: 'name', names }] } : { kind: 'yes', targets: [] });
    if (res.ok) return { via: 'сообщение человека (сторож видел его сам)', verified: true };
    throw new u.WpError(what + ': ' + (res.why === 'no-yes'
      ? 'в последнем сообщении человека нет «да». Покажи ему, что именно ты сделаешь, и спроси «да»; получив его, повтори команду.'
      : 'в последних двух сообщениях человека не названо «' + (names || []).join('/') + '», и принятого плана нет. Зарегистрируй показанное (node .workplace/core/cli/wp.js consent plan "что ставлю"), спроси «да» и повтори.') + ' Один флаг --yes подтверждением не является. Ничего не сделано.', 3);
  }
  const quote = String(o.humanSaid || '').trim();
  if (!quote) throw new u.WpError(what + ': сторож не видит сообщений человека (хук ещё не подключён), поэтому один флаг --yes ничего не доказывает. Покажи человеку действие, получи его «да» в чате и повтори с --human-said "его слова дословно" (в отчёт они попадут как слова, которые передал ИИ; подлинность «да» на этом этапе подтверждает только запрос разрешения программы, который нажимает человек). Ничего не сделано.', 2);
  if (!consent.isYes(quote)) throw new u.WpError(what + ': в переданных словах человека нет «да» («' + quote.slice(0, 80) + '»). Ничего не сделано.', 2);
  return { via: NATIVE_PROMPT_ONLY, verified: false, claimedByAi: quote.replace(/\s+/g, ' ').slice(0, 200) };
}

function stageFor(cfg, name) { return cfg.main === name ? 'P1.main' : (cfg.reviewer === name ? 'P1.reviewer' : null); }

// o: { root, yes, npm (только запасной путь), dryRun }; say - печать. Возвращает { ok, how, version }.
function installProvider(name, o, say) {
  const p = providers.get(name);
  const cfg = config.load(o.root);
  const s = state.need(o.root);
  const stage = stageFor(cfg, name);
  const r0 = recon.collect({ scan: false });
  const ip = p.installPlan({ platform: process.platform, arch: process.arch }, { root: o.root });
  const d0 = r0[name];
  if (d0.console && !o.force) { say(p.label + ' уже стоит (' + d0.primary.version + '): не переустанавливаю и не обновляю.'); return { ok: true, how: 'present', version: d0.primary.version }; }
  const useOfficial = !o.npm;
  say('Ставлю ' + p.label + (useOfficial ? ': ' + ip.primary.title : ': ' + ip.fallback.title) + '.');
  if (useOfficial) {
    say('Команда: ' + ip.primary.display);
    say('Пишет: ' + ip.primary.writes.join(', ') + '.' + (ip.primary.editsProfile ? ' Установщик сам дописывает PATH в профиль оболочки или пользовательский PATH: это согласованная запись, она будет объявлена.' : ''));
  } else say('Команда: npm ' + ip.fallback.run.args.join(' ') + ' (без sudo; кэш npm: .workplace/npm-cache внутри главной папки).');
  if (o.dryRun) { say('Пробный запуск: ничего не выполнялось.'); return { ok: true, how: 'dry-run' }; }
  if (!o.yes) throw new u.WpError('install пишет на диск: покажи это человеку и дождись «да», затем повтори с --yes. Ничего не сделано.', 2);
  const conf = requireHuman(o, 'install ' + name, [name]);
  const declared = useOfficial && ip.primary.editsProfile && !u.IS_WIN ? PROFILES.slice() : [];
  let how = useOfficial ? 'official' : 'npm';
  let ok = false;
  if (useOfficial) {
    const r = runInherit(ip.primary.run, 900000);
    ok = r.ok;
    if (!ok) say('Официальный установщик не сработал (код ' + (r.code === null ? r.error : r.code) + ').');
  }
  let d = p.detect();
  if (useOfficial && ok && !d.console) { ok = false; say('Установщик отработал, но программа не найдена: проверяю запасной путь.'); }
  const nodeNeed = (ip.fallback.requires && ip.fallback.requires.node || '>=18').replace(/[^\d.]/g, '');
  const nodeOk = u.atLeast(u.ver(process.version), u.ver(/\./.test(nodeNeed) ? nodeNeed : nodeNeed + '.0') || [18, 0, 0]);
  if (!(useOfficial && ok)) {
    const npmFound = u.findAll('npm')[0];
    if (!npmFound) { say('Запасной путь npm недоступен: npm не найден.'); }
    else if (!nodeOk) { say('Запасной путь npm для ' + p.label + ' требует Node ' + nodeNeed + ' или новее (сейчас ' + process.version + '): без него установка упадёт с непонятной ошибкой, поэтому не запускаю. Обновление Node решает человек (старая версия общая для его проектов); официальный установщик можно повторить.'); }
    else {
      how = 'npm';
      let r = runInherit(ip.fallback.run, 600000);
      if (!r.ok) {
        // EACCES: повтор с префиксом в домашней папке, не sudo
        say('npm не смог записать в общую папку: повторяю с префиксом в домашней папке (без sudo).');
        r = runInherit(ip.fallback.retryOnEacces, 600000);
      }
      for (const post of ip.fallback.post) runInherit(post, 120000);
      ok = r.ok;
      d = p.detect();
      if (ok && !d.console) ok = false;
    }
  }
  const version = d.primary ? d.primary.version : null;
  state.addInstall(s, { id: name, how, command: useOfficial && how === 'official' ? ip.primary.display : 'npm install -g ' + (name === 'codex' ? '@openai/codex' : '@anthropic-ai/claude-code'), ok, version, declared: how === 'official' && ok ? declared : [], confirmation: conf });
  if (stage) {
    if (ok) state.setStage(s, stage, 'done', 'installed', p.name + ' ' + version + ' (' + how + ')');
    else state.setStage(s, stage, 'failed', null, 'установка не удалась (' + how + ')');
  }
  state.save(o.root, s);
  state.log(o.root, (ok ? 'поставлено: ' : 'НЕ поставлено: ') + p.label + (version ? ' ' + version : '') + ' (' + how + ')');
  if (ok) {
    say('Готово: ' + p.label + ' ' + version + ' по полному пути ' + u.tilde(d.primary._abs) + '. Вызывай её по этому пути: профили оболочки я не правил.');
    const binDir = path.dirname(d.primary._abs);
    const inPath = u.pathDirs().some((x) => u.same(x, binDir));
    say(inPath ? 'Папка ' + u.tilde(binDir) + ' есть в PATH этого окна.' : 'Папки ' + u.tilde(binDir) + ' нет в PATH этого окна. Проверь в НОВОМ окне терминала: `' + (u.IS_WIN ? 'where.exe ' : 'command -v ') + p.program + '`. Не видно и там: запускай по полному пути выше' + (u.IS_WIN ? '.' : ', а строку PATH в профиль допиши только с «да» человека: `node .workplace/core/cli/wp.js path-fix --yes` (запись будет объявлена).'));
    say('Вход в аккаунт делает человек в браузере: ' + p.installPlan({ platform: process.platform }).login.how);
  } else say('Не вышло. Покажи человеку текст ошибки дословно: три одинаковые ошибки подряд значит остановиться и спросить. Подсказки по этапам: docs/troubleshooting.md.');
  return { ok, how, version };
}

// ---------- PATH в профиль оболочки (Mac и Linux), только по «да» ----------
// План без записи: какой профиль и какая строка. Чистая функция (тестируется на любой системе): o = { shell, home, platform, dirs: [папки с программами вне PATH] }.
function pathFixPlan(o) {
  if (o.platform === 'win32') return { error: 'На Windows PATH пользователя правят сами установщики (реестр), wp.js профили не правит: открой новое окно PowerShell или вызывай программу по полному пути.' };
  const shell = path.basename(String(o.shell || '')).toLowerCase();
  const profile = shell === 'zsh' ? '.zshrc' : shell === 'bash' ? (o.platform === 'darwin' ? '.bash_profile' : '.bashrc') : '.profile';
  const home = o.home.replace(/\\/g, '/');
  const homes = [...new Set([home, u.realish(o.home).replace(/\\/g, '/')])];   // на Mac домашняя папка может быть дана через ссылку (/var), а путь программы - настоящий (/private/var)
  const lines = [];
  for (const d of o.dirs) {
    const dd = d.replace(/\\/g, '/');
    const h = homes.find((x) => dd === x || dd.startsWith(x + '/'));
    if (!h) continue;   // только папки внутри домашней: системные папки не правим
    lines.push('export PATH="$HOME' + dd.slice(h.length) + ':$PATH"');
  }
  return { profile, file: path.join(o.home, profile), lines: [...new Set(lines)] };
}
// Папка Node для PATH (Mac без поддерживаемого Homebrew: Node из архива лежит в ~/.local/node/bin, и wp.js запущен именно им): только если папка внутри домашней и её ещё нет в PATH.
// Системные папки Node (/usr/local/bin, Program Files) не правим.
function nodeDirForPath(execPath, home, pathDirs) {
  const dir = path.dirname(execPath);
  return u.within(home, dir) && !pathDirs.some((x) => u.same(x, dir)) ? dir : null;
}
function pathFix(o, say) {
  const dirs = [];
  for (const name of ['claude', 'codex']) {
    const d = providers.get(name).detect();
    if (!d.primary) continue;
    const dir = path.dirname(d.primary._abs);
    if (!u.pathDirs().some((x) => u.same(x, dir)) && !dirs.includes(dir)) dirs.push(dir);
  }
  // Node, поставленный архивом в ~/.local/node (Mac без Homebrew): wp.js запущен этим Node, и его папки в PATH нет. Системные папки Node (вне домашней) не правим.
  const nodeDir = nodeDirForPath(process.execPath, u.homeDir(), u.pathDirs());
  const nodeAdded = !!nodeDir && !dirs.includes(nodeDir);
  if (nodeAdded) dirs.push(nodeDir);
  const pl = pathFixPlan({ shell: process.env.SHELL, home: u.homeDir(), platform: process.platform, dirs });
  if (pl.error) throw new u.WpError(pl.error, 3);
  if (!dirs.length) { say('Папки программ уже видны в PATH этого окна: править профиль не нужно.'); return { ok: true, added: 0 }; }
  if (!pl.lines.length) { say('Программы лежат вне домашней папки (' + dirs.map(u.tilde).join(', ') + '): профиль не правлю, покажи путь человеку.'); return { ok: false, added: 0 }; }
  const cur = u.exists(pl.file) ? fs.readFileSync(pl.file, 'utf8') : '';
  const todo = pl.lines.filter((l) => !cur.includes(l));
  if (nodeAdded) say('ПРЕДУПРЕЖДЕНИЕ человеку: папка Node (' + u.tilde(nodeDir) + ') встанет в PATH ПЕРВОЙ. В новых окнах терминала команда `node` будет этой копией (' + process.version + '), а не другой, если она у вас есть. Сторожа запускают `node` по PATH, поэтому после записи программу ИИ нужно закрыть и открыть заново в новом окне терминала.');
  say('Профиль оболочки: ' + u.tilde(pl.file) + '. Допишу в конец: ' + (todo.length ? todo.join(' ; ') : '(ничего: эти строки уже есть)') + '.');
  if (!todo.length) return { ok: true, added: 0 };
  if (o.dryRun) { say('Пробный запуск: ничего не записано.'); return { ok: true, added: 0, dry: true }; }
  if (!o.yes) throw new u.WpError('path-fix пишет в профиль оболочки человека: покажи ему строку выше и дождись «да», затем повтори с --yes. Ничего не сделано.', 2);
  const conf = requireHuman(o, 'path-fix', [pl.profile, 'PATH']);
  if (cur) { const bd = path.join(o.root, '.workplace', 'backup-profile'); fs.mkdirSync(bd, { recursive: true }); fs.copyFileSync(pl.file, path.join(bd, pl.profile + '.' + u.stamp())); }
  fs.appendFileSync(pl.file, (cur && !cur.endsWith('\n') ? '\n' : '') + '# PATH для программ ИИ (добавлено установщиком рабочего места ' + u.today() + ')\n' + todo.join('\n') + '\n');
  const s = state.need(o.root);
  const decl = u.tilde(pl.file);
  if (!s.declared.includes(decl)) s.declared.push(decl);
  state.addInstall(s, { id: 'path-fix', how: 'profile', command: todo.join(' ; '), ok: true, declared: [decl], confirmation: conf });
  state.save(o.root, s);
  state.log(o.root, 'PATH дописан в ' + decl + ' (по «да» человека)');
  say('Готово. Копия прежнего профиля: .workplace/backup-profile/. Запись объявлена. Проверь в НОВОМ окне терминала: command -v claude codex.');
  return { ok: true, added: todo.length };
}

function installSystem(name, o, say) {
  const s = state.need(o.root);
  const r0 = recon.collect({ scan: false });
  const pl = plan.buildPlan(r0, { main: config.load(o.root).main, reviewer: config.load(o.root).reviewer, root: o.root });
  const step = pl.steps.find((x) => x.stage === 'P1.' + name);
  if (!step) throw new u.WpError('Неизвестный пункт: ' + name + '. Можно: claude, codex, python, git.', 2);
  if (step.status === 'done') { say(step.title + ' уже есть (' + (step.note || '') + '): не переустанавливаю.'); return { ok: true, how: 'present' }; }
  const cmd = (step.commands || [])[0];
  if (!cmd) throw new u.WpError('Для ' + name + ' нет команды установки.', 1);
  say('Ставлю: ' + step.title + '. Команда: ' + cmd.display + ' (' + cmd.source + ').');
  if (cmd.human || !cmd.run) { say('Этот шаг делает человек сам (системное окно или установщик с сайта): ' + cmd.display + '. Пароль компьютера вводит человек.'); state.setStage(s, 'P1.' + name, 'needs-human', null, cmd.display); state.save(o.root, s); return { ok: false, how: 'human' }; }
  if (o.dryRun) { say('Пробный запуск: ничего не выполнялось.'); return { ok: true, how: 'dry-run' }; }
  if (!o.yes) throw new u.WpError('install пишет на диск: покажи это человеку и дождись «да», затем повтори с --yes. Ничего не сделано.', 2);
  const conf = requireHuman(o, 'install ' + name, [name]);
  const r = runInherit(cmd.run, 900000);
  state.addInstall(s, { id: name, how: cmd.run.cmd, command: cmd.display, ok: r.ok, declared: [], confirmation: conf });
  state.setStage(s, 'P1.' + name, r.ok ? 'done' : 'failed', r.ok ? 'installed' : null, r.ok ? cmd.display : 'код ' + (r.code === null ? r.error : r.code));
  state.save(o.root, s);
  state.log(o.root, (r.ok ? 'поставлено: ' : 'НЕ поставлено: ') + step.title + ' (' + cmd.run.cmd + ')');
  say(r.ok ? 'Команда отработала. Проверь программу в НОВОМ процессе (PATH): wp.js verify P1.' + name : 'Не вышло: покажи человеку текст ошибки дословно.');
  return { ok: r.ok, how: cmd.run.cmd };
}

function install(name, o, say) {
  if (name === 'claude' || name === 'codex') return installProvider(name, o, say);
  if (name === 'python' || name === 'git') return installSystem(name, o, say);
  if (name === 'node') throw new u.WpError('Node ставится до wp.js (скрипты сами на Node): команды показывает `plan` и docs/recon-without-node.md.', 2);
  throw new u.WpError('Можно ставить: claude, codex, python, git.', 2);
}

module.exports = { NATIVE_PROMPT_ONLY, requireHuman, install, installProvider, installSystem, pathFix, pathFixPlan, nodeDirForPath, PROFILES, runCapture };
