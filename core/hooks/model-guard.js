#!/usr/bin/env node
'use strict';
// PreToolUse (Agent|Task): политика «главная сессия (самая сильная модель тарифа) пишет задание и принимает, субагенты (Sonnet) исполняют». Только Claude Code.
// В ядре и включена (решение 21.10). Выключатель: node .workplace/core/cli/wp.js config set guards.model_guard false.
// У основного Codex хук не работает (config.guardEnabled возвращает false, пока main не claude).
//
// Зачем: субагент без явной модели наследует модель главной сессии. Если главная на Opus, каждая мелкая подзадача сжигает недельный лимит тарифа как Opus.
// Хук не даёт запустить субагента без model.
//
// Правила (основа - model-guard.js из v3):
//  1. В вызове есть model (не "inherit"): он и действует. Нет: берётся model из .claude/agents/<тип>.md (папка проекта, затем ~/.claude/agents); закреплённая там модель пропускается.
//  2. Модели нет нигде: запрет с подсказкой, что указать (sonnet по умолчанию).
//  3. model "opus" (любое имя с opus) без пометки [opus: причина] в description: запрет.
//  4. haiku: пропуск с напоминанием, для чего он годится.
// Любая ошибка внутри хука = тихий пропуск (хук не должен ломать работу).
const fs = require('fs');
const path = require('path');
const hookIo = require('../lib/hook-io');
const cfgLib = require('../lib/config');
const u = require('../lib/util');
const common = require('./_common');

const AGENT_NAME_RE = /^[A-Za-z0-9_.-]+$/;
const OPUS_MARK_RE = /\[opus:\s*[^\]\s][^\]]{2,}\]/i;

function frontmatterModel(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return { exists: false, model: null }; }
  text = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!m) return { exists: true, model: null };
  const mm = /^model:\s*(.+?)\s*$/m.exec(m[1]);
  if (!mm) return { exists: true, model: null };
  const val = mm[1].replace(/^["']|["']$/g, '').trim().toLowerCase();
  return { exists: true, model: !val || val === 'inherit' ? null : val };
}
function pinnedModel(type, root) {
  if (!type || !AGENT_NAME_RE.test(type)) return null;
  const dirs = [root ? path.join(root, '.claude', 'agents') : null, path.join(u.homeDir(), '.claude', 'agents')].filter(Boolean);
  for (const dir of dirs) {
    const r = frontmatterModel(path.join(dir, type + '.md'));
    if (r.exists) return r.model;
  }
  return null;
}

const OFF_HINT = ' Выключить политику: node .workplace/core/cli/wp.js config set guards.model_guard false.';

hookIo.run((data, ctx) => {
  if (!/^(agent|task)$/i.test(String(data.tool_name || ''))) return null;
  if (!cfgLib.guardEnabled(ctx.config, 'model_guard')) return null;
  const input = common.obj(data.tool_input);
  const type = typeof input.subagent_type === 'string' && input.subagent_type.trim() ? input.subagent_type.trim() : 'general-purpose';
  const description = typeof input.description === 'string' ? input.description : '';
  const param = typeof input.model === 'string' ? input.model.trim().toLowerCase() : '';
  const explicit = param && param !== 'inherit' ? param : '';
  const pinned = explicit ? null : pinnedModel(type, ctx.root);
  const effective = explicit || pinned || '';

  if (!effective) {
    return hookIo.deny('[Политика моделей] В вызове субагента нет model, он унаследует модель главной сессии (у подписки Pro это может быть Sonnet, у Max чаще Opus) и потратит лимит. ' +
      'Укажи model явно: "sonnet" по умолчанию; "haiku" только для запуска готовой команды; "opus" только с пометкой [opus: причина] в description.' + OFF_HINT);
  }
  if (/opus/.test(explicit) && !OPUS_MARK_RE.test(description)) {
    return hookIo.deny('[Политика моделей] model: "' + explicit + '" без обоснования. Добавь в description пометку [opus: причина] (развилка проектирования, суждение, финальный вердикт) или поставь model: "sonnet".' + OFF_HINT);
  }
  if (/haiku/.test(effective)) {
    return hookIo.context('PreToolUse', 'Haiku годится только для запуска готовой команды с проверяемым признаком успеха; не для подсчётов, правок по списку, удаления и проверки результата.');
  }
  return null;
}, __dirname);
