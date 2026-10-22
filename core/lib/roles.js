'use strict';
// `wp.js role set <claude|codex>`: смена основного ИИ одним шагом. Меняются вместе:
//   1. config.json (main, reviewer всегда другой; модель проверяющего сбрасывается: она относилась к прежнему проверяющему);
//   2. роли в AGENTS.md (core/lib/rules.js: целиком, если файл не правили, иначе только строки с ролями; перед правкой копия в .workplace/backups/);
//   3. навыки в .claude/skills и .agents/skills (layout --update), сеть для песочницы основного Codex (.codex/config.toml);
//   4. сторожа в .claude/settings.json и .codex/hooks.json (оба ИИ подключены всегда; для нового основного заново проверяется подключение);
//   5. этап самопроверки с вшитой ошибкой сбрасывается: прежняя самопроверка относилась к прежнему проверяющему.
// После этого wp.js запускает самопроверку (навык cross-check, selftest-run.js) и отмечает этап, если она прошла. Всё согласовано проверяет consistency().
const fs = require('fs');
const path = require('path');
const u = require('./util');
const rootLib = require('./root');
const config = require('./config');
const state = require('./state');
const rules = require('./rules');
const backup = require('./backup');
const layout = require('./layout');
const wiring = require('./wiring');
const providers = require('../providers');

function filesOf(dir) {
  const out = {};
  (function walk(d) {
    for (const it of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, it.name);
      if (it.isDirectory()) walk(p); else if (it.isFile()) out[path.relative(dir, p).split(path.sep).join('/')] = u.sha256File(p);
    }
  })(dir);
  return out;
}

// Проблемы согласованности ролей (пусто = везде одно и то же).
function consistency(root) {
  const p = rootLib.paths(root);
  const cfg = config.load(root);
  const bad = [];
  const cv = config.validate(cfg);
  if (cv.length) bad.push('config.json: ' + cv.join('; '));
  const am = u.readText(path.join(root, 'AGENTS.md')) || '';
  const lines = new Set(am.replace(/\r\n/g, '\n').split('\n'));
  const wantLines = rules.roleLines(cfg);
  const missing = wantLines.filter((l) => !lines.has(l));
  if (missing.length) bad.push('AGENTS.md: роли не совпадают с настройками (основной ' + providers.get(cfg.main).label + ', проверяет ' + providers.get(cfg.reviewer).label + '); нет строк: ' + missing.slice(0, 2).map((l) => '«' + l.slice(0, 60) + '»').join(', '));
  const oldLines = rules.roleLines({ main: cfg.reviewer, reviewer: cfg.main }).filter((l) => lines.has(l));
  if (oldLines.length) bad.push('AGENTS.md: остались строки прежних ролей: ' + oldLines.slice(0, 2).map((l) => '«' + l.slice(0, 60) + '»').join(', '));
  for (const sk of layout.skillSources(root)) {
    const src = filesOf(path.join(p.core, 'skills', sk));
    for (const base of [p.claudeSkills, p.agentsSkills]) {
      const dst = path.join(base, sk);
      if (!u.isDir(dst)) { bad.push('навык ' + sk + ' нет в ' + path.relative(root, base).split(path.sep).join('/')); continue; }
      const have = filesOf(dst);
      const diff = Object.keys(src).filter((f) => have[f] !== src[f]);
      if (diff.length) bad.push('навык ' + sk + ' в ' + path.relative(root, base).split(path.sep).join('/') + ' отличается от пакета: ' + diff.slice(0, 2).join(', '));
    }
  }
  const rows = layout.hooksStatus(root);
  for (const r of rows) {
    if (!r.present) bad.push('сторож ' + r.hook + ': файла нет');
    else if (r.claude.wanted && !r.claude.wired) bad.push('сторож ' + r.hook + ' не подключён в .claude/settings.json');
    else if (r.codex.wanted && !r.codex.wired) bad.push('сторож ' + r.hook + ' не подключён в .codex/hooks.json');
  }
  if (cfg.main === 'codex' && layout.codexNetConfigState(u.readText(path.join(root, '.codex', 'config.toml'))) !== 'ok') bad.push('.codex/config.toml: нет sandbox_workspace_write.network_access = true (основной Codex вызывает проверяющего Claude из песочницы)');
  const st = state.load(root);
  if (st && st.direction && (st.direction.main !== cfg.main || st.direction.reviewer !== cfg.reviewer)) bad.push('state.json: направление ' + st.direction.main + '/' + st.direction.reviewer + ' не совпадает с config.json');
  return bad;
}

// o: { reviewerModel }. Возвращает { before, after, report:[[статус, что]], layout, hooks, hooksTest, problems }.
function setRole(root, main, o) {
  o = o || {};
  if (!config.PROVIDERS.includes(main)) throw new u.WpError('role set: claude или codex.', 2);
  const before = config.load(root);
  const reviewer = config.other(main);
  const report = [];
  // копии до правок
  for (const f of [path.join(root, 'AGENTS.md'), path.join(root, '.workplace', 'config.json')]) {
    const b = backup.backupFile(root, f);
    if (b.made) report.push(['копия до правки', b.file]);
  }
  // 1. настройки
  const cfg = config.strip(before);
  const same = before.main === main;
  cfg.main = main; cfg.reviewer = reviewer;
  cfg.reviewer_model = o.reviewerModel !== undefined ? (o.reviewerModel || null) : (same ? before.reviewer_model : null);
  config.save(root, cfg);
  report.push([same ? 'без изменений' : 'изменено', 'config.json: основной ' + main + ', проверяет ' + reviewer + (!same && before.reviewer_model ? ' (модель проверяющего сброшена: она относилась к ' + before.reviewer + ')' : '')]);
  // 2 и 3. правила, навыки в оба места, сеть Codex
  const lay = layout.layout(root, { update: true });
  for (const [st, what] of lay) if (/AGENTS\.md|навык|skills|config\.toml|SKILL/.test(what) || /^ОТЛИЧАЕТСЯ|^НЕТ В ПАКЕТЕ/.test(st)) report.push([st, what]);
  // 4. сторожа
  const hooks = layout.wireHooks(root);
  report.push(['сторожа', '.claude/settings.json: добавлено ' + hooks.claude.stat.added + ', обновлено ' + hooks.claude.stat.updated + '; .codex/hooks.json: добавлено ' + hooks.codex.stat.added + ', обновлено ' + hooks.codex.stat.updated]);
  // 5. состояние
  const s = state.need(root);
  s.direction = { main, reviewer };
  if (!same) state.setStage(s, 'P3.selftest', 'todo', null, 'роли сменились (' + before.main + ' -> ' + main + '): самопроверка нужна заново');
  state.save(root, s);
  state.log(root, 'роли: основной ' + main + ', проверяет ' + reviewer + (same ? ' (повторно, без смены)' : ' (был ' + before.main + ')'));
  const ht = layout.hooksTest(root);
  const problems = consistency(root).concat(ht.bad);
  return { before: { main: before.main, reviewer: before.reviewer }, after: { main, reviewer }, report, layout: lay, hooks, hooksTest: ht, problems };
}

module.exports = { consistency, setRole, filesOf };
