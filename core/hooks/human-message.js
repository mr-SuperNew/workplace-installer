#!/usr/bin/env node
'use strict';
// UserPromptSubmit: записывает сообщение человека в `.workplace/human-messages.json`. Один скрипт для Claude Code и Codex. Ничего не блокирует. Заодно (без участия ИИ) закрывает в .gitignore главной папки вложенные проекты со своим .git и сообщает об этом ИИ.
// Это единственный источник «да» для danger-guard и «без проверки» для cross-check-guard (core/lib/consent.js): подтверждает только сообщение человека.
// Писать в этот файл ИИ не может: danger-guard отклоняет запись в него и запуск самого хука. Строки, похожие на ключ или пароль, в файл не попадают.
// Если хук не подключён (Codex: проект не доверен, команда /hooks), записей нет, и сторож честно отвечает «подтвердить нечем»: действие делает сам человек.
const hookIo = require('../lib/hook-io');
const consent = require('../lib/consent');
const adopt = require('../lib/adopt');

hookIo.run((data, ctx) => {
  if (!ctx.root) return null;
  const prompt = typeof data.prompt === 'string' ? data.prompt : '';
  if (!prompt.trim()) return null;
  consent.record(ctx.root, { prompt, session: data.session_id || data.sessionId || null });
  // Безопасная привычка вместо надежды на текст правил: проект со своим .git, который человек скопировал в главную папку, уходит в её .gitignore сам
  // (иначе коммит главной папки захватит чужую историю). Только дописывание строки в .gitignore главной папки; сообщение ИИ говорит, что сделано.
  try {
    const r = adopt.gitignoreNested(ctx.root, { maxMs: 1500 });
    if (r.added.length) return hookIo.context('UserPromptSubmit', 'Рабочее место дописало в .gitignore главной папки вложенные проекты со своим .git: ' + r.added.map(adopt.giLine).join(', ') + '. Это сделано до твоего ответа: коммит главной папки их не захватит. Скажи человеку одной строкой.');
  } catch (_) { /* не мешаем работе */ }
  return null;
}, __dirname);
