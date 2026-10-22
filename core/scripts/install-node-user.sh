#!/bin/sh
# Node.js (LTS) из официального архива nodejs.org в папку пользователя: без Homebrew, без прав администратора, без двойных щелчков.
# Только macOS. Скачивает SHASUMS256.txt и архив .tar.gz с https://nodejs.org/dist/latest-vN.x/, сверяет sha256 и распаковывает в ~/.local/node.
# PATH и профили оболочки не трогает: пути вызывает человек по «да» командой `wp.js path-fix --yes`.
# Нужны только то, что есть в macOS: sh, curl, tar, grep, awk, shasum.
#
# Какую версию брать (источники: BUILDING.md веток v22.x и v24.x репозитория nodejs/node, прочитаны 21.10.2026):
#   macOS 13.5 и новее  -> Node 24 (текущий LTS; бинарники собраны под macOS 13.5)
#   macOS с 11 до 13.4  -> Node 22 (LTS в режиме поддержки; бинарники собраны под macOS 11.0)
#   macOS ниже 11       -> отказ: у Node 22 и новее такой системы в списке нет
#
# Запуск: bash install-node-user.sh [--dry-run] [--major 22|24] [--arch arm64|x64] [--dest ПАПКА]
#   --dry-run  ничего не скачивает и не пишет, печатает план (первая строка начинается с «ПЛАН:»)
#   --macos-version и переменная WP_NODE_TEST=1 нужны только тестам пакета.
# Коды выхода: 0 готово (или уже стоит), 1 ошибка, 2 неверные параметры, 3 контрольная сумма не совпала.
set -eu

DRY=0
MAJOR=""
ARCH=""
MACOS=""
DEST="${HOME}/.local/node"

fail() { code=$1; shift; echo "Ошибка: $*" >&2; exit "$code"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --major) [ $# -ge 2 ] || fail 2 "после --major нужно число"; MAJOR=$2; shift ;;
    --arch) [ $# -ge 2 ] || fail 2 "после --arch нужно arm64 или x64"; ARCH=$2; shift ;;
    --dest) [ $# -ge 2 ] || fail 2 "после --dest нужна папка"; DEST=$2; shift ;;
    --macos-version) [ $# -ge 2 ] || fail 2 "после --macos-version нужна версия"; MACOS=$2; shift ;;
    *) fail 2 "неизвестный параметр $1" ;;
  esac
  shift
done

if [ "${WP_NODE_TEST:-}" != "1" ] && [ "$(uname -s)" != "Darwin" ]; then
  fail 1 "скрипт только для macOS; на Windows Node ставит winget"
fi

# процессор: терминал под Rosetta на Apple Silicon показывает x86_64, но настоящий процессор arm64
if [ -z "$ARCH" ]; then
  case "$(uname -m)" in
    arm64|aarch64) ARCH=arm64 ;;
    x86_64)
      ARCH=x64
      if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = "1" ]; then ARCH=arm64; fi ;;
    *) fail 1 "процессор $(uname -m) не поддерживается" ;;
  esac
fi
case "$ARCH" in arm64|x64) ;; *) fail 2 "--arch: можно arm64 или x64" ;; esac

# версия macOS: из sw_vers, если не задана
[ -n "$MACOS" ] || MACOS=$(sw_vers -productVersion)
mac_major=${MACOS%%.*}
mac_rest=${MACOS#*.}
if [ "$mac_rest" = "$MACOS" ]; then mac_minor=0; else mac_minor=${mac_rest%%.*}; fi
case "$mac_major$mac_minor" in *[!0-9]*|"") fail 1 "не удалось разобрать версию macOS «$MACOS»" ;; esac

# Node 24 нужна macOS 13.5 или новее; Node 22 нужна macOS 11 или новее
if [ "$mac_major" -gt 13 ] || { [ "$mac_major" -eq 13 ] && [ "$mac_minor" -ge 5 ]; }; then
  auto=24
elif [ "$mac_major" -ge 11 ]; then
  auto=22
else
  fail 1 "macOS $MACOS слишком старая: у Node 22 и новее минимум macOS 11. Обновите macOS до 11 или новее. Если обновить нельзя, ИИ скажет об этом одной фразой и предложит, что делать дальше."
fi
if [ -z "$MAJOR" ]; then
  MAJOR=$auto
else
  case "$MAJOR" in *[!0-9]*|"") fail 2 "--major: нужно число (22 или 24)" ;; esac
  if [ "$MAJOR" -ge 24 ] && [ "$auto" -lt 24 ]; then
    fail 1 "Node $MAJOR не работает на macOS $MACOS (нужна 13.5 или новее): возьмите --major 22"
  fi
fi

BASE="https://nodejs.org/dist/latest-v${MAJOR}.x"
echo "ПЛАН: Node $MAJOR (LTS), macOS $MACOS, процессор $ARCH, архив с $BASE/, папка $DEST. Права администратора не нужны, PATH не меняется."
if [ "$DRY" = "1" ]; then
  echo "Пробный запуск: ничего не скачано и не записано."
  exit 0
fi

# уже стоит: ничего не затираем
if [ -x "$DEST/bin/node" ]; then
  echo "Node уже стоит в $DEST ($("$DEST/bin/node" --version)): не переустанавливаю."
  exit 0
fi
if [ -e "$DEST" ] && [ -n "$(ls -A "$DEST" 2>/dev/null)" ]; then
  fail 1 "папка $DEST не пуста и в ней нет Node: ничего не трогаю. Укажите другую папку через --dest."
fi

for tool in curl tar grep awk; do
  command -v "$tool" >/dev/null 2>&1 || fail 1 "нет команды $tool"
done
if command -v shasum >/dev/null 2>&1; then SHA="shasum -a 256"
elif command -v sha256sum >/dev/null 2>&1; then SHA="sha256sum"
else fail 1 "нет команды shasum (sha256sum): сверить контрольную сумму нечем"; fi

WORK=$(mktemp -d "${TMPDIR:-/tmp}/wp-node.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

curl -fsSL --retry 2 -o "$WORK/SHASUMS256.txt" "$BASE/SHASUMS256.txt" || fail 1 "не скачался $BASE/SHASUMS256.txt (нет сети или сайт недоступен)"
LINE=$(grep -E "  node-v[0-9]+\.[0-9]+\.[0-9]+-darwin-${ARCH}\.tar\.gz\$" "$WORK/SHASUMS256.txt" || true)
[ -n "$LINE" ] || fail 1 "в SHASUMS256.txt нет архива node-v*-darwin-${ARCH}.tar.gz"
[ "$(printf '%s\n' "$LINE" | wc -l | tr -d ' ')" = "1" ] || fail 1 "в SHASUMS256.txt несколько подходящих строк: не гадаю"
WANT=$(printf '%s\n' "$LINE" | awk '{print $1}')
FILE=$(printf '%s\n' "$LINE" | awk '{print $2}')
echo "Скачиваю $FILE"
curl -fsSL --retry 2 -o "$WORK/$FILE" "$BASE/$FILE" || fail 1 "не скачался $BASE/$FILE"

GOT=$($SHA "$WORK/$FILE" | awk '{print $1}')
if [ "$GOT" != "$WANT" ]; then
  fail 3 "контрольная сумма не совпала (ждали $WANT, получили $GOT): ничего не распаковано, ничего не записано. Не повторяйте много раз: покажите это человеку."
fi
echo "Контрольная сумма совпала со строкой SHASUMS256.txt с nodejs.org (sha256 $GOT)."

mkdir -p "$DEST"
tar -xzf - -C "$DEST" --strip-components=1 < "$WORK/$FILE" || fail 1 "архив не распаковался в $DEST"
VER=$("$DEST/bin/node" --version 2>/dev/null || true)
case "$VER" in "v${MAJOR}."*) ;; *) fail 1 "после распаковки $DEST/bin/node не запускается или другой версии («$VER»)" ;; esac
echo "Готово: Node $VER лежит в $DEST/bin/node. PATH и профили оболочки не менялись."
echo "До записи PATH вызывай Node по полному пути: $DEST/bin/node. Строку PATH в профиль допишет только 'wp.js path-fix --yes' по «да» человека."
