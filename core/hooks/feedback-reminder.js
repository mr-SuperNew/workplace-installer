#!/usr/bin/env node
'use strict';
// UserPromptSubmit: ловит поправку от человека и напоминает записать правило в живое место. Один скрипт для Claude Code и Codex.
// Ничего не блокирует, только добавляет подсказку. Без обращений к сети. Основа - feedback-detect.js из v3.
// Изменения к v3: переименован; добавлены английские формулировки; убран триггер «исправь это» (это задача, а не поправка);
// команды со слэша (/end-session и другие навыки) и длинные вставки текста не разбираются.
const hookIo = require('../lib/hook-io');
const cfgLib = require('../lib/config');
const common = require('./_common');

const NL = '(?![а-яёa-z])';   // JS \b с кириллицей не работает: граница слова задана вручную
const TRIGGERS = [
  // русский
  new RegExp('не так' + NL, 'i'),
  /неправильно/i,
  new RegExp('неверно' + NL, 'i'),
  /ты (ошиб(ся|лась|ка)|не понял|не поняла)/i,
  /опять (ты|то же|снова|не то)/i,
  /(снова|опять) ошибк/i,
  /я же (говорил|говорила|просил|просила|писал|писала)/i,
  /не делай так/i,
  /больше так не/i,
  /не надо так/i,
  /так (делать )?не надо/i,
  new RegExp('запомни(те)?' + NL, 'i'),
  /впредь\s+(делай|пиши|используй|не|всегда)/i,
  /в следующий раз\s+(делай|используй|пиши|не|сделай|запомни|проверь)/i,
  /всегда (делай|пиши|используй|проверяй)/i,
  /никогда не\s+(делай|пиши|используй|повторяй|отправляй|удаляй)/i,
  /запиши (это )?(в )?(правила|память|memory)/i,
  // английский
  /\bdon'?t (do|use|write|send|touch) (that|this|it)\b/i,
  /\b(that'?s|this is|you got (it|that)) (wrong|not right)\b/i,
  /\bnot what i (asked|meant|wanted|said)\b/i,
  /\bi (already )?(told|asked) you\b/i,
  /\bi said\b.{0,20}\b(not|don'?t)\b/i,
  /\bremember (that|to|this|:)/i,
  /\bfrom now on\b/i,
  /\bnext time\b.{0,40}\b(do|use|write|check|don'?t|never|always)\b/i,
  /\balways (do|use|write|check|run)\b/i,
  /\bnever (do|use|write|send|delete)\b/i,
  /\bstop (doing|using|writing)\b/i,
  /\bplease don'?t\b/i,
];
const MAX_SCAN = 1200;

hookIo.run((data, ctx) => {
  if (!cfgLib.guardEnabled(ctx.config, 'feedback_reminder')) return null;
  const prompt = typeof data.prompt === 'string' ? data.prompt.trim() : '';
  if (!prompt || prompt.startsWith('/')) return null;
  const head = prompt.length > MAX_SCAN ? prompt.slice(0, MAX_SCAN) : prompt;
  if (!TRIGGERS.some((r) => r.test(head))) return null;

  const root = ctx.root || data.cwd || process.cwd();
  const ws = ctx.root ? common.findWorkspace(root, data.cwd) : root;
  const wsRel = ctx.root ? common.rel(root, ws) : '.';
  const where = ws === root
    ? 'общее для всей работы: в AGENTS.md корня; наблюдение или решение: в MEMORY.md корня'
    : 'касается этой папки: в ' + wsRel + '/AGENTS.md; наблюдение или решение: в ' + wsRel + '/MEMORY.md; общее для всей работы: в AGENTS.md корня';
  return hookIo.context('UserPromptSubmit',
    'Похоже на поправку от человека. Сначала исправь сделанное. Потом запиши правило одной короткой строкой (' + where +
    '), предварительно проверив, что такой строки ещё нет. Отдельные файлы с уроками не заводи. Скажи человеку, куда записал.');
}, __dirname);
