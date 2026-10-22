#!/usr/bin/env node
'use strict';
// ЖИВОЙ прогон проверяющего (M8, G6): настоящий Codex или настоящий Claude Code проверяет вымышленные данные. РУЧНОЙ запуск, в tests/run-all.js не входит.
//   node tests/live/real-reviewer.js --reviewer codex|claude [--model <имя>] [--timeout 540] [--keep] --yes
// Тратит лимит подписки проверяющего: ровно 2 запуска (верная копия и копия с вшитой ошибкой). Платных ключей не использует: ключи API убираются из окружения проверяющего.
// Что делает: во временной папке (init настоящим wp.js) задаёт направление (проверяет codex: основной claude; проверяет claude: основной codex), запускает selftest-run.js
// (prepare-check, run-check, finalize-check) и проверяет итог:
//   верная копия принята как GREEN или YELLOW  -> нужный исход;
//   копия с ошибкой принята как RED, в находках названы Бета и 4,0  -> нужный исход; иначе RED самой проверки.
// Это единственное, что доказывает форму запуска проверяющего (флаги, stdin, режим «только чтение», вход по подписке): заглушки проверяют проводку, а не способность проверяющего.
// Код выхода: 0 обе проверки приняты и verify P3.selftest ok; 1 нет; 2 не запущено (нет --yes, нет программы проверяющего).
// Хеши ~/.claude/settings.json, ~/.codex/config.toml и ~/.codex/hooks.json до и после печатаются: они не должны меняться (auth.json Codex меняется при каждом использовании: это штатно).
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');

const KIT = path.resolve(__dirname, '..', '..');
const WP = path.join(KIT, 'core', 'cli', 'wp.js');
const argv = process.argv.slice(2);
const opt = { reviewer: null, model: null, timeout: '540', keep: false, yes: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--reviewer') opt.reviewer = argv[++i];
  else if (a === '--model') opt.model = argv[++i];
  else if (a === '--timeout') opt.timeout = argv[++i];
  else if (a === '--keep') opt.keep = true;
  else if (a === '--yes') opt.yes = true;
  else { console.error('Неизвестный параметр ' + a); process.exit(2); }
}
if (!['codex', 'claude'].includes(opt.reviewer)) { console.error('Нужен --reviewer codex|claude. Пример: node tests/live/real-reviewer.js --reviewer claude --model haiku --yes'); process.exit(2); }
if (!opt.yes) {
  console.log('Это живой прогон: проверяющий ' + opt.reviewer + ' будет запущен 2 раза и потратит лимит подписки. Платные ключи не используются.');
  console.log('Повтори с --yes, если согласен.');
  process.exit(2);
}
const main = opt.reviewer === 'codex' ? 'claude' : 'codex';

const sha = (p) => { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch (_) { return null; } };
const home = os.homedir();
const WATCH = [path.join(home, '.claude', 'settings.json'), path.join(home, '.codex', 'config.toml'), path.join(home, '.codex', 'hooks.json')];
const before = WATCH.map(sha);

const env = Object.assign({}, process.env);
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'WP_HOME', 'CODEX_HOME', 'CLAUDE_PROJECT_DIR', 'WP_NET_PROBE']) delete env[k];
const run = (args, o) => cp.spawnSync(process.execPath, args, Object.assign({ encoding: 'utf8', env, timeout: (parseInt(opt.timeout, 10) + 120) * 1000 * 2, maxBuffer: 64 * 1024 * 1024 }, o || {}));
const out = (r) => String(r.stdout || '') + String(r.stderr || '');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-live-'));
const root = path.join(tmp, 'live-root');
let exit = 1;
try {
  // версия и наличие программы проверяющего (по PATH, без запуска оболочки с профилями)
  const rec = run([WP, 'recon', '--json', '--no-scan']);
  const rj = JSON.parse(rec.stdout);
  if (!rj[opt.reviewer].console) { console.error('Консольной команды ' + opt.reviewer + ' нет: проверять нечем. Поставь её (wp.js plan покажет как).'); process.exit(2); }
  console.log('Проверяющий: ' + opt.reviewer + ' ' + rj[opt.reviewer].primary.version + ', основной: ' + main + (opt.model ? ', модель ' + opt.model : ', модель по умолчанию') + '. ОС: ' + rj.os.name + ' ' + rj.os.version + ', Node ' + process.version + '.');
  let r = run([WP, 'init', '--root', root, '--main', main, '--no-scan'], { cwd: tmp });
  if (r.status !== 0) { console.log(out(r)); throw new Error('init не удался'); }
  const wp = (args) => run([path.join(root, '.workplace', 'core', 'cli', 'wp.js'), ...args], { cwd: root });
  r = wp(['layout']); if (r.status !== 0) { console.log(out(r)); throw new Error('layout не удался'); }
  if (opt.model) { r = wp(['config', 'set', 'reviewer_model', opt.model]); if (r.status !== 0) { console.log(out(r)); throw new Error('config set reviewer_model не удался'); } }
  const t0 = Date.now();
  r = run([path.join(root, '.workplace', 'core', 'skills', 'cross-check', 'scripts', 'selftest-run.js'), '--timeout', opt.timeout], { cwd: root });
  const sec = Math.round((Date.now() - t0) / 1000);
  console.log(out(r).trim());
  console.log('--- итог живого прогона (' + sec + ' с на оба запуска) ---');
  for (const d of fs.existsSync(path.join(root, 'checks')) ? fs.readdirSync(path.join(root, 'checks')).sort() : []) {
    const dir = path.join(root, 'checks', d);
    const m = fs.existsSync(path.join(dir, 'manifest.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) : {};
    const rn = fs.existsSync(path.join(dir, 'run.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8')) : {};
    const v = fs.existsSync(path.join(dir, 'verdict.md')) ? fs.readFileSync(path.join(dir, 'verdict.md'), 'utf8') : '';
    console.log(d + ': статус ' + m.status + ', вердикт ' + m.verdict + ', проверял ' + rn.provider + ', код выхода ' + rn.exit_code + ', ' + rn.seconds + ' с, verdict.md ' + rn.verdict_bytes + ' байт');
    const first = v.split(/\r?\n/).filter((l) => l.trim()).slice(0, 12).join('\n    ');
    if (first) console.log('    ' + first);
  }
  const v = wp(['verify', 'P3.selftest']);
  console.log(out(v).trim());
  exit = r.status === 0 && v.status === 0 ? 0 : 1;
  console.log(exit === 0 ? 'ЖИВОЙ ПРОГОН: GREEN на верной копии (или YELLOW), RED с названной ошибкой на неверной. Проверяющий ' + opt.reviewer + ' годен.' : 'ЖИВОЙ ПРОГОН: НЕ ПРОЙДЕН. Смотри вывод выше и checks/*/review.log' + (opt.keep ? '' : ' (папка удаляется; повтори с --keep)') + '.');
} catch (e) {
  console.error('Живой прогон прерван: ' + e.message);
  exit = 1;
} finally {
  const after = WATCH.map(sha);
  console.log('Личные файлы (sha256 до и после): ' + WATCH.map((p, i) => path.basename(p) + ' ' + (before[i] === after[i] ? 'не изменён' : 'ИЗМЕНЁН') + (before[i] ? ' ' + before[i].slice(0, 12) : ' (нет файла)')).join('; '));
  if (opt.keep) console.log('Временная папка оставлена: ' + root);
  else { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* временная папка */ } }
}
process.exit(exit);
