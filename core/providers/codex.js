'use strict';
// Провайдер Codex CLI. Интерфейс тот же, что у claude.js (см. шапку там).
// Расширение Codex в VS Code консольным Codex не считается (решение 21.10): в таблице разведки это две отдельные строки.
const fs = require('fs');
const path = require('path');
const u = require('../lib/util');
const vscode = require('../lib/vscode');
const common = require('./_common');
const { INSTALLERS } = require('../lib/installers');

const name = 'codex';

function loginHint() {
  return { state: u.exists(path.join(u.codexHome(), 'auth.json')) ? 'present' : 'absent', method: 'файл входа (содержимое не читается)', approximate: true };
}

function detect() {
  const d = common.detectCopies('codex');
  const ext = (vscode.listExtensions()['openai.chatgpt'] || [])[0] || null;
  return {
    name,
    program: 'codex',
    copies: d.copies.map(common.publicCopy),
    primary: d.primary ? common.withAbs({ path: d.primary.path, version: d.primary.version }, d.primary._abs) : null,
    console: !!d.primary,
    extension: ext ? { version: ext.version, where: ext.where, bundled: null } : null,
    present: !!d.primary || !!ext,
    login_hint: loginHint(),
    codex_home_overridden: !!process.env.CODEX_HOME,
    managers: common.managers(),
  };
}

function binary(d) {
  d = d || detect();
  return d.primary ? d.primary._abs : 'codex';
}

// Вход определяется по `codex login status` (код 0 при входе), не по файлу auth.json.
function loginStatus(o) {
  o = o || {};
  const p = (o.detect || detect()).primary;
  if (!p) return { state: 'unavailable', method: null, detail: 'консольной команды codex нет' };
  const r = u.run(p._abs, ['login', 'status'], { timeout: 20000 });
  const text = r.out + ' ' + r.err;
  if (r.ok && /logged in/i.test(text)) {
    if (/api key/i.test(text)) return { state: 'api-key', method: 'api-key', detail: 'вход по ключу API: платный, для подписки ChatGPT не годится' };
    return { state: 'ok', method: /chatgpt/i.test(text) ? 'chatgpt' : 'unknown', detail: 'вход выполнен' };
  }
  if (/not logged in/i.test(text) || r.code === 1) return { state: 'none', method: null, detail: 'не вошёл в аккаунт' };
  if (r.ok) return { state: 'unknown', method: null, detail: 'ответ не разобран' };
  return { state: 'unknown', method: null, detail: 'код ' + r.code + (r.err ? ': ' + r.err.split(/\r?\n/)[0].slice(0, 120) : '') };
}

// Только чтение: песочница read-only, сессия не сохраняется, правила проекта (AGENTS.md) отключены на время запуска (-c project_doc_max_bytes=0;
// настройки на диске не меняются). Ответ в файл -o; промпт через stdin (`-`). Модель берётся из config.json (reviewer_model), по умолчанию не задана.
function reviewArgs(o) {
  const a = ['exec', '--sandbox', 'read-only', '--ephemeral', '--skip-git-repo-check', '-C', o.dir, '-o', o.outFile];
  if (o.ignoreProjectDoc !== false) a.push('-c', 'project_doc_max_bytes=0');
  if (o.model) a.push('-m', o.model);
  a.push('-');
  return a;
}
function reviewCommand(o) {
  o = o || {};
  return { cmd: binary(o.detect), args: reviewArgs(Object.assign({ dir: '<папка>', outFile: '<файл>' }, o)), cwd: o.dir || null, stdin: 'prompt', note: 'ключи OPENAI_API_KEY и CODEX_API_KEY из окружения убираются: проверка идёт по подписке' };
}

async function review(o) {
  if (!o || !o.dir || typeof o.prompt !== 'string' || !o.outFile) throw new u.WpError('review: нужны dir, prompt, outFile', 2);
  const c = reviewCommand(o);
  try { fs.rmSync(o.outFile, { force: true }); } catch (_) { /* нет файла */ }
  const r = await common.spawnReview({ cmd: c.cmd, args: c.args, cwd: o.dir, input: o.prompt, timeoutMs: o.timeoutMs || 540000, logFile: o.logFile, env: o.env, dropEnv: ['OPENAI_API_KEY', 'CODEX_API_KEY'] });
  let text = '';
  try { text = fs.readFileSync(o.outFile, 'utf8').trim(); } catch (_) { text = ''; }
  const cl = common.classify(r, text);
  return { ok: cl.kind === 'ok', kind: cl.kind, text: cl.kind === 'ok' ? text : '', outFile: o.outFile, hint: cl.hint, code: r.code, durationMs: r.durationMs, stderrTail: cl.kind === 'ok' ? '' : r.stderrTail };
}

// Исполнитель: «отдай задачу Codex». Codex пишет в папке dir (песочница workspace-write: запись только туда), задание идёт через stdin, итог в файл -o.
// Проверяющий (review) остаётся в режиме read-only: это разные роли. Ключи OPENAI_API_KEY и CODEX_API_KEY из окружения убираются: работа идёт по подписке.
// Правила проекта (AGENTS.md в dir) Codex читает сам. Сохранение сессии выключено (--ephemeral): итог лежит в outFile.
function runArgs(o) {
  const a = ['exec', '--sandbox', 'workspace-write', '--ephemeral', '--skip-git-repo-check', '-C', o.dir, '-o', o.outFile];
  if (o.model) a.push('-m', o.model);
  a.push('-');
  return a;
}
function runCommand(o) {
  o = o || {};
  return { cmd: binary(o.detect), args: runArgs(Object.assign({ dir: '<папка>', outFile: '<файл>' }, o)), cwd: o.dir || null, stdin: 'prompt', note: 'Codex работает в песочнице workspace-write: пишет только в папке задачи; ключи OPENAI_API_KEY и CODEX_API_KEY из окружения убираются' };
}
async function run(o) {
  if (!o || !o.dir || typeof o.prompt !== 'string' || !o.prompt.trim() || !o.outFile) throw new u.WpError('run: нужны dir, prompt, outFile', 2);
  if (!u.isDir(o.dir)) throw new u.WpError('run: папки ' + o.dir + ' нет', 2);
  const d = o.detect || detect();
  if (!d.primary) return { ok: false, kind: 'not-installed', text: '', outFile: o.outFile, hint: 'Консольной программы codex нет или она не запускается: wp.js plan покажет, что поставить после «да». Пока её нет, задачу сделай сам или смени основного ИИ (role set).', code: null, durationMs: 0, stderrTail: '' };
  const c = runCommand(Object.assign({}, o, { detect: d }));
  try { fs.rmSync(o.outFile, { force: true }); } catch (_) { /* нет файла */ }
  const r = await common.spawnReview({ cmd: c.cmd, args: c.args, cwd: o.dir, input: o.prompt, timeoutMs: o.timeoutMs || 30 * 60 * 1000, logFile: o.logFile, env: o.env, dropEnv: ['OPENAI_API_KEY', 'CODEX_API_KEY'] });
  let text = '';
  try { text = fs.readFileSync(o.outFile, 'utf8').trim(); } catch (_) { text = ''; }
  const cl = common.classify(r, text);
  return { ok: cl.kind === 'ok', kind: cl.kind, text: cl.kind === 'ok' ? text : '', outFile: o.outFile, hint: cl.hint, code: r.code, durationMs: r.durationMs, stderrTail: cl.kind === 'ok' ? '' : r.stderrTail };
}

// Что нужно, когда проверяющим работает Codex, а основной - Claude: ничего особого (Claude вызывает codex через обычный Bash).
function reviewRequirements() {
  return {
    whenMainIs: 'claude',
    claudeAllow: ['Bash(node .workplace/core/cli/wp.js *)'],
    note: 'Хуки проекта Codex в неинтерактивном запуске срабатывают только при доверенном проекте и флаге --dangerously-bypass-hook-trust; проверяющему хуки не нужны, он только читает.',
  };
}

function installPlan(osInfo, o) {
  osInfo = osInfo || {};
  o = o || {};
  const win = (osInfo.platform || process.platform) === 'win32';
  const primary = win
    ? { kind: 'script', title: 'Официальный установщик Codex CLI для Windows (PowerShell)', source: 'https://github.com/openai/codex', shell: 'powershell', display: 'powershell -ExecutionPolicy ByPass -c "irm ' + INSTALLERS.codex.ps1 + ' | iex"',
      run: { cmd: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'ByPass', '-Command', 'irm ' + INSTALLERS.codex.ps1 + ' | iex'] },
      writes: ['%LOCALAPPDATA%/Programs/OpenAI/Codex/bin', 'пользовательский PATH (реестр)'], editsProfile: true, needsPassword: false, needsAdmin: false }
    : { kind: 'script', title: 'Официальный установщик Codex CLI для macOS и Linux', source: 'https://github.com/openai/codex', shell: 'sh', display: 'curl -fsSL ' + INSTALLERS.codex.sh + ' | sh',
      run: { cmd: 'sh', args: ['-c', 'curl -fsSL ' + INSTALLERS.codex.sh + ' | sh'] },
      writes: ['~/.local/bin/codex', '~/.codex/packages/standalone', '~/.zprofile или ~/.zshrc (строка PATH)'], editsProfile: true, needsPassword: false, needsAdmin: false };
  return {
    provider: name,
    os: osInfo.platform || process.platform,
    primary,
    fallback: common.npmPlan('@openai/codex', o),
    verify: { args: ['--version'], expect: /\d+\.\d+\.\d+/ },
    login: { human: true, how: 'Запусти `codex login`: откроется браузер, войди через ChatGPT (Plus или выше). Нет браузера: `codex login --device-auth`. Пароль и вход вводит человек.', status: { args: ['login', 'status'], afterYes: false }, browser: true, altArgs: ['login', '--device-auth'], args: ['login'] },
    notes: ['Скрипт установки сам дописывает PATH в профиль оболочки или в пользовательский PATH: это сообщается человеку до запуска и записывается как объявленная запись (К15).', 'Вход Codex CLI общий с расширением VS Code (один файл входа в ~/.codex).'],
  };
}

const rules = { hooksFile: '.codex/hooks.json', skillsDir: '.agents/skills', rulesFile: 'AGENTS.md', rulesImport: null };

module.exports = Object.assign({
  name, label: 'Codex', vendor: 'OpenAI',
  detect, binary, loginHint, loginStatus, review, reviewCommand, reviewArgs, run, runCommand, runArgs, reviewRequirements, installPlan,
}, rules);
