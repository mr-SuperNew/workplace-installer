'use strict';
// Общие функции навыка cross-check. Только встроенные модули Node.
// Ядро (core/lib, core/providers) подключается так: скрипт лежит в <...>/skills/cross-check/scripts/ и в пакете, и в .workplace/core/skills/,
// и в .claude/skills/, и в .agents/skills/ (одинаково для обоих ИИ).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function findCore() {
  const cands = [
    path.resolve(__dirname, '..', '..', '..'),                                    // <...>/core/skills/cross-check/scripts: пакет или .workplace/core
    path.resolve(__dirname, '..', '..', '..', '..', '.workplace', 'core'),        // <корень>/.claude|.agents/skills/cross-check/scripts
  ];
  for (const c of cands) if (fs.existsSync(path.join(c, 'lib', 'root.js'))) return c;
  return null;
}
const CORE = findCore();
if (!CORE) { process.stderr.write('Не найдено ядро (.workplace/core). Скрипт запускают из главной папки: node .workplace/core/skills/cross-check/scripts/<скрипт>.js. Ничего не записано.\n'); process.exit(1); }
const rootLib = require(path.join(CORE, 'lib', 'root.js'));
const configLib = require(path.join(CORE, 'lib', 'config.js'));
const secrets = require(path.join(CORE, 'lib', 'secrets-scan.js'));
const mask = require(path.join(CORE, 'lib', 'mask.js'));
const providers = require(path.join(CORE, 'providers'));
const runproof = require(path.join(CORE, 'lib', 'runproof.js'));

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function sha256File(file) { return sha256(fs.readFileSync(file)); }

// Корень определяется ТОЛЬКО расположением самих скриптов (поиск вверх по метке .workplace/): ни параметр --root, ни текущая папка корня не задают.
// Раньше (v3) достаточно было чужой папки с поддельной меткой, чтобы скрипты писали в неё. checks/ обязана быть настоящей папкой, не ссылкой.
function resolveRoot() {
  const root = rootLib.findRoot(__dirname);
  if (!root) return { error: 'Скрипты проверки запускаются только из главной папки: node .workplace/core/skills/cross-check/scripts/<скрипт>.js (метка .workplace/ над скриптом не найдена). Ничего не записано.' };
  const checks = path.join(root, 'checks');
  let st; try { st = fs.lstatSync(checks); } catch (_) { st = null; }
  if (!st) { try { fs.mkdirSync(checks); } catch (e) { return { error: 'Не удалось создать checks/: ' + e.message }; } st = fs.lstatSync(checks); }
  if (!st.isDirectory() || st.isSymbolicLink()) return { error: 'checks/ в корне должна быть настоящей папкой, а не ссылкой.' };
  return { root };
}
// Направление и проверяющий из config.json (единственное место, где оно задано).
function loadConfig(root) {
  const cfg = configLib.load(root);
  if (cfg._missing) return { error: 'Нет .workplace/config.json: направление проверки неизвестно. Запусти установку (wp.js init) или создай config через wp.js config.' };
  if (cfg._invalid) return { error: 'config.json неверен: ' + cfg._invalid.join('; ') + '. Исправь: node .workplace/core/cli/wp.js config validate.' };
  return { cfg, reviewer: providers.get(cfg.reviewer), main: providers.get(cfg.main) };
}

// Строгий разбор параметров. Путей записи у скриптов нет: --root, --out, --json и любые неизвестные параметры отклоняются.
// spec: { bool: [...], value: [...], positional: сколько позиционных аргументов допустимо }
function parseArgs(argv, spec) {
  const args = {}, positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const k = a.slice(2);
    if (k.split('=')[0] === 'root') return { error: 'Параметр --root не принимается: корень определяется по расположению самих скриптов. Другой корень указать нельзя. Ничего не записано.' };
    if (spec.bool.includes(k)) args[k] = true;
    else if (spec.value.includes(k)) { if (i + 1 >= argv.length) return { error: 'У параметра --' + k + ' нет значения.' }; args[k] = argv[++i]; }
    else return { error: 'Неизвестный параметр ' + a + '. Путей записи у скриптов проверки нет: они пишут только в <корень>/checks/<имя>. Ничего не записано.' };
  }
  if (positional.length > spec.positional) return { error: 'Лишний аргумент: ' + positional[spec.positional] + '. Ничего не записано.' };
  return { args, positional };
}
const sameFs = (a, b) => (process.platform === 'win32' || process.platform === 'darwin' ? a.toLowerCase() === b.toLowerCase() : a === b);
// Папка проверки: только настоящий дочерний путь <корень>/checks/<имя>. Запрещены абсолютные пути, «..», ссылки и junction.
const CHECK_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/;
const WIN_RESERVED_RE = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
function resolveCheckDir(root, target) {
  const t = String(target || '');
  if (!t || t.includes(String.fromCharCode(0))) return { error: 'Не указана папка проверки: node run-check.js checks/<имя>' };
  if (path.isAbsolute(t) || path.win32.isAbsolute(t) || path.posix.isAbsolute(t) || /^[A-Za-z]:/.test(t) || t.startsWith('~')) return { error: 'Абсолютные пути не принимаются: укажи checks/<имя>.' };
  const parts = t.split(/[\\/]+/).filter((x) => x !== '');
  while (parts[0] === '.') parts.shift();
  if (parts.some((x) => x === '..' || x === '.')) return { error: 'Путь с «..» не принимается: укажи checks/<имя>.' };
  if (parts.length !== 2 || parts[0] !== 'checks' || !CHECK_NAME_RE.test(parts[1]) || /\.$/.test(parts[1]) || WIN_RESERVED_RE.test(parts[1])) return { error: 'Допустим только путь вида checks/<имя> внутри главной папки (буквы, цифры, точка, дефис).' };
  const dir = path.join(root, 'checks', parts[1]);
  let st; try { st = fs.lstatSync(dir); } catch (_) { st = null; }
  if (!st) return { error: 'Нет папки ' + parts.join('/') + ': сначала prepare-check.js' };
  if (st.isSymbolicLink() || !st.isDirectory()) return { error: parts.join('/') + ' должна быть настоящей папкой, не ссылкой.' };
  let real, realRoot;
  try { real = fs.realpathSync(dir); realRoot = fs.realpathSync(root); } catch (e) { return { error: 'Не удалось проверить путь: ' + e.message }; }
  if (!sameFs(real, path.join(realRoot, 'checks', parts[1]))) return { error: 'Папка проверки ведёт за пределы checks/ (ссылка или junction): запись отменена.' };
  return { dir };
}
// Файлы внутри папки проверки, в которые скрипт пишет или из которых копирует: ссылкой быть не должны.
function linkedEntries(dir, names) {
  return names.filter((n) => { try { return fs.lstatSync(path.join(dir, n)).isSymbolicLink(); } catch (_) { return false; } });
}
// Путь из manifest.json должен остаться внутри папки base (защита от «../»).
function insideDir(base, rel) {
  const abs = path.resolve(base, String(rel));
  const r = path.relative(base, abs);
  return !!r && !r.startsWith('..') && !path.isAbsolute(r);
}
function toPosix(p) { return p.split(path.sep).join('/'); }

// ---------- какие файлы можно передавать ----------
const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.h', '.cpp', '.hpp',
  '.cs', '.php', '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd', '.lua', '.r', '.sql', '.vue', '.svelte', '.css', '.scss']);
const DOC_EXT = new Set(['.md', '.markdown', '.txt', '.csv', '.tsv', '.json', '.jsonl', '.html', '.htm', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.xml', '.rst', '.tex']);
const NAMED_TEXT = new Set(['dockerfile', 'makefile', '.gitignore', '.editorconfig', 'readme', 'license']);
const BINARY_RE = /^\.(xls[xmb]?|docx?|pptx?|pdf|png|jpe?g|gif|webp|zip|gz|tar|7z|mp[34]|mov|wav|exe|dll|dylib|so|db|sqlite)$/i;

function isTextBuffer(buf) {
  if (buf.includes(0)) return false;
  try { new TextDecoder('utf-8', { fatal: true }).decode(buf); return true; } catch (_) { return false; }
}

// ---------- цитаты ----------
function norm(s) { return String(s).replace(/\s+/g, ' ').trim(); }

// Все цитаты из текста: «...», "...", “...”, `...`, длиной от 4 символов.
function extractQuotes(text) {
  const res = [];
  const re = /«([^»]{4,})»|"([^"]{4,})"|“([^”]{4,})”|`([^`]{4,})`/g;
  let m;
  while ((m = re.exec(text)) !== null) res.push(norm(m[1] || m[2] || m[3] || m[4]));
  return res;
}

// Раздел «Прочитано» из вердикта: от строки с этим словом до следующего заголовка раздела.
function readSection(verdict) {
  const lines = verdict.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) if (/^[\s#*_>-]*Прочитано(?![а-яёА-ЯЁ\w])/i.test(lines[i])) { start = i; break; }
  if (start < 0) return null;
  const out = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^[\s#*_>-]*(Находки|Подтверждено|Не проверено)(?![а-яёА-ЯЁ\w])/i.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join('\n');
}

module.exports = {
  CORE, rootLib, providers, runproof, resolveRoot, loadConfig, sha256, sha256File, parseArgs, resolveCheckDir, linkedEntries, insideDir, toPosix, norm, extractQuotes, readSection,
  maskText: mask.maskText, scanSecrets: secrets.scanSecrets, isSecretName: secrets.isSecretName,
  CODE_EXT, DOC_EXT, NAMED_TEXT, BINARY_RE, isTextBuffer,
};
