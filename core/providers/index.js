'use strict';
// Реестр провайдеров: ядро обращается к провайдеру по имени из config.json (main, reviewer).
const claude = require('./claude');
const codex = require('./codex');

const all = { claude, codex };
function get(name) {
  if (!all[name]) throw new Error('Неизвестный провайдер: ' + name + ' (есть: claude, codex)');
  return all[name];
}
function other(name) { return get(name === 'claude' ? 'codex' : 'claude'); }

module.exports = { all, get, other, names: Object.keys(all) };
