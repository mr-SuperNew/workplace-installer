'use strict';
// Провайдер Claude Code. Интерфейс тот же, что у codex.js:
//   name, label, vendor
//   detect()                           все копии, версии, абсолютные пути, расширение VS Code, менеджеры Node
//   loginHint()                        пассивный признак входа (только наличие файла/записи; процессов нет)
//   loginStatus({confirmed})           `claude auth status`: создаёт файлы, поэтому только после «да» (confirmed: true)
//   review({dir, prompt, outFile, timeoutMs, model, logFile}) -> Promise<{ok, kind, text, outFile, hint, ...}>
//   reviewCommand({dir, model})        как будет запущен проверяющий (для показа человеку и тестов)
//   installPlan(osInfo, {root})        официальный установщик, запасной путь npm без sudo, кэш npm в корень, вход
//   hooksFile, skillsDir, rulesFile    где живут хуки, навыки и правила этого провайдера в главной папке
const fs = require('fs');
const path = require('path');
const u = require('../lib/util');
const vscode = require('../lib/vscode');
const common = require('./_common');
const { INSTALLERS } = require('../lib/installers');

const name = 'claude';
const MIN_VERSION = [2, 1, 277];   // рекомендуемая версия: @AGENTS.md в CLAUDE.md и хуки (v3)

function loginHint() {
  const h = u.homeDir();
  if (u.IS_MAC && !process.env.WP_HOME) {
    // запись в Связке ключей: метаданные без значения пароля (флаги -w и -g не используются)
    const k = u.run('security', ['find-generic-password', '-s', 'Claude Code-credentials'], { timeout: 5000 });
    return { state: k.ok ? 'present' : 'absent', method: 'запись в Связке ключей', approximate: true };
  }
  return { state: u.exists(path.join(h, '.claude', '.credentials.json')) ? 'present' : 'absent', method: 'файл входа', approximate: true };
}

function detect() {
  const d = common.detectCopies('claude');
  const ext = (vscode.listExtensions()['anthropic.claude-code'] || [])[0] || null;
  let bundled = null;
  if (ext) {
    const bin = path.join(ext.dir, 'resources', 'native-binary', u.IS_WIN ? 'claude.exe' : 'claude');
    if (u.exists(bin)) bundled = { version: ext.version, where: 'внутри расширения VS Code' };
  }
  return {
    name,
    program: 'claude',
    copies: d.copies.map(common.publicCopy),
    primary: d.primary ? common.withAbs({ path: d.primary.path, version: d.primary.version }, d.primary._abs) : null,
    console: !!d.primary,
    extension: ext ? { version: ext.version, where: ext.where, bundled } : null,
    present: !!d.primary || !!ext,
    login_hint: loginHint(),
    managers: common.managers(),
    min_version: MIN_VERSION.join('.'),
  };
}

function binary(d) {
  d = d || detect();
  return d.primary ? d.primary._abs : 'claude';
}

function loginStatus(o) {
  o = o || {};
  if (!o.confirmed) return { state: 'unchecked', method: null, detail: '`claude auth status` создаёт файлы настроек: запускается только после «да» человека (confirmed: true). Пока доступен пассивный признак loginHint().' };
  const p = (o.detect || detect()).primary;
  if (!p) return { state: 'unavailable', method: null, detail: 'консольной команды claude нет' };
  const r = u.run(p._abs, ['auth', 'status'], { timeout: 20000 });
  let j = null;
  try { j = JSON.parse(r.out); } catch (_) { j = null; }
  if (j && typeof j.loggedIn === 'boolean') {
    const method = String(j.authMethod || '');
    if (!j.loggedIn) return { state: 'none', method: method || null, detail: 'не вошёл в аккаунт' };
    if (/api/i.test(method) && !/oauth|claude/i.test(method)) return { state: 'api-key', method, detail: 'вход по ключу API: платный, для подписки не годится' };   // TODO: verify имена authMethod
    return { state: 'ok', method: method || null, detail: 'вход выполнен' };
  }
  if (!r.ok) return { state: 'none', method: null, detail: 'код ' + r.code + (r.err ? ': ' + r.err.split(/\r?\n/)[0].slice(0, 120) : '') };
  return { state: 'unknown', method: null, detail: 'ответ не разобран' };
}

// «Чистый» проверяющий: без личных и проектных правил (опыт 1: --setting-sources ""), только чтение (--tools), без сохранения сессии.
// --tools перечисляет несколько значений (`--tools <tools...>` в `claude --help`), поэтому промпт идёт через stdin, а не позиционным аргументом (иначе он стал бы именем инструмента).
// Проверено живым прогоном tests/live/real-reviewer.js --reviewer claude --model haiku (21.10.2026, claude 2.1.306, Windows 11): `claude -p` без позиционного промпта берёт задание из stdin, верная копия GREEN, копия с ошибкой RED (build/reports/E-live-claude.log). Mac: TODO: verify на обкатке.
// Весь нужный контекст проверяющий получает в самом задании: правил проекта он не видит. Режим «голого» запуска (флаг с именем bare) не используется: он не читает вход по подписке.
function reviewArgs(o) {
  const a = ['-p', '--tools', 'Read,Grep,Glob', '--permission-mode', 'dontAsk', '--no-session-persistence', '--setting-sources', '', '--output-format', 'text'];
  if (o && o.model) a.push('--model', o.model);
  return a;
}
function reviewCommand(o) {
  o = o || {};
  return { cmd: binary(o.detect), args: reviewArgs(o), cwd: o.dir || null, stdin: 'prompt', note: 'ключ ANTHROPIC_API_KEY из окружения убирается: проверка идёт по подписке' };
}

const NO_NETWORK_HINT = 'Из этого окружения нет сети: основной Codex запускает проверяющего Claude из песочницы без сети. Нужны режим workspace-write и сеть: в <главная папка>/.codex/config.toml должно стоять `[sandbox_workspace_write]` и `network_access = true` (его пишет `wp.js layout`), Codex нужно перезапустить в доверенной папке; запасной путь: запустить основной Codex с флагом `-c sandbox_workspace_write.network_access=true`. Пока сети нет, проверка Claude недоступна: выпуск 1 рассчитан на основной Claude Code с проверяющим Codex.';

async function review(o) {
  if (!o || !o.dir || typeof o.prompt !== 'string' || !o.outFile) throw new u.WpError('review: нужны dir, prompt, outFile', 2);
  const noNet = (why) => ({ ok: false, kind: 'no-network', text: '', outFile: o.outFile, hint: NO_NETWORK_HINT, code: null, durationMs: 0, stderrTail: why });
  // Признак песочницы без сети: переменную ставит Codex командам в песочнице без сети (TODO: verify имя переменной на живом Codex; ниже проверка соединением, она от имени не зависит).
  if (process.env.CODEX_SANDBOX_NETWORK_DISABLED === '1') return noNet('CODEX_SANDBOX_NETWORK_DISABLED=1');
  // Быстрая проверка соединения (до 5 с): иначе закрытая сеть даёт молчаливое зависание на ~2 минуты.
  // За прокси (HTTPS_PROXY и подобные) голое соединение с api.anthropic.com:443 не показатель: claude ходит через прокси, а проба дала бы ложное «нет сети» (N5 этапа Ж).
  const viaProxy = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'].some((k) => process.env[k]);
  if (process.env.WP_NET_PROBE !== 'off' && !viaProxy) {
    const t0 = Date.now();
    const pr = await common.probeNetwork('api.anthropic.com', 443, 5000);
    if (!pr.ok) { const r = noNet('нет соединения с api.anthropic.com:443 (' + pr.code + ')'); r.durationMs = Date.now() - t0; return r; }
  }
  const c = reviewCommand(o);
  const r = await common.spawnReview({ cmd: c.cmd, args: c.args, cwd: o.dir, input: o.prompt, timeoutMs: o.timeoutMs || 540000, logFile: o.logFile, env: o.env, dropEnv: ['ANTHROPIC_API_KEY'] });
  const text = (r.stdout || '').trim();
  const cl = common.classify(r, text);
  if (cl.kind === 'ok') fs.writeFileSync(o.outFile, text + '\n');
  return { ok: cl.kind === 'ok', kind: cl.kind, text: cl.kind === 'ok' ? text : '', outFile: o.outFile, hint: cl.kind === 'network' ? NO_NETWORK_HINT : cl.hint, code: r.code, durationMs: r.durationMs, stderrTail: cl.kind === 'ok' ? '' : r.stderrTail };
}

// Что нужно, когда проверяющим работает Claude, а основной - Codex (опыт 4).
function reviewRequirements() {
  return {
    whenMainIs: 'codex',
    codexSandbox: 'workspace-write',
    codexArgs: ['-c', 'sandbox_workspace_write.network_access=true'],
    claudeArgs: ['--no-session-persistence'],
    configFile: '.codex/config.toml',
    configToml: '[sandbox_workspace_write]\nnetwork_access = true',
    note: 'В read-only песочнице Codex сети нет, вызов `claude -p` зависает примерно на 120 с и падает без вывода. Нужны workspace-write и network_access=true: wp.js layout пишет их в <корень>/.codex/config.toml, а review() проверяет соединение за 5 с и честно отвечает no-network. Успех проверять по непустому ответу, а не по коду выхода. TODO: verify на живом Codex, что config.toml проекта действует так же, как флаг -c.',
  };
}

function installPlan(osInfo, o) {
  osInfo = osInfo || {};
  o = o || {};
  const win = (osInfo.platform || process.platform) === 'win32';
  const primary = win
    ? { kind: 'script', title: 'Официальный установщик Claude Code для Windows (PowerShell)', source: 'https://code.claude.com/docs/en/setup', shell: 'powershell', display: 'irm ' + INSTALLERS.claude.ps1 + ' | iex',
      run: { cmd: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm ' + INSTALLERS.claude.ps1 + ' | iex'] },
      writes: ['~/.local/bin/claude.exe', '~/.local/share/claude'], editsProfile: false, needsPassword: false, needsAdmin: false }
    : { kind: 'script', title: 'Официальный установщик Claude Code для macOS и Linux', source: 'https://code.claude.com/docs/en/setup', shell: 'sh', display: 'curl -fsSL ' + INSTALLERS.claude.sh + ' | bash',
      run: { cmd: 'sh', args: ['-c', 'curl -fsSL ' + INSTALLERS.claude.sh + ' | bash'] },
      writes: ['~/.local/bin/claude', '~/.local/share/claude', '~/.claude'], editsProfile: true, needsPassword: false, needsAdmin: false };   // TODO: verify: дописывает ли установщик PATH в профиль оболочки
  return {
    provider: name,
    os: osInfo.platform || process.platform,
    primary,
    fallback: Object.assign(common.npmPlan('@anthropic-ai/claude-code', o), { requires: { node: '>=22' } }),   // документация Anthropic: для npm-варианта Node 22+ (research/2026-10-21-external-facts.md, строка про npm); install.js не запускает запасной путь на более старом Node
    verify: { args: ['--version'], expect: /\d+\.\d+\.\d+/ },
    login: { human: true, how: 'Запусти `claude`: откроется браузер, войди в аккаунт Claude (подписка Pro или выше). Пароль и вход вводит человек.', status: { args: ['auth', 'status'], afterYes: true }, browser: true },
    notes: ['Нативная установка обновляется сама. Возможная вторая копия (npm рядом с родной) не удаляется без «да».', 'Если в окружении стоит ANTHROPIC_API_KEY, `claude -p` использует его вместо подписки: ключ убирается из окружения проверяющего.'],
  };
}

const rules = { hooksFile: '.claude/settings.json', skillsDir: '.claude/skills', rulesFile: 'CLAUDE.md', rulesImport: '@AGENTS.md' };

module.exports = Object.assign({
  name, label: 'Claude Code', vendor: 'Anthropic', MIN_VERSION,
  detect, binary, loginHint, loginStatus, review, reviewCommand, reviewArgs, reviewRequirements, installPlan,
}, rules);
