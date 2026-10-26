#!/usr/bin/env node
'use strict';
// Правки этапа М (приёмка): переменная пути в PowerShell, настройки программы названы по имени («VS Code»), команда backup,
// подтверждение для install и path-fix (флаг --yes сам «да» не доказывает), честная формулировка про основной Codex.
// Работа идёт настоящими wp.js и хуками в фейковом HOME; живые модели не запускаются.
//   node tests/unit/m-flow/run.js
const fs = require('fs');
const path = require('path');
const H = require('../../lib/harness');
const stubsLib = require('../../lib/stubs');

const S = new H.Suite('m-flow');
const ok = (n, c, d) => S.ok(n, c, d);
const TMP = H.mkTmp('wp-mflow-');
const HOME = path.join(TMP, 'home');
const ROOT = path.join(HOME, 'workplace');
const BIN = stubsLib.prepare(path.join(TMP, 'bin-full'), ['python', 'python3', 'codex', 'claude']);
const ZONE = path.join(TMP, 'zone');
fs.mkdirSync(ZONE, { recursive: true });
const env = (extra) => H.sandboxEnv(HOME, { path: H.minPath([BIN]), extra: Object.assign({ WP_TMP_ZONES: ZONE }, extra || {}) });
const WP_ROOT = path.join(ROOT, '.workplace', 'core', 'cli', 'wp.js');
const wp = (args, o) => H.node(WP_ROOT, args, Object.assign({ cwd: ROOT, env: env() }, o || {}));
const hookPath = (n) => path.join(ROOT, '.workplace', 'core', 'hooks', n + '.js');
function hook(name, input) {
  const r = H.node(hookPath(name), [], { cwd: ROOT, env: env({ CLAUDE_PROJECT_DIR: ROOT }), input: JSON.stringify(input) });
  return { code: r.code, out: r.out.trim(), deny: /"permissionDecision":"deny"/.test(r.out), reason: (() => { try { return JSON.parse(r.out).hookSpecificOutput.permissionDecisionReason || ''; } catch (_) { return ''; } })() };
}
const human = (text) => hook('human-message', { hook_event_name: 'UserPromptSubmit', prompt: text, cwd: ROOT });
const shell = (command, tool) => hook('danger-guard', { hook_event_name: 'PreToolUse', tool_name: tool || 'PowerShell', tool_input: { command }, cwd: ROOT });
const write = (file_path) => hook('danger-guard', { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path, content: 'x' }, cwd: ROOT });
const fwd = (p) => p.replace(/\\/g, '/');

try {
  S.section('подготовка: init, раскладка, сторожа');
  H.write(path.join(HOME, 'old-tmp', 'cache', 'a.txt'), 'старое\n');
  const code = path.join(HOME, 'AppData', 'Roaming', 'Code', 'User');
  H.write(path.join(code, 'settings.json'), '{\n  "editor.fontSize": 13\n}\n');
  let r = H.node(H.WP_SRC, ['init', '--root', ROOT, '--main', 'claude', '--no-scan'], { cwd: TMP, env: env() });
  ok('init: код 0', r.code === 0, r.all);
  r = wp(['layout']); ok('layout: код 0', r.code === 0, r.all);
  r = wp(['hooks', 'wire']); ok('hooks wire: код 0', r.code === 0, r.all);

  S.section('PowerShell: переменная с путём, присвоенная в той же команде (тупик «Удали папку» у Codex)');
  const target = fwd(path.join(HOME, 'old-tmp'));
  const psDel = "$deletionTarget = '" + target + "'\nRemove-Item -LiteralPath $deletionTarget -Recurse -Force";
  human('Удали папку ~/old-tmp');
  let d = shell(psDel);
  ok('без «да»: отказ про «да», а не про «проверить нельзя»', d.deny && /нет «да»/.test(d.reason) && !/проверить нельзя/.test(d.reason), d.reason);
  human('да');
  d = shell(psDel);
  ok('после «да» на названную папку команда с переменной проходит', !d.deny, d.reason);
  d = shell("$p = Join-Path $env:USERPROFILE 'old-tmp'; if (Test-Path $p) { Remove-Item -Recurse -Force $p }");
  ok('Join-Path с $env:USERPROFILE тоже раскрывается и проходит', !d.deny, d.reason);
  d = shell("$other = '" + fwd(path.join(HOME, 'work')) + "'; Remove-Item -LiteralPath $other -Recurse -Force");
  ok('чужая папка через переменную: не названа человеком, отказ с «не названо»', d.deny && /не названо/.test(d.reason), d.reason);
  d = shell('Remove-Item -LiteralPath $neverSet -Recurse -Force');
  ok('переменная без присвоения остаётся неизвестной: отказ «проверить нельзя»', d.deny && /проверить нельзя/.test(d.reason), d.reason);
  d = shell("$t = '" + target + "'; $t = (Get-Content $env:X); Remove-Item -LiteralPath $t -Recurse -Force");
  ok('переменная присвоена дважды: неизвестна, отказ', d.deny && /проверить нельзя/.test(d.reason), d.reason);
  d = shell("$t = (Get-Content $env:X); Remove-Item -LiteralPath $t -Recurse -Force");
  ok('значение из команды (не литерал): неизвестно, отказ', d.deny && /проверить нельзя/.test(d.reason), d.reason);
  d = shell("$t = '" + fwd(HOME) + "'; Remove-Item -LiteralPath $t -Recurse -Force");
  ok('домашняя папка целиком через переменную: «нет» без обсуждения', d.deny && /домашняя папка/.test(d.reason), d.reason);

  S.section('вложенный проект со своим .git закрывается в .gitignore сам, на сообщении человека (текст правил не помогал)');
  H.write(path.join(ROOT, 'my-shop', '.git', 'HEAD'), 'ref: refs/heads/main\n');
  H.write(path.join(ROOT, 'my-shop', 'README.md'), '# shop\n');
  const giBefore = fs.existsSync(path.join(ROOT, '.gitignore')) ? H.read(path.join(ROOT, '.gitignore')) : '';
  ok('до сообщения человека my-shop в .gitignore нет', !/\/my-shop\//.test(giBefore));
  let hm = human('Я скопировал проект в главную папку, это my-shop. Продолжай.');
  ok('после сообщения человека в .gitignore главной папки дописано /my-shop/', /^\/my-shop\/$/m.test(H.read(path.join(ROOT, '.gitignore'))), H.read(path.join(ROOT, '.gitignore')));
  ok('ИИ получает строку о том, что сделано (additionalContext)', /my-shop/.test(hm.out) && /additionalContext/.test(hm.out), hm.out);
  hm = human('да');
  ok('второе сообщение: уже закрыто, ИИ ничего не сообщается, дублей в .gitignore нет', hm.out === '' && (H.read(path.join(ROOT, '.gitignore')).match(/\/my-shop\//g) || []).length === 1, hm.out);
  r = wp(['gitignore', 'check']);
  ok('gitignore check: вложенный репозиторий закрыт', r.code === 0 && /закрыты в \.gitignore: my-shop/.test(r.out), r.all);
  fs.rmSync(path.join(ROOT, 'my-shop'), { recursive: true, force: true });

  S.section('круглые скобки: cd внутри (...) действует только до закрывающей скобки');
  H.write(path.join(HOME, 'work', 'shop', 'cart.js'), 'x');
  d = shell("mkdir -p workspaces/review-copies/data/x && (cd ~/work/shop && git diff) > workspaces/review-copies/data/x/diff.txt && ls workspaces", 'Bash');
  ok('`(cd ~/work/shop && git diff) > workspaces/.../diff.txt`: файл относительно главной папки, проходит (тупик проверки перед push)', !d.deny, d.reason);
  d = shell('cd ~/work/shop && git diff > out.txt', 'Bash');
  ok('без скобок cd действует: `cd ~/work/shop && git diff > out.txt` пишет в чужую папку, нужно «да»', d.deny && /(нет «да»|не названо)/.test(d.reason), d.reason);
  d = shell('(cd ~/work/shop && git diff > out.txt)', 'Bash');
  ok('внутри скобок cd действует: запись в чужую папку остановлена', d.deny, d.reason);

  S.section('настройки программы названы по имени: «в VS Code» называет settings.json');
  const settings = path.join(code, 'settings.json');
  human('Поменяй в VS Code размер шрифта на 15');
  d = write(settings);
  ok('без «да»: отказ', d.deny && /нет «да»/.test(d.reason), d.reason);
  human('да');
  d = write(settings);
  ok('«да» после просьбы про VS Code покрывает его settings.json без плана и без второго «да»', !d.deny, d.reason);
  ok('перед правкой сторож положил копию settings.json', fs.existsSync(path.join(ROOT, '.workplace', 'backups', 'index.jsonl')) && /Code/.test(H.read(path.join(ROOT, '.workplace', 'backups', 'index.jsonl'))), '');
  human('Добавь строку в ~/.zshrc'); human('да');
  d = write(settings);
  ok('«да» про другое («~/.zshrc») settings.json VS Code не покрывает', d.deny && /не названо/.test(d.reason), d.reason);
  const other = path.join(HOME, 'AppData', 'Roaming', 'Cursor', 'User', 'settings.json');
  human('Поменяй в VS Code размер шрифта на 15'); human('да');
  d = write(other);
  ok('«VS Code» не называет настройки Cursor', d.deny && /не названо/.test(d.reason), d.reason);

  S.section('справка не установка; Glob по .env показывает только имена');
  d = shell('claude --version; claude update --help', 'Bash');
  ok('`claude update --help` не считается обновлением', !d.deny, d.reason);
  d = shell('claude update', 'Bash');
  ok('`claude update` без «да» по-прежнему останавливается', d.deny, d.reason);
  d = hook('secret-guard', { hook_event_name: 'PreToolUse', tool_name: 'Glob', tool_input: { pattern: '.env*', path: ROOT }, cwd: ROOT });
  ok('Glob `.env*`: «есть ли .env» спросить можно (только имена)', !d.deny, d.reason);
  d = hook('secret-guard', { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path.join(ROOT, '.env') }, cwd: ROOT });
  ok('Read `.env` по-прежнему остановлен', d.deny, d.reason);

  S.section('wp.js backup');
  r = wp(['backup']); ok('backup без пути: код 2', r.code === 2, r.all);
  r = wp(['backup', path.join(HOME, 'нет-такого.txt')]); ok('backup несуществующего: код 0, «нечего копировать»', r.code === 0 && /Нечего копировать/.test(r.out), r.all);
  r = wp(['backup', settings]);
  ok('backup файла: копия в .workplace/backups', r.code === 0 && /Копия файла|Такая копия уже есть/.test(r.out), r.all);
  r = wp(['backup', path.join(HOME, 'old-tmp')]);
  ok('backup папки: копия папки со всеми файлами', r.code === 0 && /Копия папки/.test(r.out) && /файлов 1/.test(r.out), r.all);
  ok('исходная папка на месте после backup', H.exists(path.join(HOME, 'old-tmp', 'cache', 'a.txt')));
  r = wp(['help']); ok('help называет backup', /backup/.test(r.out), r.out);

  S.section('install и path-fix: флаг --yes сам «да» не доказывает');
  const inst = require(path.join(H.KIT, 'core', 'lib', 'install.js'));
  const u = require(path.join(H.KIT, 'core', 'lib', 'util.js'));
  const consent = require(path.join(H.KIT, 'core', 'lib', 'consent.js'));
  const fake = path.join(TMP, 'fake-root');
  fs.mkdirSync(path.join(fake, '.workplace'), { recursive: true });
  const thr = (fn) => { try { fn(); return null; } catch (e) { return e; } };
  let e = thr(() => inst.requireHuman({ root: fake, yes: true }, 'install claude', ['claude']));
  ok('записей нет и слов человека нет: отказ (код 2), «один флаг --yes ничего не доказывает»', e instanceof u.WpError && e.code === 2 && /--yes ничего не доказывает/.test(e.message), e && e.message);
  e = thr(() => inst.requireHuman({ root: fake, yes: true, humanSaid: 'ставь' }, 'install claude', ['claude']));
  ok('слова без «да»: отказ', e instanceof u.WpError && /нет «да»/.test(e.message), e && e.message);
  e = thr(() => inst.requireHuman({ root: fake, yes: true, humanSaid: 'нет, не надо' }, 'install claude', ['claude']));
  ok('«нет, не надо»: отказ', e instanceof u.WpError, e && e.message);
  const c1 = inst.requireHuman({ root: fake, yes: true, humanSaid: 'Да, ставь' }, 'install claude', ['claude']);
  ok('слова с «да» при пустом сторожe: цитата не доказательство, пометка «не проверено пакетом: подтвердить должен был человек в окне разрешения программы; если программа работала без запросов, подтверждения не было», слова «подтверждено» нет, verified: false', c1.via === 'не проверено пакетом: подтвердить должен был человек в окне разрешения программы; если программа работала без запросов, подтверждения не было' && !/подтверждено/.test(c1.via) && c1.via === inst.NATIVE_PROMPT_ONLY && c1.verified === false && !('quote' in c1), JSON.stringify(c1));
  ok('цитата ИИ записана отдельно как claimedByAi (не как слова человека)', c1.claimedByAi === 'Да, ставь', JSON.stringify(c1));
  ok('пометки «сообщение человека» и verified: true в записи без сторожа нет', !/сообщение человека/.test(c1.via) && c1.verified !== true, JSON.stringify(c1));
  const rep = require(path.join(H.KIT, 'core', 'lib', 'report.js'));
  const stateLib = require(path.join(H.KIT, 'core', 'lib', 'state.js'));
  try {
    const stR = stateLib.need(ROOT);
    stateLib.addInstall(stR, { id: 'claude', how: 'official', command: 'x', ok: true, version: '1.0.0', declared: [], confirmation: c1 });
    stateLib.save(ROOT, stR);
    const txt = rep.build(ROOT, {});
    const stU = stateLib.need(ROOT); stU.installs.pop(); stateLib.save(ROOT, stU);
    const body = typeof txt === 'string' ? txt : String(txt && (txt.text || txt.md || txt.body || JSON.stringify(txt)));
    ok('install-report.md (install): «не проверено пакетом: подтвердить должен был человек в окне разрешения программы; если программа работала без запросов, подтверждения не было», без слова «подтверждено», слова ИИ названы словами ИИ', body.includes('«да»: не проверено пакетом: подтвердить должен был человек в окне разрешения программы; если программа работала без запросов, подтверждения не было') && !/«да»: подтверждено/.test(body) && /которые передал ИИ, пакет не проверял/.test(body), body.slice(0, 600));
    ok('install-report.md не выдаёт цитату ИИ за «сообщение человека»', !/«да»: сообщение человека/.test(body), body.slice(0, 600));
  } catch (err) { ok('отчёт установки собирается из записи без сторожа', false, String(err && err.stack || err).slice(0, 500)); }
  const instMd = fs.readFileSync(path.join(H.KIT, 'INSTALL.md'), 'utf8');
  ok('INSTALL.md: на установке не включать режимы без запросов (bypass, auto-approve) и не просить человека их включать', /не включай режимы без запросов/.test(instMd) && /bypass permissions/.test(instMd) && /auto-approve/.test(instMd) && /не проси меня их включать/.test(instMd));
  ok('INSTALL.md: подлинность «да» на этапе 1 проверяет окно разрешения программы, а не пакет', /проверяет не пакет, а сама программа/.test(instMd) && instMd.includes('не проверено пакетом: подтвердить должен был человек в окне разрешения программы; если программа работала без запросов, подтверждения не было') && !/подтверждено запросом разрешения программы/.test(instMd));
  consent.record(fake, { prompt: 'поставь клода' });
  e = thr(() => inst.requireHuman({ root: fake, yes: true, humanSaid: 'да, ставь' }, 'install claude', ['claude']));
  ok('сторож видит сообщения: --human-said не помогает, нужно «да» в последнем сообщении (код 3)', e instanceof u.WpError && e.code === 3 && /нет «да»/.test(e.message), e && e.message);
  consent.record(fake, { prompt: 'да' });
  const c2 = inst.requireHuman({ root: fake, yes: true }, 'install claude', ['claude']);
  ok('«да» и «клода» названо в двух последних сообщениях: принято самим сторожем', /сторож видел/.test(c2.via) && !c2.quote, JSON.stringify(c2));
  e = thr(() => inst.requireHuman({ root: fake, yes: true }, 'install codex', ['codex']));
  ok('«да» про клода не покрывает установку Codex (код 3)', e instanceof u.WpError && e.code === 3 && /не названо/.test(e.message), e && e.message);
  consent.registerPlan(fake, 'Ставлю Codex и git');
  consent.record(fake, { prompt: 'да' });
  const c3 = inst.requireHuman({ root: fake, yes: true }, 'install codex', ['codex']);
  ok('принятый план с названием Codex покрывает установку', /сторож видел/.test(c3.via), JSON.stringify(c3));
  r = wp(['install', 'git', '--yes']);
  ok('wp.js install git --yes без слов человека (или «уже есть»): ничего не ставит без подтверждения', r.code === 0 ? /уже есть|не переустанавливаю/.test(r.out) : (r.code === 3 || r.code === 2), r.all);

  S.section('разведка: основной Codex не назван «экспериментальным»');
  const recon = fs.readFileSync(path.join(H.KIT, 'core', 'lib', 'recon.js'), 'utf8');
  ok('в recon.js нет слова «экспериментально» про основной Codex', !/экспериментальн/.test(recon));
  ok('в тексте пакета (INSTALL, README, шаблоны правил, навыки, docs) нет «# CONFIRMED» и «checks/.skip» как действующих приёмов', (() => {
    const bad = [];
    const walk = (d) => { for (const it of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, it.name); if (it.isDirectory()) { if (!/^(tests|hooks|node_modules)$/.test(it.name)) walk(p); } else if (/\.(md|tpl)$/.test(it.name) && !/CHANGELOG/.test(it.name)) { const t = fs.readFileSync(p, 'utf8'); if (/#\s*CONFIRMED|checks\/\.skip/.test(t)) bad.push(path.relative(H.KIT, p)); } } };
    walk(H.KIT);
    return bad.length === 0 ? true : bad.join(', ');
  })() === true);
} catch (e) {
  ok('набор дошёл до конца без исключения', false, e && e.stack);
} finally {
  H.rmTree(TMP);
}
process.exit(S.finish());
