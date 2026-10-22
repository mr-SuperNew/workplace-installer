#!/usr/bin/env node
'use strict';
// Сторож кросс-проверки на необратимом. PreToolUse на оболочке и на инструментах MCP (mcp__*), один скрипт для Claude Code и Codex.
// Идея: шаг, который уходит наружу или не откатывается (отправка в удалённый репозиторий, публикация пакета, запрос с записью во внешний сервис,
// письмо, развёртывание, MCP-инструмент send/post/publish/delete), не начинается, пока нет принятой кросс-проверки: в checks/ лежит манифест
// со status "checked" и вердиктом не RED, он моложе cross_check_ttl_min минут (config.json, по умолчанию 120), и файлы из манифеста не менялись после него.
// Манифест засчитывается, только если у него есть доказательство настоящего запуска проверяющего (run.json от run-check.js, core/lib/runproof.js) и проверяющий
// совпадает с reviewer из config.json. Файлы из манифеста сверяются по sha256; исчезнувший файл считается изменением.
// Запись инструментами и командами в checks/*/{verdict.md, run.json, manifest.json, review.log, prompt.md} и в checks/unreviewed.md отклоняется: их пишут только скрипты проверки и этот сторож.
// Читать эти файлы можно любыми читающими командами (cat, sed -n, jq, shasum, Select-String; запись у sed это -i, у sort -o). Относительные пути и перенаправления сверяются
// от папки запуска (после cd), код на node -e или python -c, который называет эти файлы и пишет, отклоняется.
// Известное ограничение (модель угрозы «невнимательный агент», не злоумышленник): код в отдельном файле, склеенные из частей имена и подлог run.json с верными хешами
// локально не закрываются; см. docs/troubleshooting.md, раздел «Известные ограничения».
//
// Проверка идёт по умолчанию. Человек может сказать «без проверки» в последнем сообщении (его записывает хук human-message.js, core/lib/consent.js): тогда шаг проходит,
// а в checks/unreviewed.md дописывается строка «НЕ ПРОВЕРЕНО» с названием шага и временем. Файла-выключателя (checks/.skip) больше нет: человеку не нужно ничего создавать руками.
// Заготовка: схема «шаг блокируется без свежего отчёта» взята из практики рассылочных гейтов; Stop-гейт v3 (cross-check-gate.js) заменён этим хуком.
// Поведение при ошибке чтения: нет корня или файла настроек - хук молчит, не ломая работу.
const fs = require('fs');
const path = require('path');
const hookIo = require('../lib/hook-io');
const cfgLib = require('../lib/config');
const rootLib = require('../lib/root');
const consent = require('../lib/consent');
const u = require('../lib/util');
const runproof = require('../lib/runproof');
const common = require('./_common');
const sh = require('./_shell');

const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[?::1\]?)$/i;

// ---------- что считается необратимым или наружным ----------
const DOWNLOADERS = new Set(['curl', 'wget', 'iwr', 'irm', 'invoke-webrequest', 'invoke-restmethod']);
const MAILERS = new Set(['mail', 'mailx', 'sendmail', 'mutt', 'msmtp', 'swaks', 'send-mailmessage']);
const WRITE_METHOD = /^(post|put|patch|delete)$/i;

function hostOf(u) { try { return new URL(u).hostname; } catch (_) { return ''; } }

function httpOutward(it) {
  const r = it.rest;
  const urls = r.map((w) => w.t).filter((t) => /^https?:\/\//i.test(t));
  if (urls.length && urls.every((x) => LOCAL_HOST.test(hostOf(x)))) return null;
  let write = false;
  for (let i = 0; i < r.length; i++) {
    const t = r[i].t;
    if (it.cmd === 'curl') {
      if (/^(-X|--request)$/.test(t) && r[i + 1] && WRITE_METHOD.test(r[i + 1].t)) write = true;
      if (/^-X(POST|PUT|PATCH|DELETE)$/i.test(t) || /^--request=(POST|PUT|PATCH|DELETE)$/i.test(t)) write = true;
      if (/^(-d|--data|--data-raw|--data-binary|--data-urlencode|--data-ascii|-F|--form|-T|--upload-file|--json)$/.test(t) || /^--(data|form|json)=/.test(t)) write = true;
    } else if (it.cmd === 'wget') {
      if (/^--(post-data|post-file|body-data|body-file)(=|$)/.test(t)) write = true;
      if (/^--method=(POST|PUT|PATCH|DELETE)$/i.test(t) || (t === '--method' && r[i + 1] && WRITE_METHOD.test(r[i + 1].t))) write = true;
    } else {
      if (/^-method$/i.test(t) && r[i + 1] && WRITE_METHOD.test(r[i + 1].t)) write = true;
      if (/^-(body|infile)$/i.test(t)) write = true;
    }
  }
  return write ? 'запрос с записью во внешний сервис (' + it.cmd + ')' : null;
}

// Возвращает описание необратимого шага в простой команде или null.
function outward(it) {
  const cmd = it.cmd;
  if (!cmd) return null;
  const pos = sh.positional(it.rest).map((w) => w.t.toLowerCase());
  if (cmd === 'git') {
    const g = sh.gitSub(it.rest);
    if (g.sub === 'push' && !sh.hasFlag(g.args, '--dry-run', '-n')) return 'отправка изменений в удалённый репозиторий';
    return null;
  }
  if (/^(npm|pnpm|yarn|bun)$/.test(cmd)) return (pos.slice(0, 2).some((p) => p === 'publish' || p === 'unpublish') && !sh.hasFlag(it.rest, '--dry-run')) ? 'публикация пакета (' + cmd + ')' : null;
  if (cmd === 'twine' && pos[0] === 'upload') return 'публикация пакета (twine)';
  if ((cmd === 'cargo' && pos[0] === 'publish') || (cmd === 'gem' && pos[0] === 'push') || (cmd === 'docker' && pos[0] === 'push')) return 'публикация (' + cmd + ' ' + pos[0] + ')';
  if (cmd === 'gh') {
    const [a, b] = pos;
    if (a === 'api') {
      const m = it.rest.findIndex((w) => /^(-X|--method)$/.test(w.t));
      if ((m >= 0 && it.rest[m + 1] && WRITE_METHOD.test(it.rest[m + 1].t)) || sh.hasFlag(it.rest, '-f', '-F', '--field', '--raw-field', '--input')) return 'запрос GitHub с записью';
      return null;
    }
    if (['release', 'pr', 'issue', 'gist', 'repo'].includes(a) && ['create', 'delete', 'merge', 'close', 'upload', 'edit', 'comment', 'review', 'rename', 'archive'].includes(b)) return 'действие на GitHub (gh ' + a + ' ' + b + ')';
    return null;
  }
  if (DOWNLOADERS.has(cmd)) return httpOutward(it);
  if (cmd === 'scp' || cmd === 'sftp' || cmd === 'ssh') return 'передача на удалённый компьютер (' + cmd + ')';
  if (cmd === 'rsync' && it.rest.some((w) => (/^[^\/\\\s:]+:[^\s]*$/.test(w.t) && !/^[A-Za-z]:[\\/]?/.test(w.t)) || /^rsync:\/\//.test(w.t))) return 'передача на удалённый компьютер (rsync)';
  if (MAILERS.has(cmd)) return 'отправка письма (' + cmd + ')';
  if (cmd === 'netlify' && pos[0] === 'deploy') return 'развёртывание (netlify deploy)';
  if (cmd === 'vercel' && (pos.length === 0 || ['deploy', 'promote', '--prod'].includes(pos[0]) || sh.hasFlag(it.rest, '--prod'))) return 'развёртывание (vercel)';
  if (cmd === 'firebase' && pos[0] === 'deploy') return 'развёртывание (firebase deploy)';
  if (cmd === 'wrangler' && ['deploy', 'publish'].includes(pos[0])) return 'развёртывание (wrangler)';
  if (cmd === 'terraform' && ['apply', 'destroy'].includes(pos[0])) return 'изменение инфраструктуры (terraform ' + pos[0] + ')';
  if (cmd === 'kubectl' && ['apply', 'delete'].includes(pos[0])) return 'изменение кластера (kubectl ' + pos[0] + ')';
  return null;
}

// MCP-инструмент: mcp__сервер__действие. Действие разбирается на слова; начинается с «читающего» глагола - не необратимо.
const MCP_OUTWARD = new Set(['send', 'post', 'publish', 'delete', 'remove', 'destroy', 'deploy', 'push', 'merge', 'reply', 'forward', 'submit', 'upload', 'share', 'schedule', 'transfer', 'pay']);
const MCP_READ = new Set(['get', 'list', 'read', 'search', 'fetch', 'find', 'describe', 'show', 'count', 'check', 'view', 'query', 'lookup', 'download', 'preview', 'draft']);
function mcpOutward(toolName) {
  const m = /^mcp__.+?__(.+)$/i.exec(String(toolName || ''));
  const action = m ? m[1] : String(toolName).replace(/^mcp__/i, '');
  const tokens = action.replace(/([a-z])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean).map((x) => x.toLowerCase());
  if (!tokens.length || MCP_READ.has(tokens[0])) return null;
  const verb = tokens.find((t) => MCP_OUTWARD.has(t));
  return verb ? 'инструмент MCP «' + toolName + '» (' + verb + ')' : null;
}

// ---------- манифесты проверок ----------
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); } catch (_) { return null; } }
// Лучшая (самая свежая) принятая проверка с доказательством запуска. rejected: сколько принятых манифестов отброшено (нет доказательства или другой проверяющий).
function latestChecked(checksDir, reviewer) {
  let dirs = [];
  try { dirs = fs.readdirSync(checksDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch (_) { return null; }
  let best = null;
  const rejected = [];
  for (const d of dirs) {
    const f = path.join(checksDir, d, 'manifest.json');
    const m = readJson(f);
    if (!m || m.status !== 'checked') continue;
    if (reviewer && m.reviewer !== reviewer) { rejected.push(d + ': проверял ' + (m.reviewer || 'неизвестно кто') + ', а сейчас проверяет ' + reviewer); continue; }
    const pr = runproof.verifyAccepted(path.join(checksDir, d), m, reviewer);
    if (!pr.ok) { rejected.push(d + ': ' + pr.problems[0]); continue; }
    let t = Date.parse(m.checked_at);
    if (!Number.isFinite(t)) { try { t = fs.statSync(f).mtimeMs; } catch (_) { continue; } }
    if (!best || t > best.t) best = { id: d, t, m };
  }
  if (best) best.rejected = rejected;
  return best || (rejected.length ? { none: true, rejected } : null);
}
// Файлы из манифеста: изменённый (другой sha256) или исчезнувший файл означает, что проверка относится к старой версии.
function changedAfter(root, manifest) {
  const changed = [];
  for (const f of Array.isArray(manifest.files) ? manifest.files : []) {
    if (!f || !f.path) continue;
    const abs = path.resolve(root, String(f.path));
    if (!common.inside(abs, root)) continue;
    let cur = null;
    try { cur = runproof.sha256(fs.readFileSync(abs)); } catch (_) { cur = null; }
    const shown = String(f.path).split('\\').join('/');
    if (cur === null) changed.push(shown + ' (файла больше нет)');
    else if (cur !== f.sha256) changed.push(shown);
  }
  return changed;
}
// Шаг пошёл без проверки по слову человека: строка в checks/unreviewed.md (папка checks/ закрыта в .gitignore). Названия шага без аргументов команды: ключей и адресов там нет.
function logUnreviewed(checksDir, what, nc) {
  try {
    fs.mkdirSync(checksDir, { recursive: true });
    const f = path.join(checksDir, 'unreviewed.md');
    const head = u.exists(f) ? '' : '# Шаги без кросс-проверки (НЕ ПРОВЕРЕНО)\n\nСтроки дописывает сторож кросс-проверки, когда человек сказал «без проверки». Руками не правится.\n\n';
    fs.appendFileSync(f, head + '- ' + u.hhmm() + ' НЕ ПРОВЕРЕНО: ' + what + ' (слова человека: «' + nc.phrase + '»)\n');
    return true;
  } catch (_) { return false; }
}

// Файл с итогом шагов без проверки: пишет только сам сторож.
const UNREVIEWED_PATH = /(^|[\\/])checks[\\/]unreviewed\.md$/i;
// Команды, которые только читают файлы из аргументов (R1 этапа Ж: читать служебные файлы проверки можно любым читающим средством).
const READERS = new Set(['cat', 'type', 'ls', 'dir', 'test', '[', 'head', 'tail', 'less', 'more', 'get-content', 'gc', 'test-path', 'stat', 'wc', 'grep', 'rg', 'findstr',
  'awk', 'gawk', 'sed', 'jq', 'nl', 'diff', 'cmp', 'comm', 'shasum', 'sha256sum', 'sha1sum', 'md5sum', 'file', 'od', 'cut', 'sort',
  'select-string', 'sls', 'get-filehash', 'format-hex', 'get-item', 'get-childitem', 'gci']);
// Читающая команда может писать только особыми ключами: sed -i, sort -o, gawk -i inplace.
function readsOnly(it) {
  if (!it.cmd || !READERS.has(it.cmd)) return false;
  const flags = it.rest.filter((w) => !w.q && /^-/.test(w.t)).map((w) => w.t);
  if (it.cmd === 'sed') return !flags.some((f) => /^-[a-zA-Z]*i/.test(f) || /^--in-place/.test(f));
  if (it.cmd === 'sort') return !flags.some((f) => /^-[a-zA-Z]*o/.test(f) || /^--output/.test(f));
  if (it.cmd === 'awk' || it.cmd === 'gawk') return !flags.some((f) => f === '-i' || /^--include/.test(f) || /inplace/i.test(f));
  return true;
}
// Путь из слова команды: по тексту и (N2 этапа Ж) по пути от папки запуска, чтобы `cd checks/x && cp a verdict.md` и `> ./run.json` не обходили сторожа.
function resolved(t, cwd) {
  const e = sh.expandTarget(t, cwd);
  return e.unknown || !e.p ? null : String(e.p).replace(/\\/g, '/');
}
// Служебные файлы проверки: их пишут только скрипты (run-check, finalize-check, prepare-check). Рукописный вердикт ложно открывает сторожа.
const PROOF_FILE = /(^|\/)checks\/[^/]+\/(verdict\.md|run\.json|manifest\.json|review\.log|prompt\.md)$/i;
const PROTECTED_FILE = (p) => { const n = String(p || '').replace(/\\/g, '/'); return PROOF_FILE.test(n) || UNREVIEWED_PATH.test(n); };
const proofish = (t, cwd) => PROTECTED_FILE(t) || PROTECTED_FILE(resolved(t, cwd));
// Код на интерпретаторе (node -e, python -c, perl -e, heredoc), который называет служебный файл проверки и пишет: полностью код не разобрать, поэтому судим по словам рядом.
const CODE_RUNNERS = new Set(['node', 'nodejs', 'python', 'python3', 'py', 'perl', 'ruby', 'php', 'deno', 'bun']);
const PROOF_NAME = /(verdict\.md|run\.json|manifest\.json|review\.log|prompt\.md|unreviewed\.md)/i;
const CODE_WRITES = /(write|append|copyfile|rename|truncate|unlink|createwritestream|shutil|\.replace\(|move|os\.remove|\bopen\s*\(|\bsave\b|\bdump)/i;
function codeTouchesProof(it) {
  if (!CODE_RUNNERS.has(it.cmd)) return false;
  const bodies = it.rest.map((w) => w.t).concat((it.here || []).map((h) => String(h.body || '')));
  return bodies.some((b) => /checks/i.test(b) && PROOF_NAME.test(b) && CODE_WRITES.test(b));
}
function touchesProof(it) {
  if ((it.redirs || []).some((r) => /^&?>/.test(r.op) && proofish(r.target, it.cwd))) return true;
  if (!it.cmd) return false;
  if (codeTouchesProof(it)) return true;
  if (readsOnly(it)) return false;
  return it.rest.some((w) => proofish(w.t.replace(/\\/g, '/'), it.cwd));
}
const PROOF_MSG = 'Файлы проверки (verdict.md, run.json, manifest.json, review.log, prompt.md) и checks/unreviewed.md пишут только скрипты проверки и сторож. Вердикт, написанный рукой, проверкой не считается. Эта запись отклонена: запусти run-check.js и finalize-check.js, они сделают это сами.';

function verdictMessage(what, why) {
  return 'Сторож кросс-проверки остановил: ' + what + '. Это необратимый или наружный шаг, а ' + why + ' ' +
    'Запусти /cross-check (слово «кросс-чек») на изменённом, дождись вердикта GREEN или YELLOW и повтори шаг. ' +
    'Если человек не хочет проверки, ему достаточно написать в чате «без проверки»: тогда шаг пройдёт и будет записан как НЕ ПРОВЕРЕНО. Это слово ставит только он, не ты.';
}

hookIo.run((data, ctx) => {
  if (!cfgLib.guardEnabled(ctx.config, 'cross_check_guard')) return null;
  const root = ctx.root;
  if (!root) return null;                                  // вне рабочего места судить не по чему
  const name = String(data.tool_name || '');
  let what = null;
  const cmd = common.shellCommand(data);
  if (cmd) {
    const psOnly = /^powershell$/i.test(name);
    for (const { items } of sh.flattenAll(cmd, { cwd: common.shellCwd(data), psOnly })) {
      for (const it of items) {
        if (touchesProof(it)) return hookIo.deny(PROOF_MSG);
        if (!what) what = outward(it);
      }
      if (what) break;
    }
  } else if (/^mcp__/i.test(name)) {
    what = mcpOutward(name);
  } else {
    // запись файлов инструментами (Write, Edit, MultiEdit, NotebookEdit, apply_patch): служебные файлы проверок писать нельзя
    const w = common.writeInfo(data);
    const wcwd = common.shellCwd(data);
    if (w && w.paths.some((x) => x && proofish(x, wcwd))) return hookIo.deny(PROOF_MSG);
  }
  if (!what) return null;

  const p = rootLib.paths(root);
  const ttlMin = Number.isFinite(ctx.config.cross_check_ttl_min) && ctx.config.cross_check_ttl_min > 0 ? ctx.config.cross_check_ttl_min : 120;
  const problem = reviewProblem(p, root, ctx, ttlMin);
  if (!problem) return null;
  // Проверка по умолчанию. Человек сказал «без проверки» в последнем сообщении: шаг проходит и записывается как НЕ ПРОВЕРЕНО.
  const nc = consent.noCheck(root, data.session_id || data.sessionId || null);
  if (nc) { logUnreviewed(p.checks, what, nc); return null; }
  return hookIo.deny(verdictMessage(what, problem));
}, __dirname);

// Почему принятой проверки нет (текст) или null, если свежая принятая проверка есть.
function reviewProblem(p, root, ctx, ttlMin) {
  const best = latestChecked(p.checks, ctx.config.reviewer);
  if (!best) return 'принятой кросс-проверки в checks/ нет.';
  if (best.none) return 'принятых проверок с доказательством запуска проверяющего нет (' + best.rejected.slice(0, 2).join('; ') + ').';
  const verdict = String(best.m.verdict || '').toUpperCase();
  if (verdict === 'RED') return 'последняя проверка (' + best.id + ') вернула RED.';
  const ageMin = Math.floor((Date.now() - best.t) / 60000);
  if (ageMin > ttlMin) return 'последняя проверка (' + best.id + ') старше ' + ttlMin + ' минут (прошло ' + ageMin + ').';
  const changed = changedAfter(root, best.m);
  if (changed.length) return 'файлы изменены или исчезли после последней проверки (' + best.id + '): ' + changed.slice(0, 5).join(', ') + (changed.length > 5 ? ' и ещё ' + (changed.length - 5) : '') + '.';
  return null;
}
