'use strict';
// Что поддерживается на Mac: Homebrew и какая версия Node подходит. Чистые функции, ничего не запускают и не пишут (тестируются на любой системе).
// Вход o = { platform, version, arch, apple_silicon }: version это macOS ('12.7.6'), arch это process.arch ('arm64' | 'x64'),
// apple_silicon (из разведки) надёжнее arch: Node под Rosetta на Apple Silicon сообщает x64.
//
// Источники (прочитаны 21.10.2026):
//  - https://docs.brew.sh/Installation, раздел «macOS requirements»: «An Apple Silicon CPU; using a 64-bit Intel CPU is a Tier 3 configuration»,
//    «macOS Sequoia (15) (or higher) installed on officially supported hardware»; сноска 2: «On Apple Silicon, macOS 15 (Sequoia) through 27 (Golden Gate) is best and
//    supported; macOS 11 (Big Sur) - 14 (Sonoma) are unsupported but may work. All Intel Mac configurations that can run Homebrew ... are Tier 3»;
//    сноска 3: «Intel macOS also requires developer tools for bottle installation».
//  - https://docs.brew.sh/Support-Tiers, раздел «Future macOS support»: «Homebrew has stopped building new bottles for Intel systems, and will remove the ability to run
//    Homebrew on Intel systems in or after September 2027»; Tier 3 «is not supported ... may fail to function reliably».
//  - Node: BUILDING.md веток v24.x («macOS x64 и arm64: >= 13.5») и v22.x («>= 11.0») репозитория nodejs/node; https://nodejs.org/dist/index.json: 24 (Krypton) и 22 (Jod) LTS.
const u = require('./util');

const BREW_MIN_MACOS = [15, 0, 0];
const NODE_NEW = { major: 24, minMacos: [13, 5, 0] };    // текущий LTS
const NODE_OLD = { major: 22, minMacos: [11, 0, 0] };    // LTS в режиме поддержки, собран под macOS 11

function isAppleSilicon(o) { return o.apple_silicon !== undefined && o.apple_silicon !== null ? !!o.apple_silicon : o.arch === 'arm64'; }

// Поддерживает ли Homebrew этот Mac. { supported, why }
function brewSupport(o) {
  o = o || {};
  if (o.platform !== 'darwin') return { supported: false, why: 'это не Mac' };
  if (!isAppleSilicon(o)) return { supported: false, why: 'Mac с процессором Intel: Homebrew относит его к Tier 3 (без поддержки: пакеты для Intel больше не собираются, а работу на Intel уберут в сентябре 2027 или позже; источник docs.brew.sh, 21.10.2026)' };
  const v = u.ver(o.version);
  if (!v) return { supported: false, why: 'версия macOS не определена, поддержку Homebrew подтвердить нельзя' };
  if (!u.atLeast(v, BREW_MIN_MACOS)) return { supported: false, why: 'macOS ' + o.version + ' на Apple Silicon: Homebrew поддерживает только macOS 15 и новее (ниже это «может работать», но без гарантий; источник docs.brew.sh, 21.10.2026)' };
  return { supported: true, why: '' };
}

// Какой Node брать архивом с nodejs.org. major: 24 | 22 | null (версия macOS неизвестна: скрипт определит сам); ok: false, если macOS слишком старая.
function nodeArchive(o) {
  o = o || {};
  const arch = isAppleSilicon(o) ? 'arm64' : 'x64';
  const v = u.ver(o.version);
  if (!v) return { major: null, arch, ok: true };
  if (u.atLeast(v, NODE_NEW.minMacos)) return { major: NODE_NEW.major, arch, ok: true };
  if (u.atLeast(v, NODE_OLD.minMacos)) return { major: NODE_OLD.major, arch, ok: true };
  return { major: null, arch, ok: false, why: 'macOS ' + o.version + ' ниже 11: у Node 22 и новее такой системы в списке поддерживаемых нет' };
}

module.exports = { brewSupport, nodeArchive, isAppleSilicon, BREW_MIN_MACOS, NODE_NEW, NODE_OLD };
