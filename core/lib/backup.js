'use strict';
// Копия файла перед правкой: `.workplace/backups/<метка>-<имя>`, список копий в `.workplace/backups/index.jsonl`.
// Нужна для записи вне главной папки (настройки VS Code, ~/.zshrc, файлы проекта человека) и для правок правил. Только встроенные модули Node.
// Копия того же содержимого, что последняя копия этого файла, не умножается.
const fs = require('fs');
const path = require('path');
const u = require('./util');

const MAX_BYTES = 200 * 1e6;

function backupsDir(root) { return path.join(root, '.workplace', 'backups'); }
function safeName(p) { return path.basename(p).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60) || 'file'; }
function lastFor(root, abs) {
  const idx = u.readText(path.join(backupsDir(root), 'index.jsonl'));
  if (!idx) return null;
  let found = null;
  for (const line of idx.split(/\r?\n/)) {
    if (!line) continue;
    try { const j = JSON.parse(line); if (j.from === abs) found = j; } catch (_) { /* битая строка */ }
  }
  return found;
}

// Возвращает { made: bool, file, reason }. Файла нет: копировать нечего (made:false, reason:'нет файла'). Ошибка копирования: made:false, error.
function backupFile(root, abs) {
  const src = path.resolve(abs);
  let st = null;
  try { st = fs.statSync(src); } catch (_) { return { made: false, reason: 'нет файла' }; }
  if (!st.isFile()) return { made: false, reason: 'не файл' };
  if (st.size > MAX_BYTES) return { made: false, error: 'файл больше ' + Math.round(MAX_BYTES / 1e6) + ' МБ: копия не сделана' };
  try {
    const data = fs.readFileSync(src);
    const sha = u.sha256(data);
    const prev = lastFor(root, src);
    if (prev && prev.sha256 === sha && u.exists(path.join(root, prev.copy))) return { made: false, reason: 'такая копия уже есть', file: prev.copy };
    const dir = backupsDir(root);
    fs.mkdirSync(dir, { recursive: true });
    const name = u.stamp() + '-' + safeName(src);
    let dst = path.join(dir, name), n = 1;
    while (u.exists(dst)) dst = path.join(dir, name + '-' + (++n));
    fs.writeFileSync(dst, data);
    const rel = path.relative(root, dst).split(path.sep).join('/');
    fs.appendFileSync(path.join(dir, 'index.jsonl'), JSON.stringify({ at: new Date().toISOString(), from: src, copy: rel, sha256: sha }) + '\n');
    return { made: true, file: rel };
  } catch (e) { return { made: false, error: e.message }; }
}

// Копия папки (для adopt): без тяжёлых папок, с пределом размера. Возвращает { made, dir, files, skipped, reason }.
const HEAVY = new Set(['node_modules', '.venv', 'venv', '__pycache__', '.next', '.nuxt', '.cache', '.gradle', 'target', '.pytest_cache', '.mypy_cache', '.parcel-cache', '.turbo']);
function backupDir(root, abs, label, o) {
  o = o || {};
  const limit = o.limitBytes || 500 * 1e6;
  const src = path.resolve(abs);
  const list = [];
  let total = 0;
  const skipped = [];
  (function walk(d) {
    let items = [];
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const it of items) {
      const p = path.join(d, it.name);
      if (it.isSymbolicLink()) continue;
      if (it.isDirectory()) { if (HEAVY.has(it.name)) { skipped.push(path.relative(src, p).split(path.sep).join('/')); continue; } walk(p); continue; }
      if (it.isFile()) { let sz = 0; try { sz = fs.statSync(p).size; } catch (_) { /* исчез */ } total += sz; list.push(p); }
    }
  })(src);
  if (total > limit) return { made: false, reason: 'проект больше ' + Math.round(limit / 1e6) + ' МБ без тяжёлых папок: копия не сделана', skipped };
  const base = path.join(backupsDir(root), u.stamp() + '-' + String(label || safeName(src)).replace(/[^A-Za-z0-9._-]/g, '_'));
  let dst = base, n = 1;
  while (u.exists(dst)) dst = base + '-' + (++n);
  for (const f of list) {
    const to = path.join(dst, path.relative(src, f));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(f, to);
  }
  fs.mkdirSync(dst, { recursive: true });
  return { made: true, dir: path.relative(root, dst).split(path.sep).join('/'), files: list.length, skipped };
}

module.exports = { backupsDir, backupFile, backupDir, MAX_BYTES };
