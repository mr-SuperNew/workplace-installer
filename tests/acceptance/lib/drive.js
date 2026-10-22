'use strict';
// Запуск проверяемого ИИ в песочнице: один ход = один вызов claude -p или codex exec. Второй ход продолжает тот же разговор.
// Чистое окружение: Claude с --setting-sources project,local (личные настройки не грузятся) и сторожем стенда; Codex с --ignore-user-config и --ignore-rules.
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { childEnv, posix } = require('./sandbox');

const IS_WIN = process.platform === 'win32';
const q = (a) => (a === '' ? '""' : /[\s"&|<>^()%!]/.test(a) ? '"' + String(a).replace(/"/g, '\\"') + '"' : String(a));

// Асинхронный запуск с таймаутом: по таймауту убивается дерево именно этого процесса (по PID).
function runProc(cmd, args, o) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const viaShell = IS_WIN && /\.(cmd|bat)$/i.test(cmd);
    const c = viaShell
      ? cp.spawn([cmd, ...args].map(q).join(' '), { cwd: o.cwd, env: o.env, shell: true, windowsHide: true })
      : cp.spawn(cmd, args, { cwd: o.cwd, env: o.env, windowsHide: true });
    let out = '', err = '', timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { cp.spawnSync(IS_WIN ? 'taskkill' : 'kill', IS_WIN ? ['/PID', String(c.pid), '/T', '/F'] : ['-9', String(c.pid)], { stdio: 'ignore' }); } catch (_) { /* уже завершён */ }
    }, o.timeoutMs || 180000);
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('error', (e) => { err += String(e); });
    c.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err, timedOut, ms: Date.now() - t0 }); });
    if (o.input != null) c.stdin.end(o.input); else c.stdin.end();
  });
}

function parseClaude(stdout) {
  const ev = [];
  for (const l of stdout.split(/\r?\n/)) { if (!l.trim().startsWith('{')) continue; try { ev.push(JSON.parse(l)); } catch (_) { /* не JSON */ } }
  const texts = [], tools = [];
  let result = null;
  for (const e of ev) {
    if (e.type === 'assistant' && e.message && Array.isArray(e.message.content)) {
      for (const b of e.message.content) {
        if (b.type === 'text' && b.text) texts.push(b.text);
        if (b.type === 'tool_use') tools.push({ id: b.id, name: b.name, input: b.input, result: null });
      }
    }
    if (e.type === 'user' && e.message && Array.isArray(e.message.content)) {
      for (const b of e.message.content) if (b.type === 'tool_result') {
        const t = tools.find((x) => x.id === b.tool_use_id);
        if (t) t.result = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
      }
    }
    if (e.type === 'result') result = e;
  }
  // ответ = всё, что человек видит за ход (все текстовые сообщения по порядку), а не только последнее
  const last = result && typeof result.result === 'string' && result.result ? result.result : texts[texts.length - 1] || '';
  const SEP = '\n\n';
  const answer = texts.length > 1 ? (texts.includes(last) ? texts.join(SEP) : texts.join(SEP) + SEP + last) : last;
  return { answer, last, texts, tools, turns: result ? result.num_turns : null, subtype: result ? result.subtype : null, isError: result ? !!result.is_error : null };
}

function parseCodex(stdout, lastMsgFile) {
  const tools = [], texts = [];
  for (const l of stdout.split(/\r?\n/)) {
    if (!l.trim().startsWith('{')) continue;
    let e; try { e = JSON.parse(l); } catch (_) { continue; }
    const it = e.item || e.msg || null;
    if (!it) continue;
    if ((it.type === 'agent_message' || it.type === 'message') && (it.text || it.message)) texts.push(it.text || it.message);
    if (it.type === 'command_execution' && e.type === 'item.completed') tools.push({ name: 'shell', input: { command: it.command }, result: String(it.aggregated_output || ''), exit: it.exit_code });
    if (it.type === 'file_change' && e.type === 'item.completed') tools.push({ name: 'file_change', input: { command: JSON.stringify(it.changes || it) }, result: it.status });
  }
  let answer = '';
  try { answer = fs.readFileSync(lastMsgFile, 'utf8').trim(); } catch (_) { /* нет файла */ }
  const last = answer || texts[texts.length - 1] || '';
  if (texts.length > 1) answer = texts.join('\n\n'); else if (!answer) answer = last;
  return { answer, last, texts, tools, turns: null, subtype: null, isError: null };
}

// opts: { prompt, cont (второй ход), timeoutMs, maxTurns, model, tag }
async function turn(sb, opts) {
  const env = childEnv(sb);
  const tag = opts.tag || (opts.cont ? 't2' : 't1');
  fs.mkdirSync(sb.out, { recursive: true });
  if (sb.main === 'claude' && !opts.forceCodex) {
    const args = ['-p', '--model', opts.model || 'haiku', '--setting-sources', 'project,local', '--settings', sb.standSettings,
      '--permission-mode', 'bypassPermissions', '--add-dir', sb.home, '--max-turns', String(opts.maxTurns || 10),
      '--output-format', 'stream-json', '--verbose'];
    if (opts.cont) args.push('--continue');
    const r = await runProc(sb.real.claude, args, { cwd: sb.mainDir, env, input: opts.prompt, timeoutMs: opts.timeoutMs || 180000 });
    fs.writeFileSync(path.join(sb.out, tag + '.raw.jsonl'), r.out);
    fs.writeFileSync(path.join(sb.out, tag + '.stderr.txt'), r.err);
    const p = parseClaude(r.out);
    return Object.assign(p, { provider: 'claude', prompt: opts.prompt, code: r.code, timedOut: r.timedOut, ms: r.ms, stderr: r.err });
  }
  const last = path.join(sb.out, tag + '.last.txt');
  // Песочница Codex на Windows не пускает запись в домашнюю папку (её же и подменяет стенд), а подтверждений человека в exec нет: Codex идёт без своей песочницы.
  // От настоящей машины защищают фейковый дом, прокладки установщиков в PATH и гейт до/после (включая PATH пользователя в реестре). Хук-сторожа стенда у Codex нет:
  // хуки из CODEX_HOME в этой версии не сработали (проверено), поэтому просьбы 4 и 5 (установка и обновление) для Codex не прогоняются.
  const common = ['--ignore-rules', '--skip-git-repo-check', '--dangerously-bypass-hook-trust', '--dangerously-bypass-approvals-and-sandbox', '--json', '-o', last];
  const args = opts.cont ? ['exec', 'resume', '--last', ...common, '-'] : ['exec', '-C', sb.mainDir, ...common, '-'];
  const r = await runProc(sb.real.codex, args, { cwd: sb.mainDir, env, input: opts.prompt, timeoutMs: opts.timeoutMs || 180000 });
  fs.writeFileSync(path.join(sb.out, tag + '.raw.jsonl'), r.out);
  fs.writeFileSync(path.join(sb.out, tag + '.stderr.txt'), r.err);
  const p = parseCodex(r.out, last);
  return Object.assign(p, { provider: 'codex', prompt: opts.prompt, code: r.code, timedOut: r.timedOut, ms: r.ms, stderr: r.err });
}

module.exports = { turn, runProc };
