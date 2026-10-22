'use strict';
// Напоминатель правила: поправка от человека -> подсказка записать правило; задачи, команды навыков и длинные вставки молчат.
const path = require('path');
const h = require('./_harness');

const ROOT = h.makeRoot({ files: { 'AGENTS.md': '# корень', 'workspaces/site/AGENTS.md': '# site' } });
const opts = { projectDir: ROOT };
const submit = (prompt, cwd) => ({ hook_event_name: 'UserPromptSubmit', prompt, cwd: cwd || ROOT });
const yes = (name, prompt, more) => Object.assign({ name: 'поправка: ' + name, input: submit(prompt), expect: 'context', opts, has: 'Похоже на поправку' }, more || {});
const no = (name, prompt) => ({ name: 'не поправка: ' + name, input: submit(prompt), expect: 'silent', opts });

const cases = [
  yes('«ты не так понял»', 'Ты не так понял, мне нужен другой файл'),
  yes('«неправильно»', 'Неправильно, перепиши'),
  yes('«я же говорил»', 'Я же говорила, не трогай настройки'),
  yes('«опять ты»', 'Опять ты удалил лишнее'),
  yes('«запомни»', 'Запомни: отчёты пишем по-русски'),
  yes('«в следующий раз проверь»', 'В следующий раз проверь файл до записи'),
  yes('«никогда не удаляй»', 'Никогда не удаляй папку data'),
  yes('«не делай так»', 'Не делай так больше'),
  yes('английское «don\'t do that»', "Please, don't do that again"),
  yes('английское «that\'s wrong»', "That's wrong, use the other file"),
  yes('английское «from now on»', 'From now on answer in Russian'),
  yes('английское «remember to»', 'Remember to run the tests first'),
  yes('указывает место: корень (AGENTS.md и MEMORY.md корня)', 'Запомни: без сокращений', { has: ['AGENTS.md корня', 'MEMORY.md корня'] }),
  { name: 'поправка в подпапке: правило пишется в AGENTS.md этой папки', input: submit('Запомни: без сокращений', path.join(ROOT, 'workspaces', 'site')), expect: 'context', opts, has: ['workspaces/site/AGENTS.md', 'общее для всей работы'] },
  { name: 'Codex-режим: без CLAUDE_PROJECT_DIR, корень по cwd', input: submit('Запомни: без сокращений'), expect: 'context', opts: {}, has: 'Похоже на поправку' },
  no('«исправь это» (это задача, а не поправка)', 'Исправь это в третьем абзаце'),
  no('обычная задача', 'Сделай таблицу из этого списка'),
  no('вопрос', 'Как проверить, что Codex установлен?'),
  no('команда навыка со слэша', '/end-session запомни всё'),
  no('пустое сообщение', ''),
  no('длинная вставка, где «запомни» глубоко в тексте', 'обычный текст. '.repeat(200) + ' запомни это слово'),
  no('«запомнился» не считается (граница слова)', 'Этот фильм запомнился надолго'),
  { name: 'флаг guards.feedback_reminder=false -> молчит', input: (o) => submit('Запомни это', o.projectDir), expect: 'silent', make: () => ({ projectDir: h.makeRoot({ config: { guards: { feedback_reminder: false } } }) }) },
  { name: 'вне рабочего места: подсказка тоже работает (корень = cwd)', input: (o) => submit('Запомни это', o.cwd), expect: 'context', make: () => ({ cwd: h.makeBare() }), has: 'AGENTS.md корня' },
  { name: 'поле prompt не строка -> молчит', input: { hook_event_name: 'UserPromptSubmit', prompt: 42, cwd: ROOT }, expect: 'silent', opts },
];

module.exports = { hook: 'feedback-reminder', cases };
