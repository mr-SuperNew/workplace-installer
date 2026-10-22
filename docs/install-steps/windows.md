# Установка на Windows

**Коротко:** обычно всё ставит команда `node .workplace/core/cli/wp.js install ИМЯ --yes --human-said "слова человека с «да»"` после вашего «да». Этот файл говорит, что именно она делает, и даёт ручные команды, если ими удобнее или `wp.js` ещё недоступен (например, пока не стоит Node). Команды выполняются в PowerShell. Нужна Windows 10 версии 1809 или новее. Файл описывает установку; после неё ИИ делает просьбы человека по правилам `AGENTS.md` главной папки.

## Что откуда ставится

| Что | Откуда | Куда пишет |
|---|---|---|
| Node.js 18 или новее | `winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements` | Program Files; окно UAC нажимает человек |
| Python 3 | `winget install -e --id Python.Python.3.13 --accept-package-agreements --accept-source-agreements` (идентификатор проверен командой `winget search Python.Python` на Windows 11, 21.10.2026: в списке есть Python.Python.3.13 версии 3.13.15) | так же |
| git | `winget install -e --id Git.Git --accept-package-agreements --accept-source-agreements` | Program Files |
| Claude Code | официальный установщик `irm https://claude.ai/install.ps1 \| iex` | `%USERPROFILE%\.local\bin\claude.exe`, `%USERPROFILE%\.local\share\claude`; права администратора не нужны |
| Codex CLI | официальный установщик `powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 \| iex"` | `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe`; дописывает пользовательский PATH; права администратора не нужны |

Источники: https://code.claude.com/docs/en/setup (Claude Code), https://github.com/openai/codex и скрипт https://chatgpt.com/codex/install.ps1 (Codex), список проверен 21.10.2026.

Запасной путь для Claude Code и Codex: `npm install -g` (Node нужен). `wp.js install` пробует его сам, если официальный установщик не сработал. Кэш npm идёт в `.workplace/npm-cache` внутри главной папки, а не в `%USERPROFILE%\.npm`.

Нет `winget`: скачайте установщики с сайтов nodejs.org, python.org, git-scm.com и запустите их (это делает человек). Команду для администратора ИИ объясняет и отдаёт вам.

## Правило PATH

После установки, которая меняет PATH, проверяйте программу в новом окне PowerShell или по полному пути. Старое окно может не видеть её.

- Новое окно: `where.exe node claude codex git`.
- Полный путь: `& "$env:USERPROFILE\.local\bin\claude.exe" --version`.

Проверить, что папка `.local\bin` есть в PATH: `$env:PATH -split ';' | Select-String '\.local\\bin'`. Если её нет, добавьте в пользовательский PATH (запись входит в план установки; по отдельной просьбе: показ разницы и ваше «да»): `$p=[Environment]::GetEnvironmentVariable('PATH','User'); [Environment]::SetEnvironmentVariable('PATH',"$p;$env:USERPROFILE\.local\bin",'User')`. Затем закройте и откройте программу, в которой работаете.

## Особенности Windows

- Слово `curl` в PowerShell значит другую команду. Для скачивания пишите `curl.exe`.
- Python. Не запускайте `python` без проверки: псевдоним из `WindowsApps` открывает Microsoft Store. Версия проверяется командой `py -3 --version`.
- Git for Windows необязателен для Claude Code, но с ним Claude Code использует Git Bash. Если Git Bash не находится, в `settings.json` Claude Code задаётся `{"env": {"CLAUDE_CODE_GIT_BASH_PATH": "C:\\Program Files\\Git\\bin\\bash.exe"}}`.
- Для основного Codex git нужен для сторожей: корень проекта определяется по папке `.git`.
- Политика запуска скриптов. Установщик Codex запускается с `-ExecutionPolicy ByPass` на один вызов. Политику системы он не меняет.
- Права администратора вводите вы. ИИ даёт команду, объясняет её, окно UAC нажимает человек.

## Порядок

1. Node, Python, git: командами из таблицы выше (или `wp.js install python --yes --human-said "слова человека с «да»"`, `wp.js install git --yes --human-said "слова человека с «да»"`, Node ставится до `wp.js`).
2. Claude Code: `wp.js install claude --yes --human-said "слова человека с «да»"`. Уже стоящую копию обновляют по вашему «да».
3. Codex CLI: `wp.js install codex --yes --human-said "слова человека с «да»"`. Расширение Codex в VS Code консольную программу не заменяет.
4. Входы. Codex: `codex login` (откроется браузер, войдите в ChatGPT); нет браузера: `codex login --device-auth`. Claude Code: `claude auth login`. Проверка: `codex login status` и `wp.js verify P1.main-login P1.reviewer-login --live`. Нужна подписка: Claude Pro или выше, ChatGPT Plus или выше. Вход по платному ключу API не используется.
5. Проверьте программы в новом окне (правило PATH выше).

## Если не получилось

Подсказки по этапам лежат в [troubleshooting.md](../troubleshooting.md). Первый способ не помог: пробуйте другой, а ИИ объяснит, что случилось, и предложит следующий шаг.
