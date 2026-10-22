'use strict';
// Охрана записи: любой путь записи обязан остаться внутри корня по realpath (ссылка или junction наружу, даже внутри корня, это отказ).
// Основа - guard() из v3 setup.js, вынесена в модуль. Ошибки бросаются как WpError с кодом 3.
const fs = require('fs');
const path = require('path');
const u = require('./util');

function makeGuard(root) {
  function guard(p) {
    let realRoot;
    try { realRoot = fs.realpathSync.native(root); } catch (_) { return; }   // корня на диске ещё нет (первый шаг init): проверять нечего
    let cur = path.resolve(p);
    for (;;) {
      let rp = null;
      try { rp = fs.realpathSync.native(cur); } catch (_) { rp = null; }
      if (rp !== null) {
        if (!u.within(realRoot, rp)) throw new u.WpError('Запись отменена: ' + p + ' ведёт за пределы корня (ссылка или junction). Корень: ' + root + '. Ничего не записано.', 3);
        return;
      }
      let dangling = false; try { fs.lstatSync(cur); dangling = true; } catch (_) { /* пути нет */ }
      if (dangling) throw new u.WpError('Запись отменена: ' + p + ' это битая ссылка. Ничего не записано.', 3);
      const up = path.dirname(cur);
      if (up === cur) return;
      cur = up;
    }
  }
  return {
    root,
    guard,
    mk(dir) { guard(dir); fs.mkdirSync(dir, { recursive: true }); },
    wf(p, data, o) { guard(p); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data, o); },
    cf(src, dst) { guard(dst); fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); },
    af(p, data) { guard(p); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.appendFileSync(p, data); },
    rel(p) { return path.relative(root, p).split(path.sep).join('/') || '.'; },
  };
}

module.exports = { makeGuard };
