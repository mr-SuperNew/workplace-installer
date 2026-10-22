'use strict';
// Обвязка тестов сторожей. Каждый тест: JSON на stdin -> код выхода и ответ хука. Хуки запускаются настоящим node, как их запускают Claude Code и Codex.
// Корни рабочего места создаются во временной папке. WP_HOME указывает на пустую фейковую домашнюю папку: хуки (и ~ в командах) видят её, а не настоящие ~/.claude и ~/.codex.
// WP_TMP_ZONES задаёт свою временную зону, поэтому фейковый HOME считается «вне главной папки», как настоящий. Команды не выполняются, хук только читает текст.
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const HOOKS = path.resolve(__dirname, '..', '..', '..', 'core', 'hooks');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-hooks-test-'));
const FAKE_HOME = path.join(TMP, 'home');
fs.mkdirSync(FAKE_HOME, { recursive: true });
// Временная зона для сторожей (WP_TMP_ZONES): отдельная папка. Настоящая временная папка ОС считалась бы «безопасной» и накрыла бы и корень, и фейковый HOME теста.
const ZONE = path.join(TMP, 'zone');
fs.mkdirSync(ZONE, { recursive: true });
const consent = require('../../../core/lib/consent');
let counter = 0;

function defaultsConfig(over) {
  const c = { schema: 1, main: 'claude', reviewer: 'codex', reviewer_model: null,
    guards: { secret_guard: true, session_start: true, danger_guard: true, feedback_reminder: true, cross_check_guard: true, model_guard: true }, cross_check_ttl_min: 120 };
  over = over || {};
  const out = Object.assign({}, c, over);
  out.guards = Object.assign({}, c.guards, over.guards || {});
  return out;
}

// Корень рабочего места: <tmp>/rootN/.workplace/config.json. opts.config - правки config.json, opts.files - { 'путь': 'текст' }.
// opts.timeline - что было в разговоре по порядку: [{ say: 'текст человека' }, { plan: 'текст плана ИИ' }]; пишется теми же функциями, что хук human-message и wp.js consent plan.
function makeRoot(opts) {
  opts = opts || {};
  const root = path.join(TMP, 'root' + (++counter));
  fs.mkdirSync(path.join(root, '.workplace'), { recursive: true });
  if (opts.config !== null) fs.writeFileSync(path.join(root, '.workplace', 'config.json'), typeof opts.rawConfig === 'string' ? opts.rawConfig : JSON.stringify(defaultsConfig(opts.config), null, 2));
  for (const [rel, text] of Object.entries(opts.files || {})) {
    const f = path.join(root, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  }
  for (const ev of opts.timeline || []) {
    if (ev.say !== undefined) consent.record(root, { prompt: ev.say, session: ev.session || null });
    else if (ev.plan !== undefined) consent.registerPlan(root, ev.plan);
  }
  return root;
}
// Папка вне рабочего места (корня выше нет).
function makeBare() { const d = path.join(TMP, 'bare' + (++counter)); fs.mkdirSync(d, { recursive: true }); return d; }

// Заглушка claude в PATH: пишет метку вызова и печатает версию. Нужна, чтобы проверить, зовёт ли session-start `claude --version`.
function makeClaudeStub(version) {
  const dir = path.join(TMP, 'stub' + (++counter));
  fs.mkdirSync(dir, { recursive: true });
  const mark = path.join(dir, 'called.txt');
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(dir, 'claude.cmd'), '@echo off\r\necho called>>"' + mark + '"\r\necho ' + version + ' (Claude Code)\r\n');
  } else {
    const f = path.join(dir, 'claude');
    fs.writeFileSync(f, '#!/bin/sh\necho called >> "' + mark + '"\necho "' + version + ' (Claude Code)"\n');
    fs.chmodSync(f, 0o755);
  }
  return { dir, mark, called: () => fs.existsSync(mark) };
}

// Запуск хука. input: объект (в JSON) или строка (как есть). o.env: переменные окружения; o.projectDir: CLAUDE_PROJECT_DIR (режим Claude Code).
function runHook(name, input, o) {
  o = o || {};
  return new Promise((resolve) => {
    const env = Object.assign({}, process.env, { WP_HOME: FAKE_HOME, WP_TMP_ZONES: ZONE }, o.env || {});
    for (const k of ['CLAUDE_PROJECT_DIR', 'CLAUDE_CODE_SESSION_ATTENDED', 'CODEX_NONINTERACTIVE']) delete env[k];
    if (o.env) for (const [k, v] of Object.entries(o.env)) { if (v === null) delete env[k]; else env[k] = v; }
    if (o.projectDir) env.CLAUDE_PROJECT_DIR = o.projectDir;
    if (o.path) env.PATH = o.path + path.delimiter + (process.env.PATH || process.env.Path || '');
    const child = cp.spawn(process.execPath, [path.join(HOOKS, name + '.js')], { cwd: o.cwd || TMP, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { try { child.kill(); } catch (_) { /* уже завершён */ } }, 20000);
    child.on('close', (code) => {
      clearTimeout(timer);
      let json = null;
      try { json = out.trim() ? JSON.parse(out) : null; } catch (_) { json = null; }
      resolve({ code, out, err, json });
    });
    child.stdin.on('error', () => { /* хук мог закрыть stdin раньше */ });
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}

// ---------- описание проверок ----------
// expect: 'silent' (код 0, пусто) | 'deny' | 'context'. has/hasNot: строки или массив строк в тексте причины или контекста.
const arr = (x) => (x === undefined ? [] : Array.isArray(x) ? x : [x]);
function reasonOf(r) { const h = r.json && r.json.hookSpecificOutput; return h ? String(h.permissionDecisionReason || h.additionalContext || '') : ''; }

function judge(c, r) {
  const problems = [];
  if (r.code !== 0) problems.push('код выхода ' + r.code + ', ожидался 0' + (r.err ? ' (stderr: ' + r.err.slice(0, 200) + ')' : ''));
  const h = r.json && r.json.hookSpecificOutput;
  const text = reasonOf(r);
  if (c.expect === 'silent') { if (r.out.trim()) problems.push('ожидалось молчание, а хук ответил: ' + r.out.slice(0, 160)); }
  else if (c.expect === 'deny') {
    if (!h || h.permissionDecision !== 'deny') problems.push('ожидался deny, ответ: ' + (r.out.trim().slice(0, 160) || '(пусто)'));
  } else if (c.expect === 'context') {
    if (!h || !h.additionalContext) problems.push('ожидался additionalContext, ответ: ' + (r.out.trim().slice(0, 160) || '(пусто)'));
  }
  for (const s of arr(c.has)) if (!text.includes(s)) problems.push('в ответе нет «' + s + '»');
  for (const s of arr(c.hasNot)) if (r.out.includes(s)) problems.push('в ответе не должно быть «' + s + '»');
  if (r.out.length > 10000) problems.push('ответ длиннее 10 000 символов (' + r.out.length + ')');
  return problems;
}

// Пул параллельных запусков: ограничение по числу процессов.
async function pool(tasks, n) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() { for (;;) { const i = next++; if (i >= tasks.length) return; results[i] = await tasks[i](); } }
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, worker));
  return results;
}

// cases: [{ name, hook?, input, expect, has?, hasNot?, opts? | make?: () => opts }]
async function runCases(hook, cases) {
  const tasks = cases.map((c) => async () => {
    let problems;
    try {
      const o = c.make ? c.make() : (c.opts || {});
      const r = await runHook(c.hook || hook, typeof c.input === 'function' ? c.input(o) : c.input, o);
      problems = judge(c, r);
      if (c.after) { const extra = await c.after(o, r); if (extra) problems.push(extra); }
    } catch (e) { problems = ['исключение теста: ' + e.message]; }
    return { name: c.name, ok: problems.length === 0, problems };
  });
  return pool(tasks, 6);
}

// ---------- построители входа ----------
const bash = (command, extra) => Object.assign({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }, extra || {});
const tool = (tool_name, tool_input, extra) => Object.assign({ hook_event_name: 'PreToolUse', tool_name, tool_input }, extra || {});
const write = (file_path, content) => tool('Write', { file_path, content });

function cleanup() { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* не критично */ } }

module.exports = { HOOKS, TMP, FAKE_HOME, ZONE, defaultsConfig, makeRoot, makeBare, makeClaudeStub, runHook, runCases, judge, bash, tool, write, cleanup };
