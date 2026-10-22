'use strict';
// Общие части провайдеров. Различие направлений (команда проверяющего, признак входа, установка) живёт ТОЛЬКО в claude.js и codex.js;
// всё одинаковое для обоих вынесено сюда.
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const u = require('../lib/util');

const QUOTA_RX = /usage limit|quota|rate limit|\b429\b|credits|exceeded your|limit reached/i;
const AUTH_RX = /\b401\b|unauthori[sz]ed|not logged in|please (log ?in|sign in|run \/login)|invalid (api )?key|authentication/i;
const SANDBOX_RX = /permission denied|operation not permitted|sandbox (error|denied|violation)|blocked by (the )?sandbox|rejected by sandbox/i;
const NETWORK_RX = /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|connection error|network is unreachable|127\.0\.0\.1:9\b/i;

// Все копии программы с версиями. usable = запускается и отвечает на --version.
function detectCopies(name) {
  const copies = u.findAll(name).map((c) => {
    const v = u.versionOf(c.path);
    return { path: u.tilde(c.path), kind: u.kindOf(c.path), version: v.version, usable: v.ok, error: v.error, via: c.via, _abs: c.path };
  });
  const primary = copies.find((c) => c.usable && c.via.includes('PATH')) || copies.find((c) => c.usable) || null;
  return { copies, primary };
}
// Абсолютный путь с именем пользователя нужен только внутри процесса: в JSON (recon --json, recon-before.json) он не попадает (свойство не перечисляется).
function withAbs(obj, abs) { Object.defineProperty(obj, '_abs', { value: abs, enumerable: false }); return obj; }
function publicCopy(c) { if (!c) return null; const { _abs, ...rest } = c; return rest; }

// Запуск проверяющего. Асинхронно: на таймауте убивается всё дерево процессов и результат отдаётся сразу, не дожидаясь события close
// (внук процесса держит канал, close может не прийти). Промпт идёт через stdin: в командной строке только постоянные флаги.
// Ход работы (stderr) пишется в файл по мере поступления, в памяти хранится только хвост.
function spawnReview(o) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    let timedOut = false;
    let stdout = '';
    let tail = '';
    const log = o.logFile ? fs.openSync(o.logFile, 'w') : null;
    const done = (extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (log !== null) { try { fs.closeSync(log); } catch (_) { /* закрыт */ } }
      resolve(Object.assign({ durationMs: Date.now() - started, stdout, stderrTail: tail, timedOut }, extra));
    };
    const env = u.childEnv(o.env);
    for (const k of o.dropEnv || []) delete env[k];
    let child;
    try {
      child = u.needsShell(o.cmd)
        ? cp.spawn([o.cmd, ...o.args].map(u.q).join(' '), { cwd: o.cwd, shell: true, windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'] })
        : cp.spawn(o.cmd, o.args, { cwd: o.cwd, windowsHide: true, env, detached: !u.IS_WIN, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { return done({ code: null, spawnError: e.message }); }
    const timer = setTimeout(() => { timedOut = true; u.killTree(child.pid); done({ code: null }); }, o.timeoutMs);
    child.on('error', (e) => done({ code: null, spawnError: e.message }));
    child.stdout.on('data', (d) => { if (stdout.length < 4 * 1024 * 1024) stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => {
      const s = d.toString('utf8');
      if (log !== null) { try { fs.writeSync(log, s); } catch (_) { /* диск */ } }
      tail = (tail + s).slice(-6000);
    });
    child.on('close', (code) => done({ code }));
    child.stdin.on('error', () => { /* процесс закрыл ввод раньше */ });
    try { child.stdin.end(o.input); } catch (_) { /* уже закрыт */ }
  });
}

// Быстрая проверка сети: соединение с хостом проверяющего за несколько секунд. Нужна, чтобы закрытая сеть (песочница основного Codex) не давала зависания на ~2 минуты:
// `claude -p` без сети молчит и падает по своему таймауту. host и port можно подменить переменными WP_NET_PROBE_HOST и WP_NET_PROBE_PORT (тесты);
// WP_NET_PROBE=off отключает проверку (тесты на заглушках без сети). Возвращает Promise<{ ok, code }>.
function probeNetwork(host, port, timeoutMs) {
  const net = require('net');
  return new Promise((resolve) => {
    let done = false;
    const fin = (r) => { if (!done) { done = true; try { sock.destroy(); } catch (_) { /* закрыт */ } resolve(r); } };
    const sock = net.connect({ host: process.env.WP_NET_PROBE_HOST || host, port: parseInt(process.env.WP_NET_PROBE_PORT || port, 10) });
    sock.setTimeout(timeoutMs || 5000, () => fin({ ok: false, code: 'ETIMEDOUT' }));
    sock.on('connect', () => fin({ ok: true, code: null }));
    sock.on('error', (e) => fin({ ok: false, code: (e && e.code) || 'ERROR' }));
  });
}

// Разбор исхода: не ok-подсказки смотрятся только при неудаче (в журнале проверяющего бывает текст проверяемых файлов).
function classify(r, answerText) {
  if (r.spawnError) return { kind: 'not-installed', hint: 'Программа проверяющего не запустилась (' + r.spawnError + '). Она не найдена или не запускается: wp.js plan покажет, что поставить после «да».' };
  if (r.timedOut) return { kind: 'timeout', hint: 'Время вышло: проверяющий остановлен вместе с дочерними процессами. Сузь проверку (меньше файлов) и повтори один раз.' };
  const ok = r.code === 0 && /\S/.test(answerText || '');
  if (ok) return { kind: 'ok', hint: '' };
  const text = (r.stderrTail || '') + ' ' + (r.stdout || '').slice(-2000);
  if (QUOTA_RX.test(text)) return { kind: 'quota', hint: 'Похоже на лимит тарифа: повтор бесполезен, лимит восстанавливается со временем. Свою проверку вместо проверяющего не подставляй.' };
  if (AUTH_RX.test(text)) return { kind: 'auth', hint: 'Похоже на вход в аккаунт проверяющего: вход выполняет человек в браузере (wp.js plan показывает команду), потом один повтор.' };
  if (SANDBOX_RX.test(text)) return { kind: 'sandbox', hint: 'Похоже на ограничение песочницы: повтори один раз, потом покажи человеку журнал проверки.' };
  if (NETWORK_RX.test(text)) return { kind: 'network', hint: 'Нет сети из этого окружения (у Codex это песочница без сети): запусти проверяющего из окружения с доступом к сети.' };
  if (r.code === 0) return { kind: 'empty', hint: 'Код выхода 0, но ответа нет: проверка не состоялась. Один повтор, потом покажи человеку журнал.' };
  return { kind: 'failed', hint: 'Проверяющий завершился с кодом ' + r.code + ' без осмысленного ответа. Покажи человеку журнал.' };
}

// Папка для PATH дочернего процесса: найденный по абсолютному пути файл вызывается напрямую, профили оболочки не правятся (К11).
function childPathWith(binPath) {
  const dir = path.dirname(binPath);
  return { PATH: dir + path.delimiter + (process.env.PATH || process.env.Path || '') };
}

// Установка через npm без sudo (запасной путь): сначала без префикса, при EACCES повтор с префиксом в домашней папке; кэш npm в корень (К13).
function npmPlan(pkg, o) {
  const prefix = path.join(u.homeDir(), '.npm-global');
  const env = { npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' };
  if (o && o.root) env.npm_config_cache = path.join(o.root, '.workplace', 'npm-cache');
  const base = ['install', '-g', pkg];
  return {
    kind: 'npm',
    title: 'npm install -g ' + pkg + ' (запасной путь, без sudo)',
    source: 'https://www.npmjs.com/package/' + pkg,
    run: { cmd: 'npm', args: base, env },
    retryOnEacces: { cmd: 'npm', args: ['install', '-g', '--prefix', prefix, pkg], env },
    binDir: u.IS_WIN ? prefix : path.join(prefix, 'bin'),
    post: [{ cmd: 'npm', args: ['cache', 'clean', '--force'], env }],
    needsPassword: false,
    needsAdmin: false,
    editsProfile: false,
    writes: [u.tilde(path.join(u.homeDir(), '.npm-global')), o && o.root ? '.workplace/npm-cache (внутри главной папки)' : '~/.npm (кэш npm)'],
    requires: { node: '>=18' },
  };
}

// Менеджеры пакетов и версий Node, которые есть на машине (имя и путь).
function managers() {
  const m = [];
  const add = (n, p) => { if (p) m.push({ name: n, path: u.tilde(p) }); };
  add('npm', (u.findAll('npm')[0] || {}).path);
  add(u.IS_WIN ? 'winget' : 'brew', (u.findAll(u.IS_WIN ? 'winget' : 'brew')[0] || {}).path);
  for (const n of ['volta', 'fnm', 'asdf', 'nodenv', 'n']) add(n, (u.findAll(n)[0] || {}).path);
  const h = u.homeDir();
  if (u.isDir(path.join(h, '.nvm'))) add('nvm', path.join(h, '.nvm'));
  if (u.IS_WIN && u.isDir(path.join(u.appData(), 'nvm'))) add('nvm-windows', path.join(u.appData(), 'nvm'));
  return m;
}

module.exports = { probeNetwork, NETWORK_RX, withAbs, managers, QUOTA_RX, AUTH_RX, detectCopies, publicCopy, spawnReview, classify, childPathWith, npmPlan };
