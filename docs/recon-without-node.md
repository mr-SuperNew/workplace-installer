# Разведка без Node

**TL;DR:** скрипты пакета написаны на Node, поэтому, пока Node не стоит, разведку делает сам ИИ командами оболочки из таблиц ниже. Команды только читают: ничего не ставят, не создают и не меняют. Итог тот же, что у `wp.js recon`: таблица «есть / нет / версия», один из четырёх случаев и список «не трогаю». После «да» ставится Node, и дальше работают скрипты (`wp.js recon` повторит разведку целиком, это быстро).

Порядок: разведка командами из этого файла, таблица человеку, «да», Node, скачивание пакета, `wp.js init`. Запись в журнал: «Node поставлен до init» (отмечается после `init`).

## Чего избегать при разведке (только на этапе установки)

- Не вызывать `claude auth status`: команда создаёт файлы настроек. Вход определяется по наличию файла, подробности ниже; живая проверка входа делается после «да».
- Не запускать `git` и `python3` на Mac, пока `xcode-select -p` не напечатал путь: без Command Line Tools это заглушки, их запуск открывает системное окно установки.
- Не запускать `python` на Windows: псевдоним из `WindowsApps` открывает Microsoft Store. Питон на Windows проверяется командой `py -3 --version`.
- Не запускать интерактивную оболочку с профилями человека (`zsh -ilc`, `bash -l`): она исполняет его профили. Это правило и для проверки после установки: новая программа проверяется в новом окне терминала или по полному пути, а не через такую оболочку.
- Не читать содержимое `.env`, `~/.codex/auth.json`, `~/.claude/.credentials.json`, `~/.npmrc`: только проверка, что файл есть.
- Папки проектов человека перечисляются по именам: на этапе установки в них не заходят и `git` там не вызывают (они не нужны для установки). После установки по просьбе человека это обычная работа.

## macOS (Терминал, zsh)

Каждая команда отдельно; пустой вывод значит «нет».

| Что узнать | Команда |
|---|---|
| Система и процессор | `sw_vers -productVersion`, `uname -m` и `sysctl -n hw.optional.arm64` (печатает 1 на Apple Silicon, в том числе в терминале под Rosetta, где `uname -m` даёт x86_64; на Intel пусто или ошибка: это не сбой, а «Intel») |
| Что есть и где | `command -v node npm git python3 claude codex brew code` |
| Все копии `claude` и `codex` | `which -a claude codex` |
| Известные места мимо PATH | `ls ~/.local/bin/claude ~/.local/bin/codex ~/.npm-global/bin 2>/dev/null` |
| Версии | `node --version`, `npm --version`, `claude --version`, `codex --version` (каждую, только если команда нашлась выше) |
| Command Line Tools | `xcode-select -p` (печатает путь: инструменты стоят) |
| git и Python | `git --version` и `python3 --version`, только если `xcode-select -p` напечатал путь |
| Расширения VS Code | `ls ~/.vscode/extensions 2>/dev/null \| grep -E 'anthropic.claude-code\|openai.chatgpt'` |
| Признак входа в Codex | `test -f ~/.codex/auth.json && echo есть` |
| Признак входа в Claude | `security find-generic-password -s "Claude Code-credentials" >/dev/null 2>&1 && echo есть` (флаги `-w` и `-g` не использовать: они показывают пароль); запасной вариант `test -f ~/.claude/.credentials.json && echo есть` |
| Свободное место | `df -h ~ \| tail -1` |
| Менеджеры пакетов | `command -v brew volta fnm asdf nodenv`; `test -d ~/.nvm && echo nvm` |

## Windows (PowerShell)

| Что узнать | Команда |
|---|---|
| Система и процессор | `[System.Environment]::OSVersion.Version` и `$env:PROCESSOR_ARCHITECTURE` |
| Что есть и где | `Get-Command node,npm,git,py,claude,codex,winget,code -ErrorAction SilentlyContinue \| Format-Table Name,Source -AutoSize` |
| Известные места мимо PATH | `Test-Path "$env:USERPROFILE\.local\bin\claude.exe"`, `Test-Path "$env:APPDATA\npm\claude.cmd"`, `Test-Path "$env:LOCALAPPDATA\Programs\OpenAI\Codex\bin\codex.exe"`, `Test-Path "$env:APPDATA\npm\codex.cmd"` |
| Версии | `node --version`, `npm --version`, `claude --version`, `codex --version`, `git --version` (каждую, только если команда нашлась выше) |
| Python | `py -3 --version` (если `Get-Command python` показывает путь с `WindowsApps`, это заглушка магазина: Python не стоит) |
| Расширения VS Code | `Get-ChildItem "$env:USERPROFILE\.vscode\extensions" -Directory \| Where-Object { $_.Name -match '^(anthropic\.claude-code\|openai\.chatgpt)-' } \| Select-Object -ExpandProperty Name` |
| Признак входа в Codex | `Test-Path "$env:USERPROFILE\.codex\auth.json"` |
| Признак входа в Claude | `Test-Path "$env:USERPROFILE\.claude\.credentials.json"` |
| Свободное место | `(Get-PSDrive -Name C).Free / 1GB` |

Если окна PowerShell нет (ИИ работает в Git Bash), те же проверки: `command -v node npm git claude codex` и `ls "$APPDATA/npm"`.

## Как читать результат

Из строк «есть / нет» сложите таблицу, как у `wp.js recon`: VS Code, расширение Claude Code, расширение Codex, консольный `claude`, вход в Claude, консольный `codex`, вход в Codex, Node, Python, git. Расширение Codex консольным Codex не считается: в таблице это две отдельные строки.

Случай (то же правило, что в `core/lib/recon.js`, функция `detectCase`):

| Случай | Условие |
|---|---|
| **пусто** | нет ни Claude Code, ни Codex (ни консольных, ни расширений) |
| **только Claude Code** | Claude Code есть (консольный или в расширении), Codex нет |
| **только Codex** | Codex есть (консольный или в расширении), Claude Code нет |
| **всё есть, но разбросано** | есть и то и другое; либо копий одной программы больше одной; либо программа лежит вне PATH |

Основным предлагается Claude Code, проверяющим Codex (при «только Codex» Claude Code будет поставлен). Если человек хочет основным Codex, проверять будет Claude Code. Решает человек одним словом.

Список «не трогаю» на время установки: найденные папки проектов перечисляются по именам, содержимое не читается, `git` в них не вызывается.

## Если Node нет или он старше 18

Скрипты пакета работают на Node 18 или новее. Старую версию Node без «да» не заменяют: она общая для проектов человека.

| Система | Что ставится после «да» |
|---|---|
| macOS, Homebrew уже стоит и поддерживается (Apple Silicon и macOS 15 или новее) | `brew install node` |
| macOS, во всех остальных случаях (Homebrew нет или Mac его не поддерживает: Intel, macOS ниже 15 на Apple Silicon) | официальный архив с nodejs.org в `~/.local/node` без пароля: `bash ПАКЕТ/core/scripts/install-node-user.sh --dry-run`, после «да» `bash ПАКЕТ/core/scripts/install-node-user.sh`. Скрипт берёт Node 24 на macOS 13.5 и новее, Node 22 на macOS 11 - 13.4, на более старой отказывает; сверяет sha256 по SHASUMS256.txt с nodejs.org. Homebrew не ставь и не предлагай. Запасной путь: установщик `.pkg` с https://nodejs.org/en/download (двойной щелчок и пароль) |
| Windows | `winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements` (окно UAC нажимает человек) |

После установки Node проверяется в НОВОМ окне терминала или по полному пути: на Mac `~/.local/node/bin/node --version` (архив), `/opt/homebrew/bin/node --version` или `/usr/local/bin/node --version`, на Windows новое окно PowerShell и `where.exe node`. Node из архива в PATH сам не попадает: до записи PATH (`wp.js path-fix --yes --human-said "слова человека с «да»"` по «да» человека, после `init`) вызывай `~/.local/node/bin/node` по полному пути, каждая команда ИИ идёт в отдельной оболочке. Если новое окно видит `node`, а текущее нет, вызывай Node по абсолютному пути или попроси перезапустить окно редактора.

Дальше: скачать пакет версии и сверить sha256 (шаги в `INSTALL.md`), выполнить `node <пакет>/core/cli/wp.js recon` (полная таблица, повторная проверка случая) и `wp.js init`.

См. также: [четыре случая](cases.md), [шаги установки на Mac](install-steps/mac.md), [шаги установки на Windows](install-steps/windows.md), [устранение неполадок](troubleshooting.md), [записи вне главной папки](global-writes.md).
