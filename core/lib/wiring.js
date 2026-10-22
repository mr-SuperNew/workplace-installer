'use strict';
// Подключение сторожей: одни и те же скрипты записываются в `.claude/settings.json` (Claude Code) и `.codex/hooks.json` (Codex).
// Шаблоны: core/wiring/claude.settings.json.tpl и codex.hooks.json.tpl. Чужие хуки и правила не трогаются; наши опознаются по пути скрипта внутри `.workplace/`.
const fs = require('fs');
const path = require('path');
const u = require('./util');
const rootLib = require('./root');

const WIRING = path.join(__dirname, '..', 'wiring');

// Ключ нашего хука: «core/hooks/secret-guard.js» или «modules/<имя>/hooks/x.js» (по тексту команды).
function hookKey(command) {
  const m = String(command || '').replace(/\\/g, '/').match(/\.workplace\/((?:core|modules)\/[^"'\s]+?\.js)/);
  return m ? m[1] : null;
}

function renderTemplate(file, root) {
  const text = fs.readFileSync(file, 'utf8');
  return JSON.parse(u.fill(text, { ROOT: u.toPosix(root) }));
}

// Выкидывает из шаблона хуки, чьих скриптов нет в пакете (этапы сборки или модуль не поставлен): подключать нечего.
// wpDir: папка, где ищутся скрипты по ключу «core/hooks/x.js»: `<корень>/.workplace` или корень нового пакета (при обновлении).
function filterAvailable(tpl, wpDir) {
  const missing = [];
  const out = JSON.parse(JSON.stringify(tpl));
  for (const ev of Object.keys(out.hooks || {})) {
    out.hooks[ev] = out.hooks[ev].map((g) => Object.assign({}, g, { hooks: g.hooks.filter((h) => {
      const k = hookKey(h.command);
      if (!k) return true;
      if (u.exists(path.join(wpDir, k))) return true;
      if (!missing.includes(k)) missing.push(k);
      return false;
    }) })).filter((g) => g.hooks.length);
    if (!out.hooks[ev].length) delete out.hooks[ev];
  }
  return { tpl: out, missing };
}

function sameJson(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// Слияние шаблона в текущий объект настроек. prune: убрать наши прежние хуки core/hooks/*.js, которых больше нет в шаблоне.
function mergeInto(cur, tpl, o) {
  o = o || {};
  const out = JSON.parse(JSON.stringify(cur || {}));
  const stat = { added: 0, updated: 0, removed: 0, perms: 0 };
  out.hooks = out.hooks && typeof out.hooks === 'object' ? out.hooks : {};
  const wantKeys = new Set();
  for (const [ev, groups] of Object.entries((tpl && tpl.hooks) || {})) for (const g of groups) for (const h of g.hooks) { const k = hookKey(h.command); if (k) wantKeys.add(ev + '|' + k); }
  for (const [ev, groups] of Object.entries((tpl && tpl.hooks) || {})) {
    out.hooks[ev] = Array.isArray(out.hooks[ev]) ? out.hooks[ev] : [];
    for (const g of groups) {
      for (const h of g.hooks) {
        const k = hookKey(h.command);
        let hit = null;
        if (k) for (const eg of out.hooks[ev]) { const idx = (eg.hooks || []).findIndex((x) => hookKey(x.command) === k); if (idx >= 0) { hit = { eg, idx }; break; } }
        if (hit) {
          // Сопоставитель (matcher) живёт в группе, а не в хуке: если шаблон его поменял (например добавил PowerShell), наш хук переезжает в группу с новым.
          // Чужие хуки той же группы остаются на месте. Без этого уже подключённая раньше папка навсегда осталась бы со старым сопоставителем.
          if ((hit.eg.matcher || '') !== (g.matcher || '')) {
            hit.eg.hooks.splice(hit.idx, 1);
            let grp = out.hooks[ev].find((x) => x !== hit.eg && (x.matcher || '') === (g.matcher || '') && Array.isArray(x.hooks));
            if (!grp) { grp = g.matcher ? { matcher: g.matcher, hooks: [] } : { hooks: [] }; out.hooks[ev].push(grp); }
            grp.hooks.push(Object.assign({}, h));
            if (!hit.eg.hooks.length) out.hooks[ev] = out.hooks[ev].filter((x) => x !== hit.eg);
            stat.updated++;
            continue;
          }
          if (!sameJson(hit.eg.hooks[hit.idx], h)) { hit.eg.hooks[hit.idx] = Object.assign({}, h); stat.updated++; }
          continue;
        }
        let grp = out.hooks[ev].find((x) => (x.matcher || '') === (g.matcher || '') && Array.isArray(x.hooks));
        if (!grp) { grp = g.matcher ? { matcher: g.matcher, hooks: [] } : { hooks: [] }; out.hooks[ev].push(grp); }
        grp.hooks.push(Object.assign({}, h));
        stat.added++;
      }
    }
  }
  if (o.prune) {
    for (const ev of Object.keys(out.hooks)) {
      for (const eg of out.hooks[ev]) {
        if (!Array.isArray(eg.hooks)) continue;
        const keep = eg.hooks.filter((x) => { const k = hookKey(x.command); return !(k && /^core\/hooks\//.test(k) && !wantKeys.has(ev + '|' + k)); });
        stat.removed += eg.hooks.length - keep.length;
        eg.hooks = keep;
      }
      out.hooks[ev] = out.hooks[ev].filter((eg) => !Array.isArray(eg.hooks) || eg.hooks.length);
      if (!out.hooks[ev].length) delete out.hooks[ev];
    }
  }
  const wantAllow = tpl && tpl.permissions && Array.isArray(tpl.permissions.allow) ? tpl.permissions.allow : [];
  if (wantAllow.length) {
    if (!out.permissions || typeof out.permissions !== 'object') out.permissions = {};
    if (!Array.isArray(out.permissions.allow)) out.permissions.allow = [];
    for (const rule of wantAllow) if (!out.permissions.allow.includes(rule)) { out.permissions.allow.push(rule); stat.perms++; }
  }
  if (!Object.keys(out.hooks).length) delete out.hooks;
  return { cur: out, stat, changed: !sameJson(out, cur || {}) };
}

// Записывает слитый файл; перед изменением существующего ставится копия .bak-<дата>. Повреждённый JSON не трогается.
// g: охрана записи (fsguard). Возвращает { file, had, changed, stat, backup }.
function applyFile(file, tpl, g, o) {
  o = o || {};
  let cur = {}, had = false;
  if (u.exists(file)) {
    had = true;
    try { cur = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch (e) { throw new u.WpError(path.basename(file) + ' повреждён (' + e.message + '). Не трогаю: покажи человеку.', 2); }
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) throw new u.WpError(path.basename(file) + ' не похож на настройки (не объект). Не трогаю: покажи человеку.', 2);
  }
  const m = mergeInto(cur, tpl, o);
  const res = { file, had, changed: m.changed, stat: m.stat, backup: null };
  if (o.dryRun) return res;
  if (had && m.changed) { res.backup = file + '.bak-' + u.today(); g.cf(file, res.backup); }
  if (m.changed) g.wf(file, JSON.stringify(m.cur, null, 2) + '\n');
  return res;
}

function templatePaths() { return { claude: path.join(WIRING, 'claude.settings.json.tpl'), codex: path.join(WIRING, 'codex.hooks.json.tpl') }; }

// Что подключено сейчас: ключи хуков по провайдерам.
function wiredKeys(file) {
  const j = u.readJson(file);
  const out = new Set();
  if (j && j.hooks) for (const groups of Object.values(j.hooks)) for (const g of groups || []) for (const h of g.hooks || []) { const k = hookKey(h.command); if (k) out.add(k); }
  return out;
}

module.exports = { WIRING, hookKey, renderTemplate, filterAvailable, mergeInto, applyFile, templatePaths, wiredKeys };
