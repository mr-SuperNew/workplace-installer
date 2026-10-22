# Установка на Mac

**Коротко:** обычно всё ставит команда `node .workplace/core/cli/wp.js install ИМЯ --yes --human-said "слова человека с «да»"` после вашего «да». Этот файл говорит, что именно она делает, и даёт ручные команды, если ими удобнее или `wp.js` ещё недоступен (например, пока не стоит Node). Все команды выполняются в приложении «Терминал» (zsh). Файл описывает установку; после неё ИИ делает просьбы человека по правилам `AGENTS.md` главной папки.

## Что откуда ставится

| Что | Откуда | Куда пишет |
|---|---|---|
| Node.js 18 или новее | Homebrew (`brew install node`) только если он уже стоит и ваш Mac его поддерживает (Apple Silicon и macOS 15 или новее). Иначе официальный архив с nodejs.org: `bash core/scripts/install-node-user.sh` (Node 24 на macOS 13.5 и новее, Node 22 на macOS 11 - 13.4; sha256 сверяется по SHASUMS256.txt) | архив: `~/.local/node`, пароль не нужен; Homebrew: его системные папки |
| Python 3 | `brew install python` при поддерживаемом Homebrew; иначе Command Line Tools от Apple (`xcode-select --install`, системное окно): они приносят `python3` и git. Запасной путь: установщик со страницы https://www.python.org/downloads/macos/ (двойной щелчок и пароль) | системные папки Apple; пароль вводит человек, если его спросит система |
| git | Command Line Tools от Apple: `xcode-select --install` (системное окно, человек нажимает «Установить») | системные папки |
| Claude Code | официальный установщик `curl -fsSL https://claude.ai/install.sh \| bash` | `~/.local/bin/claude`, `~/.local/share/claude`; установщик может дописать PATH в профиль оболочки |
| Codex CLI | официальный установщик `curl -fsSL https://chatgpt.com/codex/install.sh \| sh` | `~/.local/bin/codex`, `~/.codex/packages/standalone`; PATH в профиль |
| Homebrew | для этой установки не нужен, ИИ его не ставит. На Intel и на macOS ниже 15 он не поддерживается (Tier 3). Если он нужен вам для других программ и ваш Mac его поддерживает, команду берёте на https://brew.sh и запускаете сами | ИИ его не ставит |

Источники: https://code.claude.com/docs/en/setup (Claude Code), https://github.com/openai/codex (Codex), список проверен 21.10.2026. Поддержка Homebrew: https://docs.brew.sh/Installation и https://docs.brew.sh/Support-Tiers (прочитано 21.10.2026): на Apple Silicon поддерживается macOS 15 и новее (11-14 «unsupported but may work»), Mac с процессором Intel это Tier 3, пакеты для Intel больше не собираются, а работу Homebrew на Intel уберут не раньше сентября 2027. Версии Node: BUILDING.md веток v22.x и v24.x репозитория nodejs/node (macOS 11.0 и 13.5), https://nodejs.org/dist/index.json.

## Какой путь у вашего Mac

| Ваш Mac | Homebrew | Node | Python и git |
|---|---|---|---|
| Apple Silicon, macOS 15 или новее, Homebrew уже стоит | поддерживается | `brew install node` | `brew install python`; git через Command Line Tools |
| Apple Silicon, macOS 15 или новее, Homebrew нет | поддерживается, но не нужен | архив nodejs.org в `~/.local/node` | Command Line Tools |
| Apple Silicon, macOS ниже 15 | Tier 3, не предлагаем | архив | Command Line Tools |
| Intel (любая macOS) | Tier 3, не предлагаем; если уже стоит, не трогаем | архив | Command Line Tools |
| macOS ниже 11 | | отказ: у Node 22 и новее такой системы в списке нет | Command Line Tools |

Разведка (`wp.js recon`) пишет замечание «Homebrew для вашего Mac не поддерживается», когда это так, а `wp.js plan` строит шаги по этой таблице.

Запасной путь для Claude Code и Codex: `npm install -g` без sudo. `wp.js install` пробует его сам, если официальный установщик не сработал. Кэш npm идёт в `.workplace/npm-cache` внутри главной папки, а не в `~/.npm`. На Mac Intel с macOS 12 Codex CLI через npm без sudo поставился и запустился.

## Правило PATH

После установки, которая меняет PATH, проверяйте программу в новом окне Терминала или по полному пути. Старое окно может не видеть её.

- Новое окно: `command -v node claude codex git`.
- Полный путь: `~/.local/bin/claude --version`, `~/.local/bin/codex --version`, `~/.local/node/bin/node --version` (если Node поставлен архивом).

Если программы нет и в новом окне: найдите её (`which -a claude`, `ls ~/.local/bin`). Строку PATH для установленных программ дописывает команда `node .workplace/core/cli/wp.js path-fix --yes --human-said "слова человека с «да»"` (запись входит в план установки; `--dry-run` покажет строку, например `export PATH="$HOME/.local/bin:$PATH"` для `~/.zshrc`): она сделает копию профиля и объявит запись. Другую строку PATH или алиас в профиль ИИ добавляет по вашей просьбе: копия профиля, разница «было, стало», ваше «да», правка.

## Профили оболочки

Официальные установщики Claude Code и Codex сами дописывают строку PATH в `~/.zprofile` или `~/.zshrc`. Это нормально. Установка объявляет такую запись заранее и потом проверяет, нет ли дублей строки. Откат делается по вашему «да». Node из архива (`~/.local/node/bin`) в PATH сам не попадает: его строку дописывает `wp.js path-fix --yes --human-said "слова человека с «да»"` (запись входит в план установки) с предупреждением, что эта Node станет первой в новых окнах терминала. Сторожа запускают `node` по PATH, поэтому после записи программу ИИ нужно закрыть и открыть заново в новом окне терминала.

## Порядок

1. Node. Нет Node: смотрите таблицу «Какой путь у вашего Mac». Homebrew уже стоит и поддерживается: `brew install node`. Иначе (Homebrew нет, или он не поддерживается вашим Mac): `bash core/scripts/install-node-user.sh --dry-run` показывает версию и адрес, после «да» `bash core/scripts/install-node-user.sh` скачивает архив с nodejs.org, сверяет sha256 по SHASUMS256.txt (сумма с того же сайта: ловит битую загрузку, не подмену сайта) и распаковывает в `~/.local/node`. Пароль не нужен, двойных щелчков нет. До записи PATH вызывайте Node по полному пути `~/.local/node/bin/node`. Установщик `.pkg` с https://nodejs.org/en/download только запасной путь, если архив не получился (для macOS ниже 13.5 нужна версия 22).
2. Python. Не запускайте `python3` из `/usr/bin`, пока не стоят Command Line Tools: без них это заглушка и она открывает системное окно (разведка сначала проверяет `xcode-select -p`). Без поддерживаемого Homebrew Python приносят Command Line Tools: `xcode-select --install`, в окне нажмите «Установить» и подождите 5 до 15 минут (одно окно ставит и Python 3, и git). Когда `xcode-select -p` напечатал путь, проверьте `/usr/bin/python3 --version` и `wp.js verify P1.python`. Запасной путь: установщик со страницы https://www.python.org/downloads/macos/ (двойной щелчок и пароль; версию берите ту, что поддерживает ваша macOS). С поддерживаемым Homebrew: `brew install python`.
3. git и Command Line Tools. `xcode-select -p` печатает путь: всё стоит. Не печатает: `xcode-select --install`, в окне нажмите «Установить» и подождите 5 до 15 минут (может спросить пароль). Потом `git --version`.
4. Claude Code. Если консольной копии нет, `wp.js install claude --yes --human-said "слова человека с «да»"`. Уже стоящую копию обновляют по вашему «да»: `claude update` ставит только родную копию (`~/.local/bin`), копии из `/usr/local/bin`, npm или Homebrew обновляются тем способом, которым поставлены.
5. Codex CLI. `wp.js install codex --yes --human-said "слова человека с «да»"`. Расширение Codex в VS Code консольную программу не заменяет.
6. Входы. Codex: `codex login` (откроется браузер, войдите в ChatGPT). Нет браузера: `codex login --device-auth`. Claude Code: `claude auth login`. Проверка: `codex login status` и `wp.js verify P1.main-login P1.reviewer-login --live`. Нужна подписка: Claude Pro или выше, ChatGPT Plus или выше. Вход по платному ключу API не используется.

## Особенности Mac

- macOS ниже 13: Claude Code официально не поддерживает. Установщик пишет предупреждение, но не останавливается.
- Системные окна. macOS может спросить доступ Терминала или VS Code к папкам «Документы», «Рабочий стол», «Загрузки». Это решение человека. Проще держать главную папку в домашней папке, вне «Документов» и iCloud.
- Файл не открывается двойным щелчком («приложение повреждено», «нельзя проверить разработчика»). В пакете нет файлов для двойного щелчка. Если такой файл у вас всё же есть, ИИ запускает его командой `bash путь-к-файлу`: проверка Gatekeeper контролирует только запуск из Finder.
- Вход открылся не в том браузере. Скопируйте адрес со страницы входа в нужный браузер и войдите там.
