'use strict';
// Установка недостающих программ после «да» человека: `wp.js install claude|codex|python|git --yes`.
// Зачем отдельная команда: установка идёт одним вызовом, записывается в состояние и журнал (что, откуда, чем кончилось, какие записи вне корня объявлены),
// а сторож опасных команд не видит в тексте команды цепочку `скачать | выполнить` (она внутри скрипта и только после «да»).
// Только официальные установщики и менеджеры пакетов (winget, brew). Пароль и права администратора человек вводит сам: команда их не просит и не обходит.
// Node ставится ДО wp.js (скрипты сами на Node): его команды показывает `plan`, здесь Node не ставится.
const cp = require('child_process');
const path = require('path');
const nodeUtil = require('util');
const u = require('./util');
const state = require('./state');
const config = require('./config');
const consent = require('./consent');
const providers = require('../providers');
const recon = require('./recon');
const plan = require('./plan');

const fs = require('fs');
const PROFILES = ['~/.zprofile', '~/.zshrc', '~/.zshenv', '~/.bash_profile', '~/.bashrc', '~/.profile'];

// Установщики Windows (PowerShell) зовут `tar` по имени. Если ИИ работает в Git Bash, впереди PATH стоит GNU tar из Git\usr\bin: он принимает «C:» за имя удалённого компьютера,
// и распаковка падает. В обычном окне PowerShell впереди стоит System32 (tar.exe системы), поэтому установщику даём такой же порядок.
function systemFirst(env) {
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'Path';
  const sys = path.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32');
  env[key] = [sys].concat(String(env[key] || '').split(path.delimiter).filter((x) => x && !u.same(x, sys))).join(path.delimiter);
  return env;
}
function runInherit(spec, timeoutMs, extraEnv) {
  let env = u.childEnv(Object.assign({}, spec.env || {}, extraEnv || {}));
  if (u.IS_WIN && /^powershell(\.exe)?$/i.test(spec.cmd)) env = systemFirst(env);
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
//    с пометкой «не проверено пакетом: ...» и verified: false. Слова «подтверждено» отчёт для этого случая не пишет: пакет не знает, появилось ли окно разрешения и нажал ли человек.
// Возвращает запись о подтверждении для state.installs.
const NATIVE_PROMPT_ONLY = 'не проверено пакетом: подтвердить должен был человек в окне разрешения программы; если программа работала без запросов, подтверждения не было';
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

// Файл, который официальный установщик создал сам (Claude Code на Windows создаёт ~/.claude/settings.json с autoUpdatesChannel), объявляется: иначе сверка файлов вне главной папки поднимет тревогу.
// Объявляется только: (1) файла не было, он появился, и после разбора JSON в нём ровно один верхний ключ autoUpdatesChannel; (2) файл был, и разница сводится к ключу autoUpdatesChannel (остальные ключи совпадают).
// Любое другое изменение остаётся тревогой: это может быть чужая запись во время установки или неожиданная настройка.
const SETTINGS_OWN_KEY = 'autoUpdatesChannel';
function onlyOwnKeyDiffers(before, after) {
  let a; let b;
  try { a = JSON.parse(before); b = JSON.parse(after); } catch (_) { return false; }
  const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
  if (!isObj(a) || !isObj(b)) return false;
  delete a[SETTINGS_OWN_KEY]; delete b[SETTINGS_OWN_KEY];
  return nodeUtil.isDeepStrictEqual(a, b);
}
function onlyOwnKey(text) {
  let j;
  try { j = JSON.parse(text); } catch (_) { return false; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return false;
  const keys = Object.keys(j);
  return keys.length === 1 && keys[0] === SETTINGS_OWN_KEY;
}
function selfWritten(file, textBefore) {
  const now = u.exists(file) ? fs.readFileSync(file, 'utf8') : null;
  if (now === null || now === textBefore) return null;
  if (textBefore === null) return onlyOwnKey(now) ? u.tilde(file) : null;
  return onlyOwnKeyDiffers(textBefore, now) ? u.tilde(file) : null;
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
  const settingsFile = name === 'claude' ? path.join(u.claudeHome(), 'settings.json') : null;
  const settingsBefore = settingsFile && u.exists(settingsFile) ? fs.readFileSync(settingsFile, 'utf8') : null;
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
  const wrote = settingsFile && how === 'official' && ok ? selfWritten(settingsFile, settingsBefore) : null;
  if (wrote) { declared.push(wrote); say('Установщик Claude Code сам создал или изменил ' + wrote + ' (настройки программы, например канал обновлений): запись объявлена.'); }
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
    say(inPath ? 'Папка ' + u.tilde(binDir) + ' есть в PATH этого окна.' : 'Папки ' + u.tilde(binDir) + ' нет в PATH этого окна. Проверь в НОВОМ окне терминала: `' + (u.IS_WIN ? 'where.exe ' : 'command -v ') + p.name + '`. Не видно и там: запускай по полному пути выше, а ' + (u.IS_WIN ? 'папку в PATH пользователя допиши' : 'строку PATH в профиль допиши') + ' только с «да» человека: `node .workplace/core/cli/wp.js path-fix --yes` (запись будет объявлена).');
    say('Вход в аккаунт делает человек в браузере: ' + p.installPlan({ platform: process.platform }).login.how);
  } else say('Не вышло. Покажи человеку текст ошибки дословно: три одинаковые ошибки подряд значит остановиться и спросить. Подсказки по этапам: docs/troubleshooting.md.');
  return { ok, how, version };
}

// ---------- PATH в профиль оболочки (Mac и Linux), только по «да» ----------
// План без записи: какой профиль и какая строка. Чистая функция (тестируется на любой системе): o = { shell, home, platform, dirs: [папки с программами вне PATH] }.
function pathFixPlan(o) {
  if (o.platform === 'win32') return { error: 'На Windows профили оболочки не правятся: PATH пользователя в реестре правит path-fix отдельной веткой (pathFixWin).' };
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
// ---------- PATH пользователя в реестре (Windows), только по «да» ----------
// Официальный установщик Claude Code на Windows папку ~/.local/bin в PATH не добавляет (пишет только «Setup notes»), и в новом окне claude не находится.
// Читаем сырое значение HKCU\Environment\Path и его тип; пишем ОДНИМ шагом сразу с прежним типом (REG_EXPAND_SZ не превращается в REG_SZ, промежуточного значения без раскрытия %VAR% нет).
// После записи отдельным коротким вызовом рассылаем системе сообщение об изменении окружения (WM_SETTINGCHANGE) и проверяем его результат: ноль или таймаут значит «не разослано».
// Сверка (значение и тип читаем заново и сравниваем с записанными) выполняется всегда, даже если рассылка не удалась.
// Запись больше 32767 символов отклоняется, больше 8191 - с предупреждением (cmd.exe игнорирует такую переменную в наследуемом окружении).
// Откуда читать и куда писать PATH, решает бэкенд. В рабочем коде он один - реестр. Подмены через окружение, файлы или временные папки нет: тесты ставят свой бэкенд
// функцией __setUserPathBackendForTests в своём же процессе (tests/lib/wp-with-backend.js), настоящий реестр они не трогают.
const PATH_LIMIT_HARD = 32767;
const PATH_LIMIT_CMD = 8191;
const REG_KINDS = ['String', 'ExpandString'];
const PS_READ = "$k = Get-Item 'HKCU:\\Environment'; $raw = ''; $kind = 'ExpandString'; if ($k.GetValueNames() -contains 'Path') { $raw = [string]$k.GetValue('Path', '', 'DoNotExpandEnvironmentNames'); $kind = $k.GetValueKind('Path').ToString() }; $m = [string][Environment]::GetEnvironmentVariable('Path', 'Machine'); ConvertTo-Json -Compress -InputObject @{ user = $raw; kind = $kind; machine = $m }";
const PS_WRITE = [
  "$ErrorActionPreference = 'Stop'",
  "$new = $env:WP_NEW_USER_PATH",
  "$kind = [Enum]::Parse([Microsoft.Win32.RegistryValueKind], $env:WP_USER_PATH_KIND)",
  "[Microsoft.Win32.Registry]::SetValue('HKEY_CURRENT_USER\\Environment', 'Path', $new, $kind)",
  "Write-Output 'written'",
].join('; ');
// Рассылка отдельным вызовом: короткий предел на каждое окно (2 секунды, зависшие окна пропускаются) и свой короткий предел на весь вызов. Результат функции проверяется: 0 значит сбой или таймаут.
const PS_NOTIFY = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -Namespace Wp -Name Native -MemberDefinition '[DllImport(\"user32.dll\", SetLastError=true, CharSet=CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);'",
  "$res = [UIntPtr]::Zero",
  "$r = [Wp.Native]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 2000, [ref]$res)",
  "if ($r -ne [IntPtr]::Zero) { Write-Output 'notified' } else { Write-Output 'notify-zero' }",
].join('; ');
const WRITE_TIMEOUT_MS = 30000;
const NOTIFY_TIMEOUT_MS = 10000;
function runPs(script, env, timeoutMs) {
  return u.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { timeout: timeoutMs || WRITE_TIMEOUT_MS, env });
}
// Итог рассылки по ответу PowerShell: разослано только если скрипт сам написал 'notified' (то есть функция вернула не ноль). Всё остальное - не разослано.
function interpretNotify(r) {
  if (r && r.ok && /^notified$/m.test(String(r.out || ''))) return { notified: true };
  const why = !r ? 'нет ответа' : r.timedOut ? 'таймаут' : /notify-zero/.test(String(r.out || '')) ? 'система вернула ноль: сбой или таймаут' : 'PowerShell не выполнил рассылку';
  return { notified: false, why };
}
// Бэкенд реестра: read() -> { user, machine, kind } или null; write(value, kind) -> { ok }; notify() -> { notified, why? }.
const registryBackend = {
  kind: 'registry',
  read() {
    const r = runPs(PS_READ);
    let j = null;
    try { j = JSON.parse(r.out); } catch (_) { j = null; }
    return r.ok && j ? { user: String(j.user || ''), machine: String(j.machine || ''), kind: String(j.kind || 'ExpandString') } : null;
  },
  write(value, kind) {
    const r = runPs(PS_WRITE, { WP_NEW_USER_PATH: value, WP_USER_PATH_KIND: kind }, WRITE_TIMEOUT_MS);
    return { ok: r.ok };
  },
  notify() { return interpretNotify(runPs(PS_NOTIFY, null, NOTIFY_TIMEOUT_MS)); },
};
let testBackend = null;
// ТОЛЬКО для кода тестов в том же процессе. Рабочий код её не вызывает, окружение и файлы на выбор бэкенда не влияют.
function __setUserPathBackendForTests(be) {
  if (be !== null && !(be && typeof be.read === 'function' && typeof be.write === 'function' && typeof be.notify === 'function')) throw new Error('бэкенд PATH для тестов: нужны read, write, notify');
  testBackend = be;
}
function userPathBackend() { return testBackend || registryBackend; }
function winUserPath(be) { return be.read(); }
// Одна запись: значение и тип вместе. Возвращает { ok }.
function winPathWrite(be, value, kind) {
  if (!REG_KINDS.includes(kind)) return { ok: false };
  const w = be.write(value, kind);
  return { ok: !!(w && w.ok) };
}
// Рассылка никогда не бросает исключение и не отменяет сверку. Возвращает { notified, why? }.
function winPathNotify(be) {
  try { const n = be.notify(); return n && n.notified ? { notified: true } : { notified: false, why: n && n.why }; } catch (e) { return { notified: false, why: String(e && e.message || e) }; }
}
const NOT_NOTIFIED = ' Не разослано, нужен перезапуск программ: система не получила сообщение об изменении PATH, поэтому открытые программы и новые окна могут не увидеть его до перезапуска программы или входа в систему';
const notifiedText = (n) => (n.notified ? '' : NOT_NOTIFIED + (n.why ? ' (' + n.why + ')' : '') + '.');
// Значение и тип после записи должны совпасть с записанными. Возвращает null или текст расхождения.
function winPathVerify(be, value, kind) {
  const after = winUserPath(be);
  if (!after) return 'не удалось прочитать PATH пользователя после записи';
  if (after.kind !== kind) return 'тип значения после записи ' + after.kind + ', ожидался ' + kind;
  if (after.user !== value) return 'значение после записи не совпало с записанным';
  return null;
}
// Запись, рассылка, сверка. Рассылка не отменяет сверку: значение и тип читаются заново всегда, даже если система не получила сообщение.
function writeAndVerify(be, value, kind) {
  if (!winPathWrite(be, value, kind).ok) return { written: false };
  const nt = winPathNotify(be);
  return { written: true, nt, bad: winPathVerify(be, value, kind) };
}
const KIND_LABEL = { String: 'REG_SZ', ExpandString: 'REG_EXPAND_SZ' };
const expandEnv = (x) => String(x).replace(/%([^%]+)%/g, (m, n) => (process.env[n] !== undefined ? process.env[n] : m));
const backupDir = (root) => path.join(root, '.workplace', 'backup-profile');
// Копия прежнего PATH: точное значение и тип (JSON сохраняет пробелы и точки с запятой на концах).
function saveUserPathBackup(root, cur, prefix) {
  fs.mkdirSync(backupDir(root), { recursive: true });
  const f = path.join(backupDir(root), (prefix || 'user-path') + '.' + u.stamp() + '.json');
  fs.writeFileSync(f, JSON.stringify({ schema: 1, kind: cur.kind, value: cur.user, savedAt: new Date().toISOString() }, null, 2) + '\n');
  return f;
}
const BACKUP_NAME = /^user-path(-before-restore)?\.\d{8}-\d{6}\.json$/;
function listUserPathBackups(root) {
  let names = [];
  try { names = fs.readdirSync(backupDir(root)); } catch (_) { names = []; }
  return names.filter((n) => BACKUP_NAME.test(n)).sort();
}
// По умолчанию --restore берёт последнюю копию самого path-fix (user-path.*): повторный возврат не прыгает туда-сюда между страховочными копиями.
// Страховочную копию перед возвратом (user-path-before-restore.*) выбирают явно: --from <имя>.
function latestUserPathBackup(root) {
  const name = listUserPathBackups(root).filter((n) => /^user-path\.\d/.test(n)).pop();
  return name ? path.join(backupDir(root), name) : null;
}
function chooseBackup(root, from) {
  if (!from) return latestUserPathBackup(root);
  const given = String(from);
  const name = path.basename(given);
  const dir = path.dirname(given);
  if (dir !== '.' && !u.same(path.resolve(dir), backupDir(root))) throw new u.WpError('path-fix --restore --from: копию берут только из .workplace/backup-profile/ (дано: ' + given + '). Ничего не сделано.', 2);
  if (!listUserPathBackups(root).includes(name)) throw new u.WpError('path-fix --restore --from: копии «' + name + '» в .workplace/backup-profile/ нет. Есть: ' + (listUserPathBackups(root).join(', ') || '(ничего)') + '. Ничего не сделано.', 1);
  return path.join(backupDir(root), name);
}
function pathFixWin(o, say) {
  const be = userPathBackend();
  if (o.restore) return pathRestoreWin(o, say, be);
  const cur = winUserPath(be);
  if (!cur) { say('Не удалось прочитать PATH пользователя из реестра (PowerShell не ответил). Ничего не записано: вызывай программы по полному пути.'); return { ok: false, added: 0 }; }
  if (!REG_KINDS.includes(cur.kind)) throw new u.WpError('path-fix: PATH пользователя в реестре имеет необычный тип (' + cur.kind + '): не трогаю. Покажи это человеку. Ничего не сделано.', 3);
  const have = (cur.user + ';' + cur.machine).split(';').map((x) => expandEnv(x.trim().replace(/^"|"$/g, ''))).filter(Boolean);
  const dirs = [];
  const outside = [];
  for (const name of ['claude', 'codex']) {
    const d = providers.get(name).detect();
    if (!d.primary) continue;
    const dir = path.dirname(d.primary._abs);
    if (!dir || have.some((x) => u.same(x, dir)) || dirs.includes(dir) || outside.includes(dir)) continue;
    (u.within(u.homeDir(), dir) ? dirs : outside).push(dir);
  }
  if (outside.length) say('Папки вне домашней (' + outside.map(u.tilde).join(', ') + ') в PATH не добавляю: покажи путь человеку.');
  if (!dirs.length) { if (!outside.length) say('Папки программ уже есть в PATH пользователя (реестр): править не нужно.'); return { ok: !outside.length, added: 0 }; }
  const base = cur.user.replace(/[;\s]+$/, '');
  const value = (base ? base + ';' : '') + dirs.join(';');
  say('PATH пользователя (реестр, HKCU\\Environment\\Path). Допишу в конец: ' + dirs.map(u.tilde).join(' ; ') + '. Остальные записи и тип значения (' + KIND_LABEL[cur.kind] + ') не меняются.');
  if (value.length > PATH_LIMIT_HARD) throw new u.WpError('path-fix: PATH пользователя после записи был бы ' + value.length + ' символов, а Windows принимает не больше ' + PATH_LIMIT_HARD + '. Ничего не записано. Покажи это человеку: лишние записи в PATH он убирает сам.', 3);
  if (value.length > PATH_LIMIT_CMD) say('ПРЕДУПРЕЖДЕНИЕ: PATH пользователя станет ' + value.length + ' символов (больше ' + PATH_LIMIT_CMD + '): cmd.exe и часть программ такой PATH в наследуемом окружении не читают. Покажи это человеку.');
  if (o.dryRun) { say('Пробный запуск: ничего не записано.'); return { ok: true, added: 0, dry: true }; }
  if (!o.yes) throw new u.WpError('path-fix пишет PATH пользователя: покажи человеку строку выше и дождись «да», затем повтори с --yes. Ничего не сделано.', 2);
  const conf = requireHuman(o, 'path-fix', ['PATH']);
  const bf = saveUserPathBackup(o.root, cur);
  const wv = writeAndVerify(be, value, cur.kind);
  if (!wv.written) throw new u.WpError('path-fix: PowerShell не смог записать PATH пользователя. Прежнее значение: .workplace/backup-profile/. Покажи человеку и вызывай программы по полному пути.', 1);
  const nt = wv.nt; const bad = wv.bad;
  if (bad) throw new u.WpError('path-fix: запись выполнена, но ' + bad + '. Прежнее значение (с типом) лежит в .workplace/backup-profile/ ; вернуть: node .workplace/core/cli/wp.js path-fix --restore --yes (после «да» человека).', 1);
  const s = state.need(o.root);
  const decl = 'реестр: PATH пользователя';
  if (!s.declared.includes(decl)) s.declared.push(decl);
  state.addInstall(s, { id: 'path-fix', how: 'registry', command: dirs.map(u.tilde).join(' ; '), ok: true, declared: [decl], confirmation: conf });
  state.save(o.root, s);
  state.log(o.root, 'PATH пользователя (реестр) дополнен: ' + dirs.map(u.tilde).join(' ; ') + ' (по «да» человека)');
  say('Записано одним шагом, прочитано заново: тип ' + KIND_LABEL[cur.kind] + ', значение совпало (' + value.length + ' символов).' + notifiedText(nt));
  say('Прежнее значение и тип: ' + u.tilde(bf).replace(/\\/g, '/') + ' ; вернуть: node .workplace/core/cli/wp.js path-fix --restore --yes (после «да» человека). Запись объявлена. Проверь в НОВОМ окне PowerShell: where.exe claude codex.');
  return { ok: true, added: dirs.length };
}
// Записи из a, которых не хватает в b, с учётом количества (две одинаковые записи в a и одна в b дают одну лишнюю).
function multiDiff(a, b) {
  const left = new Map();
  for (const e of b) left.set(e, (left.get(e) || 0) + 1);
  const out = [];
  for (const e of a) { const n = left.get(e) || 0; if (n > 0) left.set(e, n - 1); else out.push(e); }
  return out;
}
// Вернуть PATH пользователя из копии (значение и тип), только по «да» человека. По умолчанию берётся последняя user-path.*; --from <имя> выбирает любую копию в .workplace/backup-profile/, в том числе страховочную user-path-before-restore.*.
// Текущее значение перед возвратом тоже сохраняется.
function pathRestoreWin(o, say, be) {
  const bf = chooseBackup(o.root, o.from);
  if (!bf) throw new u.WpError('path-fix --restore: копии PATH пользователя в .workplace/backup-profile/ нет. Ничего не сделано.', 1);
  let b = null;
  try { b = JSON.parse(fs.readFileSync(bf, 'utf8')); } catch (_) { b = null; }
  if (!b || typeof b.value !== 'string' || !REG_KINDS.includes(b.kind)) throw new u.WpError('path-fix --restore: копия ' + path.basename(bf) + ' повреждена (нет значения или типа). Ничего не сделано.', 1);
  if (b.value.length > PATH_LIMIT_HARD) throw new u.WpError('path-fix --restore: значение в копии длиннее ' + PATH_LIMIT_HARD + ' символов. Ничего не сделано.', 1);
  const cur = winUserPath(be);
  if (!cur) { say('Не удалось прочитать PATH пользователя из реестра (PowerShell не ответил). Ничего не записано.'); return { ok: false, added: 0 }; }
  if (cur.user === b.value && cur.kind === b.kind) { say('PATH пользователя уже равен копии ' + path.basename(bf) + ': возвращать нечего.'); return { ok: true, added: 0 }; }
  const split = (x) => x.split(';').filter((e) => e.trim());
  const now = split(cur.user); const was = split(b.value);
  const removed = multiDiff(now, was); const added = multiDiff(was, now);
  say('Верну PATH пользователя из копии ' + path.basename(bf) + ' (тип ' + KIND_LABEL[b.kind] + ', ' + b.value.length + ' символов). Сейчас: ' + KIND_LABEL[cur.kind] + ', ' + cur.user.length + ' символов. Уберу: ' + (removed.length ? removed.map(u.tilde).join(' ; ') : '(ничего)') + '. Верну: ' + (added.length ? added.map(u.tilde).join(' ; ') : '(ничего)') + '.');
  if (o.dryRun) { say('Пробный запуск: ничего не записано.'); return { ok: true, added: 0, dry: true }; }
  if (!o.yes) throw new u.WpError('path-fix --restore пишет PATH пользователя: покажи человеку строку выше и дождись «да», затем повтори с --yes. Ничего не сделано.', 2);
  const conf = requireHuman(o, 'path-fix --restore', ['PATH']);
  const before = saveUserPathBackup(o.root, cur, 'user-path-before-restore');
  const wv = writeAndVerify(be, b.value, b.kind);
  if (!wv.written) throw new u.WpError('path-fix --restore: PowerShell не смог записать PATH пользователя. Текущее значение сохранено: .workplace/backup-profile/. Покажи человеку.', 1);
  const nt = wv.nt; const bad = wv.bad;
  if (bad) throw new u.WpError('path-fix --restore: запись выполнена, но ' + bad + '. Значение до восстановления: ' + path.basename(before) + ' в .workplace/backup-profile/.', 1);
  const s = state.need(o.root);
  const decl = 'реестр: PATH пользователя';
  if (!s.declared.includes(decl)) s.declared.push(decl);
  state.addInstall(s, { id: 'path-fix-restore', how: 'registry', command: 'PATH пользователя возвращён из ' + path.basename(bf), ok: true, declared: [decl], confirmation: conf });
  state.save(o.root, s);
  state.log(o.root, 'PATH пользователя (реестр) возвращён из копии ' + path.basename(bf) + ' (по «да» человека)');
  say('Готово: тип ' + KIND_LABEL[b.kind] + ', значение совпало с копией. Значение до восстановления: .workplace/backup-profile/' + path.basename(before) + '. Вернуть обратно: node .workplace/core/cli/wp.js path-fix --restore --from ' + path.basename(before) + ' --yes (после «да» человека).' + notifiedText(nt));
  return { ok: true, added: 0 };
}
function pathFix(o, say) {
  if (process.platform === 'win32') return pathFixWin(o, say);
  if (o.restore) throw new u.WpError('path-fix --restore: на Mac и Linux копия профиля лежит в .workplace/backup-profile/<профиль>.<дата>. Верни её вручную: покажи человеку разницу, получи «да», затем скопируй файл на место профиля. Ничего не сделано.', 2);
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

module.exports = { NATIVE_PROMPT_ONLY, selfWritten, userPathBackend, __setUserPathBackendForTests, interpretNotify, multiDiff, writeAndVerify, chooseBackup, saveUserPathBackup, notifiedText, PS_WRITE, PS_NOTIFY, PATH_LIMIT_HARD, PATH_LIMIT_CMD, requireHuman, install, installProvider, installSystem, pathFix, pathFixPlan, nodeDirForPath, PROFILES, runCapture };
