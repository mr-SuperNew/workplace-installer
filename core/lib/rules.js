'use strict';
// Правила главной папки (AGENTS.md) из шаблона и смена ролей в них. Роли в шаблоне — {{MAIN}}, {{REVIEWER}}, {{REVIEWER_VENDOR}}; названия берутся из core/providers.
// Нужно двум местам: layout (раскладка, `layout --update`) и roles (`wp.js role set`), поэтому вынесено отдельно, без циклической связи.
const fs = require('fs');
const path = require('path');
const u = require('./util');
const providers = require('../providers');

const TPL = path.join(__dirname, '..', 'templates');

function names(cfg) {
  const m = providers.get(cfg.main), r = providers.get(cfg.reviewer);
  return { MAIN: m.label, REVIEWER: r.label, REVIEWER_VENDOR: r.vendor };
}
function template() { return fs.readFileSync(path.join(TPL, 'AGENTS.md.tpl'), 'utf8'); }
// Текст AGENTS.md для пары ролей.
function render(main, reviewer) { return u.fill(template(), names({ main, reviewer })); }

// Приводит роли в тексте AGENTS.md к cfg. Три исхода:
//  - текст равен тому, что дал бы шаблон для другого направления: заменяется целиком (how: 'full');
//  - человек или ИИ правили файл: меняются только строки, различающиеся у двух направлений, и только если они стоят в файле как в шаблоне (how: 'lines'); остальное не трогается;
//    строки, которые не нашлись, возвращаются в left;
//  - роли уже верные (how: 'same') или в файле нет ни одной строки шаблона (how: 'none').
function syncRoles(current, cfg) {
  const want = render(cfg.main, cfg.reviewer);
  if (current === want) return { text: current, changed: false, how: 'same', left: [] };
  const old = render(cfg.reviewer, cfg.main);          // роли переставлены: так выглядел файл до смены направления
  if (current === old) return { text: want, changed: true, how: 'full', left: [] };
  const a = old.split('\n'), b = want.split('\n');
  if (a.length !== b.length) return { text: current, changed: false, how: 'none', left: [] };
  const cr = current.includes('\r\n');
  let lines = current.replace(/\r\n/g, '\n').split('\n');
  let replaced = 0;
  const left = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    if (lines.includes(a[i])) { lines = lines.map((l) => (l === a[i] ? b[i] : l)); replaced++; }
    else if (!lines.includes(b[i])) left.push(a[i]);
  }
  if (!replaced) return { text: current, changed: false, how: 'none', left };
  const text = lines.join('\n');
  return { text: cr ? text.replace(/\n/g, '\r\n') : text, changed: true, how: 'lines', replaced, left };
}

// Строки, которые у двух направлений различаются: по ним проверяется, что роли в файле согласованы с настройками.
function roleLines(cfg) {
  const a = render(cfg.main, cfg.reviewer).split('\n'), b = render(cfg.reviewer, cfg.main).split('\n');
  return a.filter((l, i) => b[i] !== undefined && l !== b[i]);
}

module.exports = { TPL, names, template, render, syncRoles, roleLines };
