#!/usr/bin/env node
'use strict';
// Сторож опасных команд. PreToolUse на оболочке (Bash, shell, shell_command, local_shell, unified_exec, PowerShell) и на записи файлов инструментами
// (Write, Edit, MultiEdit, NotebookEdit у Claude Code, apply_patch у Codex), один скрипт для Claude Code и Codex.
// Написан на core/lib/shell-lex.js: команда это или текст решает позиция слова, поэтому echo "rm -rf /" и git commit -m "sudo" не срабатывают.
//
// Что решает сторож. Нарушитель по сути один: невнимательный агент, не злоумышленник. Поэтому «нет» только там, где его не снимает никто, кроме человека руками,
// а всё остальное идёт по подтверждению человека (core/lib/consent.js):
//  НЕТ (делает сам человек):
//   - повышение прав (sudo, su, runas, RunAs), пароль администратора; диски (mkfs, diskpart, format, diskutil erase, dd на устройство);
//   - корень диска, домашняя папка целиком, системные папки (/etc, /usr, C:\Windows ...), весь корень рабочего места и служебная папка .workplace;
//   - запись в файлы подтверждения (`.workplace/human-messages.json`, `consent-plan.json`) и запуск хука, который их пишет;
//   - путь, куда указывает команда, проверить нельзя ($VAR, подстановка): подтвердить нечего, нужен настоящий полный путь.
//  «ДА» ЧЕЛОВЕКА (последнее сообщение человека содержит «да» или «yes») И НАЗВАННАЯ ЦЕЛЬ (путь или программа названы в последних двух сообщениях человека
//  или в плане, на который он ответил «да»; `wp.js consent plan`):
//   - удаление вне главной папки и временных папок (rm, rmdir, del, Remove-Item, find -delete, shred);
//   - запись вне главной папки: инструментами (Write, Edit, apply_patch) и командами (перенаправление, tee, cp, mv, sed -i, Set-Content ...), профили оболочки,
//     ~/.ssh, настройки VS Code, ~/.claude, ~/.codex, проект человека; перед правкой существующего файла сторож сам кладёт копию в `.workplace/backups/`;
//   - установка и обновление программ (npm -g, pip --user, pipx, brew, winget, choco, scoop, claude update, официальные установщики и скачать-и-выполнить);
//   - рекурсивные chmod, chown, icacls /t и takeown /r вне корня.
//  ТОЛЬКО «ДА» (цель не нужна): git reset --hard, clean -f, откат всех правок, перезапись истории, push --force, запись в общую настройку git, npm publish,
//   завершение процессов по имени, выключение, setx.
//  БЕЗ СТЕНЫ: git push и коммит в проектах человека; push идёт по прямой просьбе человека (push, пуш, отправь, залей...) или после его «да».
// Метка `# CONFIRMED` в команде больше ничего не значит: подтверждает только сообщение человека, которое пишет хук human-message.js, а ИИ в этот файл писать не может.
// Если сообщений человека нет (хук не подключён или не доверен), сторож честно отвечает «подтвердить нечем»: действие делает сам человек.
const path = require('path');
const fs = require('fs');
const hookIo = require('../lib/hook-io');
const cfgLib = require('../lib/config');
const lex = require('../lib/shell-lex');
const u = require('../lib/util');
const consent = require('../lib/consent');
const backup = require('../lib/backup');
const common = require('./_common');
const sh = require('./_shell');

// Адреса официальных установщиков: один источник с core/providers/*.installPlan (core/lib/installers.js). Это установка программы: нужно «да» человека и название программы.
const INST = require('../lib/installers');
const OFFICIAL_INSTALLERS = new Set(INST.OFFICIAL_INSTALLER_URLS);
const OFFICIAL_NAME = {};
for (const [name, urls] of Object.entries(INST.INSTALLERS)) for (const x of Object.values(urls)) OFFICIAL_NAME[x] = name;

// ---------- таблицы ----------
const DOWNLOADERS = new Set(['curl', 'wget', 'iwr', 'irm', 'invoke-webrequest', 'invoke-restmethod', 'fetch', 'aria2c']);
const SH_EXEC = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'ash']);
const PS_RUN = new Set(['powershell', 'pwsh']);
const INTERP = new Set(['python', 'python3', 'py', 'node', 'nodejs', 'perl', 'ruby', 'php', 'deno', 'bun']);
const IEX = new Set(['iex', 'invoke-expression']);
const RM_CMDS = new Set(['rm', 'rmdir', 'del', 'erase', 'rd', 'remove-item', 'ri', 'unlink']);
const PS_DELETE = new Set(['remove-item', 'ri']);
const PS_VALUED = new Set(['include', 'exclude', 'filter', 'credential', 'stream', 'erroraction', 'ea', 'warningaction', 'wa', 'errorvariable', 'ev', 'informationaction', 'ia']);
const PROFILE_BASE = new Set(['.zshrc', '.zprofile', '.zshenv', '.zlogin', '.bashrc', '.bash_profile', '.bash_login', '.bash_aliases', '.profile', '.cshrc', '.tcshrc', '.kshrc']);
// Команды, которые меняют файл, названный в аргументах (cat, echo и подобные пишут только через перенаправление: оно проверяется отдельно). Для профилей и личных настроек.
const WRITERS = new Set(['tee', 'sed', 'perl', 'awk', 'cp', 'mv', 'ln', 'install', 'dd', 'truncate', 'add-content', 'ac', 'set-content', 'sc', 'out-file', 'clear-content',
  'new-item', 'ni', 'copy-item', 'copy', 'move-item', 'move', 'mi', 'rename-item', 'ren', 'chmod', 'chown', 'attrib', 'icacls', 'touch',
  'nano', 'vi', 'vim', 'nvim', 'emacs', 'code', 'ed', 'ex', 'sponge']);
// Команды, которые только читают файлы из аргументов: запись в файлы подтверждения ими невозможна.
const READ_ONLY = new Set(['cat', 'type', 'ls', 'dir', 'head', 'tail', 'less', 'more', 'get-content', 'gc', 'grep', 'rg', 'findstr', 'select-string', 'sls', 'jq', 'stat', 'wc', 'test', '[',
  'file', 'get-item', 'get-childitem', 'gci', 'sha256sum', 'shasum', 'get-filehash', 'diff', 'cmp', 'nl', 'od', 'cut', 'echo', 'printf', 'write-output', 'write-host']);

// ---------- тексты ----------
function stop(what, why) { return 'Сторож опасных команд остановил: ' + what + '. ' + why; }
const HUMAN_ONLY = ' Это делает сам человек. Дай ему точную команду, объясни её простыми словами и попроси выполнить самому в терминале.';
const NO_RECORD = 'Подтвердить нечем: сторож не видит сообщений человека (хук human-message не подключён или не доверен; у Codex проекту нужно доверие, команда /hooks; проверка: node .workplace/core/cli/wp.js hooks status). Скажи человеку простыми словами, что именно нужно сделать, дай точную команду и попроси выполнить её самому в терминале.';
const NO_YES = 'В последнем сообщении человека нет «да». Покажи ему простыми словами, что именно ты сделаешь и с чем (полный путь или название) и зачем, и спроси «да». Получив его, повтори то же действие. Метка # CONFIRMED и «да», написанное тобой, не засчитываются: подтверждает только сообщение человека.';
function notNamed(missing) {
  return '«Да» есть, но не названо, к чему оно относится: ' + missing.map(consent.describe).join(', ') + '. Цель должна стоять в последних двух сообщениях человека или в плане, на который он ответил «да». ' +
    'Покажи человеку полный путь или название, зарегистрируй показанное командой node .workplace/core/cli/wp.js consent plan "текст плана", спроси «да» и повтори действие.';
}
const WRITE_TAIL = ' Покажи человеку разницу (что было и что станет). Перед правкой существующего файла сторож сам сохранит его копию в .workplace/backups/.';

// ---------- вспомогательное ----------
function homeRel(p) {
  const h = path.resolve(sh.home());
  const rel = path.relative(h, path.resolve(p));
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}
// Защищённые файлы: профили оболочки, ~/.ssh, личные настройки ИИ и git, профили PowerShell.
function isProtectedHome(p) {
  const norm = String(p).replace(/\\/g, '/');
  if (/\/(WindowsPowerShell|PowerShell)\/(Microsoft\.(PowerShell|VSCode|PowerShellISE)_profile|profile)\.ps1$/i.test(norm)) return true;
  const rel = homeRel(p);
  if (rel === null) return false;
  const r = rel.toLowerCase();
  if (PROFILE_BASE.has(r)) return true;
  if (r === '.config/fish/config.fish' || r === '.gitconfig' || r === '.claude.json') return true;
  if (r === '.ssh' || r.startsWith('.ssh/')) return true;
  return ['.claude/settings.json', '.claude/claude.md', '.claude/settings.local.json', '.codex/config.toml', '.codex/hooks.json', '.codex/agents.md'].includes(r);
}
function targetPath(word, cwd) { return sh.expandTarget(word, cwd).p || null; }

// Рабочие папки самих программ: ИИ пишет туда сам (память, планы, сессии), это не личные настройки человека.
const AI_INTERNAL = [/^\.claude\/(projects|plans|todos|tasks|session-env|shell-snapshots|file-history|cache|paste-cache|ide|statsig|telemetry|debug|logs?)(\/|$)/i,
  /^\.codex\/(sessions|archived_sessions|memories|cache|log|logs|tmp|shell_snapshots)(\/|$)/i];
function aiInternal(p) { const rel = homeRel(p); return rel !== null && AI_INTERNAL.some((rx) => rx.test(rel)); }
// Личные папки навыков, агентов и команд человека: навыки установки лежат в главной папке.
const PERSONAL_DIRS = /^\.(claude\/(skills|agents|commands)|codex\/(prompts|skills)|agents\/skills)(\/|$)/i;
function personalDir(p) { const rel = homeRel(p); return rel !== null && PERSONAL_DIRS.test(rel); }

// Системные папки: администратор, не ИИ.
const SYSTEM_RX = /^(\/(etc|usr|bin|sbin|lib|lib64|boot|dev|proc|sys|System|Library|private\/etc)|[A-Za-z]:\/(Windows|Program Files( \(x86\))?|ProgramData))(\/|$)/i;
function isSystem(abs) { return SYSTEM_RX.test(String(abs).replace(/\\/g, '/')); }
function isFloor(abs) {
  const a = path.resolve(abs);
  const home = path.resolve(sh.home());
  return u.same(a, home) || u.same(a, path.dirname(home)) || a === path.parse(a).root || /^[A-Za-z]:[\\/]?$/.test(String(abs));
}

// Путь относительно корня с прямыми слэшами; ссылки раскрыты с обеих сторон (на Mac /var это ссылка на /private/var, и без этого файл сторожа выглядел бы лежащим вне корня).
function relToRoot(root, abs) { return path.relative(u.realish(root), u.realish(abs)).split(path.sep).join('/'); }

// Где лежит путь: inside (внутри главной папки или временной), root (весь корень), service (.workplace), floor, system, outside.
function classify(abs, zones) {
  const a = path.resolve(abs);
  if (zones.root && u.same(a, zones.root)) return 'root';
  if (sh.strictlyInside(a, zones.zones)) {
    if (zones.root && relToRoot(zones.root, a) === '.workplace') return 'service';
    return 'inside';
  }
  if (isSystem(a)) return 'system';
  if (isFloor(a)) return 'floor';
  return 'outside';
}

const NULLISH = /^(\/dev\/(null|stdout|stderr|stdin|tty|fd\/\d+)|nul|con|\$null|&\d?)$/i;

// ---------- накопитель решений ----------
function newAcc() {
  return {
    hard: null, needs: [],
    deny(msg) { if (!this.hard) this.hard = msg; },
    // n: { kind:'target'|'yes'|'push', label, targets:[цель], writes:[путь для копии], tail }
    need(n) { this.needs.push(n); },
  };
}
const pathTarget = (abs) => ({ kind: 'path', abs: path.resolve(abs) });

// ---------- файлы подтверждения ----------
const CONSENT_MSG = 'Файлы подтверждения (.workplace/human-messages.json, consent-plan.json) и хук human-message.js пишут только хук и wp.js: «да» ставит человек своим сообщением.' + HUMAN_ONLY;
function touchesConsent(it) {
  for (const r of it.redirs || []) if (/^&?>/.test(r.op) && (consent.isProtectedPath(String(r.target).replace(/\\/g, '/')) || consent.PROTECTED_WORD_RX.test(r.target))) return true;
  if (!it.cmd) return false;
  if (READ_ONLY.has(it.cmd)) return false;
  if (consent.PROTECTED_WORD_RX.test(it.raw || '')) return true;
  if (it.rest.some((w) => consent.PROTECTED_WORD_RX.test(w.t))) return true;
  return (it.here || []).some((h) => consent.PROTECTED_WORD_RX.test(String(h.body || '')));
}

// ---------- удаление ----------
function deleteTargets(it) {
  const ps = PS_DELETE.has(it.cmd);
  let recursive = false;
  const targets = [];
  let after = false;
  const rest = it.rest;
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i];
    const t = w.t;
    if (after) { targets.push(t); continue; }
    if (!w.q && t === '--') { after = true; continue; }
    if (!w.q && t === '--recursive') { recursive = true; continue; }
    if (!w.q && /^\/s$/i.test(t)) { recursive = true; continue; }
    if (!w.q && /^\/[a-z](:\S+)?$/i.test(t)) continue;                       // флаги cmd.exe: /q /f /a
    if (!w.q && /^-/.test(t)) {
      if (/^-[rRfFiIvVdDPx]+$/.test(t)) { if (/[rR]/.test(t)) recursive = true; continue; }   // кластер флагов rm: -rf
      const name = t.replace(/^-+/, '').toLowerCase().replace(/:.*$/, '');
      if (/^r(e(c(u(r(s(e)?)?)?)?)?)?$/.test(name)) { recursive = true; continue; }
      if (name === 'path' || name === 'literalpath') { if (rest[i + 1]) { targets.push(...(ps ? rest[i + 1].t.split(',') : [rest[i + 1].t])); i++; } continue; }
      if (PS_VALUED.has(name)) { if (!/:/.test(t)) i++; continue; }
      continue;
    }
    if (ps) targets.push(...t.split(',')); else targets.push(t);
  }
  return { recursive, targets };
}

function findTargets(it) {
  const paths = [];
  for (const w of it.rest) { if (!w.q && /^[-(!]/.test(w.t)) break; paths.push(w.t); }
  const del = sh.hasFlag(it.rest, '-delete') || it.rest.some((w, i) => !w.q && /^-(exec|execdir|ok)$/.test(w.t) && it.rest[i + 1] && /^(rm|rmdir|del|shred)$/.test(sh.key(it.rest[i + 1].t)));
  return { del, paths: paths.length ? paths : ['.'] };
}

// Удаление целей. o.recursive: рекурсивное (цель проверить обязательно); o.rootItself: сам корень допустим (find). Нет корня рабочего места: одиночные файлы не судим (как раньше).
function checkDelete(it, targets, zones, acc, env, o) {
  const what = o.recursive ? 'рекурсивное удаление' : 'удаление';
  for (const t of targets) {
    const e = sh.expandTarget(t, it.cwd);
    if (e.unknown) {
      if (o.recursive) acc.deny(stop(what, 'Куда указывает путь «' + t + '», проверить нельзя (переменная, подстановка или неизвестная папка). Подставь настоящий полный путь в команду.'));
      continue;
    }
    if (consent.isProtectedPath(e.p)) { acc.deny(stop(what, CONSENT_MSG)); continue; }
    const cls = classify(e.p, zones);
    if (cls === 'inside') continue;
    if (cls === 'root') { if (o.rootItself) continue; acc.deny(stop(what, 'Путь «' + t + '» это весь корень рабочего места: в нём правила, память и сторожа. Если человек просит убрать всю установку, покажи ему полный путь и что пропадёт, а саму папку пусть удалит он сам (проводник или Finder), ты дай понятные шаги.')); continue; }
    if (cls === 'service') { acc.deny(stop(what, 'Это служебная папка рабочего места: без неё сторожа и навыки перестанут работать.')); continue; }
    if (cls === 'floor') { acc.deny(stop(what, 'Путь «' + t + '» это корень диска или домашняя папка целиком. Удалённое не вернуть.' + HUMAN_ONLY)); continue; }
    if (cls === 'system') { acc.deny(stop(what, 'Путь «' + t + '» в системной папке: здесь нужны права администратора.' + HUMAN_ONLY)); continue; }
    if (!o.recursive && !env.hasRoot && !isProtectedHome(e.p)) continue;
    acc.need({ kind: 'target', label: what + ' «' + t + '» (' + u.tilde(e.p) + ')', targets: [pathTarget(e.p)] });
  }
}

// ---------- запись вне главной папки ----------
function psParam(rest, names) {
  for (let i = 0; i < rest.length; i++) {
    const m = /^-([A-Za-z]+)(?::(.+))?$/.exec(rest[i].t);
    if (m && names.includes(m[1].toLowerCase())) return m[2] !== undefined ? m[2] : (rest[i + 1] ? rest[i + 1].t : null);
  }
  return null;
}
function positionalArgs(rest, valued) {
  const out = [];
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i];
    if (w.op) continue;
    if (!w.q && /^-/.test(w.t)) { if (valued && valued.has(w.t) && rest[i + 1]) i++; continue; }
    out.push(w.t);
  }
  return out;
}
// Параметры установщиков со значением (путь, кэш, адрес): значение не название программы.
const INSTALL_VALUED = new Set(['--prefix', '--cache', '--registry', '--userconfig', '--location', '--tag', '--dir', '--cwd', '--target', '--index-url', '--source']);
// Файлы, которые команда создаёт или меняет (то, что известно по виду команды). Редакторы и чтение не считаются.
function writeTargets(it) {
  const cmd = it.cmd, rest = it.rest;
  const pos = positionalArgs(rest);
  if (cmd === 'tee') return pos;
  if (cmd === 'cp' || cmd === 'install' || cmd === 'ln') {
    const ti = rest.findIndex((w) => !w.q && /^(-t|--target-directory)$/.test(w.t));
    if (ti >= 0 && rest[ti + 1]) return [rest[ti + 1].t];
    const eq = rest.find((w) => !w.q && /^--target-directory=/.test(w.t));
    if (eq) return [eq.t.slice(eq.t.indexOf('=') + 1)];
    if (cmd === 'install' && sh.hasFlag(rest, '-d')) return [];
    return pos.length >= 2 ? [pos[pos.length - 1]] : [];
  }
  if (cmd === 'mv') return pos;
  if (cmd === 'touch') return pos;
  if (cmd === 'truncate') return pos.length ? [pos[pos.length - 1]] : [];
  if (cmd === 'sed' && (sh.hasFlag(rest, /^-[a-zA-Z]*i/) || sh.hasFlag(rest, '--in-place'))) return sh.hasFlag(rest, '-e', '-f', '--expression', '--file') ? pos : pos.slice(1);
  if (cmd === 'perl' && sh.hasFlag(rest, /^-[a-zA-Z]*i/)) {
    const skip = new Set();
    rest.forEach((w, i) => { if (!w.q && /^-[eE]$/.test(w.t) && rest[i + 1]) skip.add(rest[i + 1].t); });
    const files = pos.filter((x) => !skip.has(x));
    return sh.hasFlag(rest, /^-[a-zA-Z]*[eE]/) && !skip.size ? files.slice(1) : files;
  }
  if (cmd === 'dd') { const of = rest.find((w) => /^of=/.test(w.t)); return of ? [of.t.slice(3)] : []; }
  if (/^(add-content|ac|set-content|sc|out-file|clear-content)$/.test(cmd)) { const p = psParam(rest, ['path', 'literalpath', 'filepath']); return p ? p.split(',') : (pos[0] ? [pos[0]] : []); }
  if (/^(new-item|ni)$/.test(cmd)) { if (/directory|dir/i.test(psParam(rest, ['itemtype', 'type']) || '')) return []; const p = psParam(rest, ['path', 'literalpath']); return p ? [p] : (pos[0] ? [pos[0]] : []); }
  if (/^(copy-item|copy)$/.test(cmd)) { const d = psParam(rest, ['destination']); return d ? [d] : (pos.length >= 2 ? [pos[1]] : []); }
  if (/^(move-item|move|mi|rename-item|ren)$/.test(cmd)) { const d = psParam(rest, ['destination', 'newname']); return d ? [d].concat(pos.slice(0, 1)) : pos; }
  return [];
}

// Как человек называет файл настроек программы, не называя путь: «поменяй в VS Code шрифт» называет и файл settings.json в папке Code/User.
// Без этого «да» на такую просьбу не засчитывалось бы за цель, и ИИ просил бы второе «да» уже на зарегистрированный план.
function appAliases(abs) {
  const n = String(abs).replace(/\\/g, '/');
  const out = [];
  if (/\/(Code|Code - Insiders|VSCodium)\/User\//i.test(n)) out.push('vs code', 'vscode', 'visual studio code', 'вс код', 'вскод', 'вс-код');
  if (/\/Cursor\/User\//i.test(n)) out.push('cursor', 'курсор');
  if (/\/Windsurf\/User\//i.test(n)) out.push('windsurf');
  if (/\/\.gitconfig$/i.test(n)) out.push('gitconfig', 'git config', 'настройки git', 'настройки гит');
  if (/\/\.ssh(\/|$)/i.test(n)) out.push('ssh');
  return out;
}

// Запись по цели: профили, настройки, чужие проекты. kind: 'tool' | 'shell'.
// Сами сторожа и их подключение: ИИ не отключает их молча (метка от ИИ ничего не значит, а это был бы тот же обход). Правка идёт по «да» и названию файла, с копией.
const GUARD_FILES = /^(\.workplace\/(core\/(hooks|lib)\/|config\.json$)|\.claude\/settings\.json$|\.codex\/hooks\.json$)/;
function checkWriteTarget(raw, abs, zones, acc, env, via) {
  if (consent.isProtectedPath(abs)) { acc.deny(stop('запись в «' + raw + '»', CONSENT_MSG)); return; }
  const cls = classify(abs, zones);
  if ((cls === 'inside' || cls === 'service') && zones.root && env.hasRoot && GUARD_FILES.test(relToRoot(zones.root, abs))) {
    const relGuard = relToRoot(zones.root, abs);
    acc.need({ kind: 'target', label: 'изменение сторожей или их подключения («' + raw + '»)', targets: [Object.assign(pathTarget(abs), { alts: [relGuard, './' + relGuard] })], writes: [path.resolve(abs)], tail: WRITE_TAIL });
    return;
  }
  if (cls === 'inside' || cls === 'root' || cls === 'service' || aiInternal(abs)) return;
  if (cls === 'system') { acc.deny(stop('запись в «' + raw + '»', 'Это системная папка: здесь нужны права администратора.' + HUMAN_ONLY)); return; }
  const prot = isProtectedHome(abs);
  if (!prot && !env.hasRoot) return;                   // нет рабочего места: судить не по чему (как раньше); профили защищены везде
  let what = 'запись в «' + raw + '»';
  let tail = WRITE_TAIL;
  if (prot) what += ' (профиль оболочки, ключи ssh или личные настройки человека: запись меняет работу всех его программ; строку PATH в профиль пишет `wp.js path-fix --yes`)';
  else if (personalDir(abs)) { what += ' (личная папка навыков, агентов или команд человека)'; tail = ' Навыки этой установки лежат в главной папке (ГЛАВНАЯ/.claude/skills и ГЛАВНАЯ/.agents/skills), туда писать можно без «да».' + WRITE_TAIL; }
  else what += ' (вне главной папки: чужие проекты и настройки человека без его слова не меняются)';
  acc.need({ kind: 'target', label: what, targets: [Object.assign(pathTarget(abs), { alts: appAliases(abs) })], writes: [path.resolve(abs)], tail });
}

// ---------- установка и обновление ----------
const PKG_MANAGERS = /^(npm|pnpm|yarn|bun)$/;
function pkgName(spec) {
  const s = String(spec).replace(/^["']|["']$/g, '');
  return s.replace(/^(@[^/]+\/[^@]+)@.*$/, '$1').replace(/^([^@/][^@]*)@.*$/, '$1');
}
// Установка, обновление или удаление программы: { names:[...] } (names пуст: «всё сразу») или null.
function installInfo(it) {
  const cmd = it.cmd;
  const posAll = positionalArgs(it.rest, INSTALL_VALUED);
  const pos = posAll.map((x) => x.toLowerCase());
  const names = (from) => posAll.slice(from).filter((x) => !/^(--?|[a-z]+:\/\/)/i.test(x)).map(pkgName);
  const VERB_IN = /^(install|i|add|update|upgrade|up|uninstall|remove|rm|reinstall|-S|-Syu)$/;
  if (PKG_MANAGERS.test(cmd)) {
    const g = sh.hasFlag(it.rest, '-g', '--global') || (cmd === 'yarn' && pos[0] === 'global');
    if (!g) return null;
    const i0 = cmd === 'yarn' && pos[0] === 'global' ? 1 : 0;
    return VERB_IN.test(pos[i0] || '') ? { names: names(i0 + 1) } : null;
  }
  if (/^(pip|pip3)$/.test(cmd) || (INTERP.has(cmd) && /^python/.test(cmd) && it.rest[0] && it.rest[0].t === '-m' && it.rest[1] && /^pip3?$/.test(it.rest[1].t))) {
    const off = /^(pip|pip3)$/.test(cmd) ? 0 : 1;
    if (!/^(install|uninstall)$/.test(pos[off] || '')) return null;
    if (!sh.hasFlag(it.rest, '--user', '--break-system-packages')) return null;
    return { names: names(off + 1) };
  }
  if (cmd === 'pipx') return /^(install|upgrade|upgrade-all|uninstall|reinstall|reinstall-all)$/.test(pos[0] || '') ? { names: names(1) } : null;
  if (cmd === 'uv' && pos[0] === 'tool') return /^(install|upgrade|uninstall)$/.test(pos[1] || '') ? { names: names(2) } : null;
  if (cmd === 'brew') return /^(install|upgrade|reinstall|uninstall|remove|rm)$/.test(pos[0] || '') ? { names: names(1) } : null;
  if (cmd === 'winget') {
    if (!/^(install|upgrade|uninstall|update)$/.test(pos[0] || '')) return null;
    const n = names(1);
    if (!n.length && !sh.hasFlag(it.rest, '--all', '-r', '--id')) return null;     // голый winget upgrade только показывает список
    const id = it.rest.findIndex((w) => !w.q && /^(--id|-e|--exact|-q|--query)$/.test(w.t));
    return { names: n.length ? n : (id >= 0 && it.rest[id + 1] ? [it.rest[id + 1].t] : []) };
  }
  if (cmd === 'choco' || cmd === 'scoop') return /^(install|upgrade|update|uninstall)$/.test(pos[0] || '') ? { names: names(1) } : null;
  if (/^(apt|apt-get|dnf|yum|zypper|pacman|apk)$/.test(cmd)) return /^(install|upgrade|dist-upgrade|remove|add|-S|-Syu)$/.test(pos[0] || '') || sh.hasFlag(it.rest, '-S', '-Syu') ? { names: names(1) } : null;
  if (cmd === 'claude' || cmd === 'codex') return /^(update|upgrade|install|migrate-installer)$/.test(pos[0] || '') && !sh.hasFlag(it.rest, '--help', '-h') ? { names: [cmd] } : null;   // `claude update --help` только справка
  if (cmd === 'code') {
    const i = it.rest.findIndex((w) => !w.q && /^--(install|uninstall)-extension(=.*)?$/.test(w.t));
    if (i < 0) return null;
    const m = /=(.+)$/.exec(it.rest[i].t);
    return { names: [m ? m[1] : (it.rest[i + 1] ? it.rest[i + 1].t : 'extension')] };
  }
  return null;
}

// ---------- скачать и выполнить ----------
function isStdinExecutor(it) {
  if (SH_EXEC.has(it.cmd)) {
    if (sh.hasFlag(it.rest, /^-[a-zA-Z]*c[a-zA-Z]*$/)) return false;
    return !it.rest.length || sh.hasFlag(it.rest, '-s') || it.rest.every((w) => sh.isFlag(w)) || it.rest.some((w) => w.t === '-');
  }
  if (INTERP.has(it.cmd)) return !it.rest.length || (it.rest.length === 1 && it.rest[0].t === '-');
  if (IEX.has(it.cmd)) return true;
  if (it.cmd === 'source' || it.cmd === '.') return !!it.trailingLt;
  if (SH_EXEC.has(it.cmd) && it.trailingLt) return true;
  return false;
}
// Имена файлов, в которые скачивающая команда сохраняет результат.
function outputNames(it) {
  const names = [];
  const r = it.rest;
  for (let i = 0; i < r.length; i++) {
    if (/^(-o|--output|-outfile|--output-document|-O)$/i.test(r[i].t) && r[i + 1] && r[i + 1].t !== '-' && !/^-/.test(r[i + 1].t)) names.push(lex.baseName(r[i + 1].t.split('?')[0]));
    if (r[i].t === '--remote-name') { const x = r.find((w) => /^https?:/i.test(w.t)); if (x) names.push(lex.baseName(x.t.split('?')[0])); }
  }
  for (const rd of it.redirs || []) if (/^&?>/.test(rd.op)) names.push(lex.baseName(rd.target));
  return names.filter(Boolean);
}
// Скачивание и немедленное выполнение сценария. true, если в команде оно есть.
function downloadExec(items, src) {
  const stmts = new Map();
  for (const it of items) { if (!stmts.has(it.stmt)) stmts.set(it.stmt, []); stmts.get(it.stmt).push(it); }
  for (const group of stmts.values()) if (group.some((it) => DOWNLOADERS.has(it.cmd)) && group.some((it) => isStdinExecutor(it))) return true;
  const holder = items.find((it) => (it.cmd === 'eval' || SH_EXEC.has(it.cmd) || PS_RUN.has(it.cmd) || IEX.has(it.cmd) || it.cmd === 'source' || it.cmd === '.') &&
    it.rest.some((w) => /\$\(|`/.test(w.t) && /(^|[\s(`])(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)(\s|$)/i.test(w.t)));
  if (holder) return true;
  const saved = new Set();
  for (const it of items) {
    if (DOWNLOADERS.has(it.cmd)) { outputNames(it).forEach((n) => saved.add(n)); continue; }
    if (!saved.size) continue;
    const runner = SH_EXEC.has(it.cmd) || PS_RUN.has(it.cmd) || INTERP.has(it.cmd) || it.cmd === 'source' || it.cmd === '.';
    const cands = [lex.baseName(it.raw)];
    if (runner) it.rest.forEach((w) => cands.push(lex.baseName(w.t)));
    if (cands.some((c) => saved.has(c))) return true;
  }
  return false;
}
function checkDownloadExec(items, src, acc) {
  if (!downloadExec(items, src)) return;
  const urls = sh.urlsIn(src);
  if (!urls.length) { acc.deny(stop('скачивание и немедленное выполнение сценария из сети', 'Адрес не виден в команде, проверить нечего. Напиши полный адрес в команде.')); return; }
  const official = urls.filter((x) => OFFICIAL_INSTALLERS.has(x));
  const other = urls.filter((x) => !OFFICIAL_INSTALLERS.has(x));
  for (const x of official) acc.need({ kind: 'target', label: 'установка по официальному установщику ' + OFFICIAL_NAME[x] + ' (' + x + ')', targets: [{ kind: 'name', names: [OFFICIAL_NAME[x]] }] });
  for (const x of other) {
    let host = '';
    try { host = new URL(x).hostname; } catch (_) { host = x; }
    acc.need({ kind: 'target', label: 'скачивание и немедленное выполнение сценария из сети (' + host + '): сценарий не виден до запуска, он может сделать что угодно', targets: [{ kind: 'host', host }] });
  }
}

// Сам установщик: `node <...>/core/cli/wp.js <команда> ...`. Слово `.zshrc` в тексте его аргумента (запись в журнал `state log "PATH дописан в ~/.zshrc"`) не код, пишущий профиль;
// профиль эта программа правит только командой path-fix, по «да» человека и с копией. Скриптом считается первое слово без дефиса: у `node -e "код"` это сам код, а не wp.js.
const WP_CLI = /(^|\/)core\/cli\/wp\.js$/i;
function isWpCli(it) {
  const script = it.rest.find((w) => w.q || !/^-/.test(w.t));
  return !!script && WP_CLI.test(script.t.replace(/\\/g, '/'));
}

// ---------- проверка одной простой команды ----------
function checkItem(it, zones, acc, env) {
  const cmd = it.cmd;
  if (touchesConsent(it)) { acc.deny(stop('запись в файлы подтверждения', CONSENT_MSG)); return; }
  for (const r of it.redirs || []) {
    if (!/^&?>>?\|?$/.test(r.op)) continue;
    if (/^\/dev\/(sd|hd|nvme|disk|mmcblk|rdisk)/.test(r.target)) { acc.deny(stop('запись на устройство «' + r.target + '»', 'Это затирает диск.' + HUMAN_ONLY)); continue; }
    if (NULLISH.test(r.target)) continue;
    const e = sh.expandTarget(r.target, it.cwd);
    if (e.unknown || !e.p) continue;
    checkWriteTarget(r.target, e.p, zones, acc, env, 'shell');
  }
  if (!cmd) return;

  // повышение прав: пароль администратора вводит человек
  const elevator = sh.ELEVATORS.has(cmd) ? cmd : it.wrappers.find((w) => sh.ELEVATORS.has(w));
  if (elevator) { acc.deny(stop('команда с повышением прав (' + elevator + ')', 'Пароль администратора и такие шаги выполняет сам человек: дай ему команду и объясни её.')); return; }
  if ((cmd === 'start-process' || cmd === 'saps') && it.rest.some((w) => /^runas$/i.test(w.t))) { acc.deny(stop('запуск с правами администратора (RunAs)', 'Такие шаги выполняет сам человек.')); return; }

  // удаление
  if (RM_CMDS.has(cmd)) {
    const info = deleteTargets(it);
    if (info.recursive && !info.targets.length) { if (it.wrappers.includes('xargs')) acc.deny(stop('рекурсивное удаление по списку из xargs', 'Что именно будет удалено, проверить нельзя. Назови пути в команде.')); }
    else checkDelete(it, info.targets, zones, acc, env, { recursive: info.recursive });
  }
  if (cmd === 'find') {
    const f = findTargets(it);
    if (f.del) checkDelete(it, f.paths, zones, acc, env, { recursive: true, rootItself: true });
  }
  if (cmd === 'shred' || cmd === 'srm') checkDelete(it, sh.positional(it.rest).map((w) => w.t), zones, acc, env, { recursive: true });

  // git и публикации
  if (cmd === 'git') {
    const g = sh.gitSub(it.rest);
    const a = g.args;
    if (g.sub === 'push') {
      if (sh.hasFlag(a, '--dry-run', '-n')) return;
      const forced = sh.hasFlag(a, '--force', '--force-with-lease', '--force-if-includes', '--mirror', '--delete') || sh.hasFlag(a, /^-[a-zA-Z]*[fd][a-zA-Z]*$/) || a.some((w) => /^[+:]/.test(w.t));
      if (forced) acc.need({ kind: 'yes', label: 'отправка в удалённый репозиторий с перезаписью или удалением (push --force и подобное): чужую историю на удалённой стороне не вернуть' });
      else acc.need({ kind: 'push', label: 'отправка изменений в удалённый репозиторий (push): данные уходят наружу' });
      return;
    }
    if (g.sub === 'reset' && sh.hasFlag(a, '--hard')) acc.need({ kind: 'yes', label: 'git reset --hard: несохранённые правки пропадут без возврата' });
    if (g.sub === 'clean' && !sh.hasFlag(a, '-n', '--dry-run') && (sh.hasFlag(a, '--force') || sh.hasFlag(a, /^-[a-zA-Z]*f[a-zA-Z]*$/))) acc.need({ kind: 'yes', label: 'git clean -f: неотслеживаемые файлы удаляются без возврата' });
    if ((g.sub === 'checkout' || g.sub === 'restore') && a.some((w) => w.t === '.' || w.t === ':/' || w.t === '*') && !(g.sub === 'restore' && sh.hasFlag(a, '--staged') && !sh.hasFlag(a, '--worktree', '-W'))) acc.need({ kind: 'yes', label: 'git ' + g.sub + ' для всей папки: все несохранённые правки пропадут без возврата' });
    if (g.sub === 'filter-branch' || g.sub === 'filter-repo' || (g.sub === 'reflog' && a.some((w) => w.t === 'expire'))) acc.need({ kind: 'yes', label: 'git ' + g.sub + ': переписывает историю репозитория' });
    if (g.sub === 'config' && sh.hasFlag(a, /^--(global|system)$/) && !sh.hasFlag(a, '--get', '--get-all', '--get-regexp', '--list', '-l', '--show-origin', '--show-scope')) acc.need({ kind: 'yes', label: 'запись в общую настройку git: она меняет все проекты человека' });
  }
  if (/^(npm|pnpm|yarn|bun)$/.test(cmd)) {
    const pos = sh.positional(it.rest).map((w) => w.t.toLowerCase()).slice(0, 2);
    if ((pos.includes('publish') || pos.includes('unpublish')) && !sh.hasFlag(it.rest, '--dry-run')) acc.need({ kind: 'yes', label: cmd + ' ' + (pos.includes('unpublish') ? 'unpublish' : 'publish') + ': публикация уходит наружу, отозвать её сложно' });
  }

  // установка и обновление программ
  const inst = installInfo(it);
  if (inst) {
    const verb = /^(uninstall|remove|rm)$/.test(positionalArgs(it.rest)[0] || '') ? 'удаление программы' : 'установка или обновление программы';
    acc.need({ kind: 'target', label: verb + ' (' + cmd + (inst.names.length ? ': ' + inst.names.join(', ') : ': всё сразу') + ')', targets: inst.names.length ? [{ kind: 'name', names: inst.names }] : [{ kind: 'plan' }] });
  }

  // права и диски
  if (/^(chmod|chown|chgrp)$/.test(cmd) && (sh.hasFlag(it.rest, '--recursive') || sh.hasFlag(it.rest, /^-[a-zA-Z]*R[a-zA-Z]*$/))) {
    const tg = sh.positional(it.rest).slice(1).map((w) => w.t);   // первое слово без флага - режим или владелец
    recursiveOutside(it, tg, zones, acc, env, cmd + ' -R: массовая смена прав ломает чужие файлы');
  }
  if ((cmd === 'icacls' && it.rest.some((w) => /^\/t$/i.test(w.t))) || (cmd === 'takeown' && it.rest.some((w) => /^\/r$/i.test(w.t)))) {
    const t = it.rest.find((w) => !/^\/[a-z]/i.test(w.t) && !w.op);
    if (t) recursiveOutside(it, [t.t], zones, acc, env, cmd + ' для всего дерева: массовая смена прав ломает чужие файлы');
  }
  if (/^mkfs(\..+)?$/.test(cmd) || /^(fdisk|sfdisk|gdisk|parted|wipefs|diskpart|format-volume|clear-disk|initialize-disk)$/.test(cmd)) { acc.deny(stop('работа с разделами и файловыми системами (' + cmd + ')', 'Это стирает диск.' + HUMAN_ONLY)); return; }
  if (cmd === 'diskutil' && it.rest.some((w) => /^(erase.*|partitiondisk|repartitiondisk|reformat|zerodisk|secureerase)$/i.test(w.t))) { acc.deny(stop('diskutil erase', 'Это стирает диск.' + HUMAN_ONLY)); return; }
  if ((cmd === 'format' || cmd === 'format.com') && it.rest.some((w) => /^[A-Za-z]:\\?$/.test(w.t))) { acc.deny(stop('format диска', 'Это стирает диск.' + HUMAN_ONLY)); return; }
  if (cmd === 'dd') {
    const of = it.rest.find((w) => /^of=/.test(w.t));
    if (of && (/^\/dev\//.test(of.t.slice(3)) || /^\\\\\.\\/.test(of.t.slice(3)))) { acc.deny(stop('dd с записью в «' + of.t.slice(3) + '»', 'Запись на устройство стирает данные.' + HUMAN_ONLY)); return; }
  }
  if (/^(shutdown|reboot|halt|poweroff|restart-computer|stop-computer)$/.test(cmd)) acc.need({ kind: 'yes', label: cmd + ': это выключает или перезагружает компьютер человека' });

  // завершение процессов по имени
  const KILL = 'завершение по имени заденет чужие окна и сессии (лучше завершать свой процесс по его номеру, PID)';
  if (cmd === 'pkill' || cmd === 'killall') acc.need({ kind: 'yes', label: cmd + ': ' + KILL });
  if (cmd === 'taskkill' && it.rest.some((w) => /^\/im$/i.test(w.t))) acc.need({ kind: 'yes', label: 'taskkill /IM: ' + KILL });
  if (cmd === 'stop-process' || cmd === 'spps') {
    const hasId = it.rest.some((w) => /^-id$/i.test(w.t) || /^\d+$/.test(w.t));
    if (sh.hasFlag(it.rest, /^-name$/i) || !hasId) acc.need({ kind: 'yes', label: 'Stop-Process по имени или из конвейера: ' + KILL });
  }
  if (cmd === 'kill' && it.rest.some((w) => w.t === '-1' || w.t === '0')) acc.need({ kind: 'yes', label: 'kill для всех процессов: это завершит все процессы пользователя' });

  // переменные пользователя
  if (cmd === 'setx') acc.need({ kind: 'yes', label: 'setx: команда навсегда меняет переменные окружения пользователя' });
  if (it.rest.some((w) => /SetEnvironmentVariable\s*\(.*['"](User|Machine)['"]/i.test(w.t))) acc.need({ kind: 'yes', label: 'запись переменной окружения пользователя: это навсегда меняет среду человека' });

  // запись вне главной папки и профили, ~/.ssh, личные настройки
  const wt = new Set(writeTargets(it));
  for (const raw of wt) {
    if (NULLISH.test(raw)) continue;
    const e = sh.expandTarget(raw, it.cwd);
    if (e.unknown || !e.p) continue;
    checkWriteTarget(raw, e.p, zones, acc, env, 'shell');
  }
  if (WRITERS.has(cmd)) {
    for (const w of it.rest) {
      if (w.op || /^-/.test(w.t) || wt.has(w.t)) continue;
      const p = targetPath(/^of=/.test(w.t) ? w.t.slice(3) : w.t, it.cwd);
      if (p && isProtectedHome(p) && !(cmd === 'cp' || cmd === 'mv' || cmd === 'ln' || cmd === 'install' || cmd === 'copy' || cmd === 'copy-item')) checkWriteTarget(w.t, p, zones, acc, env, 'shell');
    }
  }
  if (INTERP.has(cmd) && !isWpCli(it)) {
    const m = [];
    for (const w of it.rest) { const re = /(^|[\s'"\/\\])(\.(?:zshrc|zprofile|zshenv|bashrc|bash_profile|bash_login|profile))(?![\w.])/g; let x; while ((x = re.exec(w.t))) m.push(x[2]); }
    for (const name of new Set(m)) checkWriteTarget('~/' + name + ' (в коде)', path.join(path.resolve(sh.home()), name), zones, acc, env, 'shell');
  }
}

// Рекурсивные права вне корня: цели проверяются как удаление (сам корень допустим).
function recursiveOutside(it, targets, zones, acc, env, label) {
  for (const t of targets) {
    const e = sh.expandTarget(t, it.cwd);
    if (e.unknown) { acc.deny(stop(label, 'Куда указывает путь «' + t + '», проверить нельзя. Подставь настоящий полный путь в команду.')); continue; }
    const cls = classify(e.p, zones);
    if (cls === 'inside' || cls === 'root') continue;
    if (cls === 'system' || cls === 'floor') { acc.deny(stop(label, 'Путь «' + t + '» в системной или домашней папке целиком.' + HUMAN_ONLY)); continue; }
    acc.need({ kind: 'target', label: label + ' («' + t + '»)', targets: [pathTarget(e.p)] });
  }
}

// ---------- решение ----------
function decide(acc, ctx, data) {
  if (acc.hard) return hookIo.deny(acc.hard);
  if (!acc.needs.length) return null;
  const root = ctx.root;
  const session = data.session_id || data.sessionId || null;
  // push: без стены; по прямой просьбе человека. Записей нет совсем (хук не подключён): не мешаем, как и раньше.
  for (const n of acc.needs.filter((x) => x.kind === 'push')) {
    const r = root ? consent.requested(root, session) : { known: false };
    if (r.known && !r.ok) return hookIo.deny(stop(n.label, 'git push делается по прямой просьбе человека (отправь, залей, push) или после его «да». Спроси его простыми словами, в какой репозиторий и что уйдёт, и повтори после ответа. Перед отправкой предложи кросс-проверку (/cross-check).'));
  }
  const rest = acc.needs.filter((x) => x.kind !== 'push');
  if (!rest.length) return null;
  const targets = [];
  for (const n of rest) for (const t of n.targets || []) if (!targets.some((x) => JSON.stringify(x) === JSON.stringify(t))) targets.push(t);
  const res = consent.evaluate(root, session, { kind: targets.length ? 'target' : 'yes', targets });
  const labels = [...new Set(rest.map((n) => n.label))].join('; ');
  const tail = rest.some((n) => n.tail) ? rest.find((n) => n.tail).tail : '';
  if (!res.ok) {
    const why = res.why === 'no-record' ? NO_RECORD : res.why === 'no-yes' ? NO_YES : notNamed(res.missing);
    return hookIo.deny(stop(labels, why + (res.why === 'no-record' ? '' : tail)));
  }
  // подтверждено: перед правкой существующего файла кладём его копию
  for (const n of rest) for (const f of n.writes || []) {
    if (!root) continue;
    const b = backup.backupFile(root, f);
    if (b.error) return hookIo.deny(stop(labels, 'Копию файла «' + f + '» сделать не удалось (' + b.error + '): без копии правка не делается. Скажи человеку причину и предложи другое место для копии, потом повтори.'));
  }
  return null;
}

// Запись инструментами (Write, Edit, MultiEdit, NotebookEdit, apply_patch).
function checkWriteTool(w, data, ctx) {
  const acc = newAcc();
  const cwd = common.shellCwd(data);
  const zones = sh.safeZones(ctx.root || null);
  const env = { hasRoot: !!ctx.root };
  for (const raw of w.paths) {
    if (!raw) continue;
    const e = sh.expandTarget(raw, cwd);
    if (e.unknown || !e.p) continue;
    checkWriteTarget(raw, e.p, zones, acc, env, 'tool');
  }
  return decide(acc, ctx, data);
}

hookIo.run((data, ctx) => {
  if (!cfgLib.guardEnabled(ctx.config, 'danger_guard')) return null;
  const wi = common.writeInfo(data);
  if (wi) return checkWriteTool(wi, data, ctx);
  const cmd = common.shellCommand(data);
  if (!cmd || !cmd.trim()) return null;
  const cwd = common.shellCwd(data);
  const zones = sh.safeZones(ctx.root || data.cwd || cwd);
  const env = { hasRoot: !!ctx.root };
  const psOnly = /^powershell$/i.test(String(data.tool_name || ''));
  const acc = newAcc();
  if (/:\(\)\s*\{\s*:\s*\|\s*:/.test(cmd)) acc.deny(stop('форк-бомба', 'Она подвешивает компьютер.'));
  for (const { items } of sh.flattenAll(cmd, { cwd, psOnly })) {
    for (const it of items) checkItem(it, zones, acc, env);
    checkDownloadExec(items, cmd, acc);
  }
  // одинаковые требования из двух разборов (sh и ps) не удваиваются
  const seen = new Set();
  acc.needs = acc.needs.filter((n) => { const k = n.kind + '|' + n.label; if (seen.has(k)) return false; seen.add(k); return true; });
  return decide(acc, ctx, data);
}, __dirname);
