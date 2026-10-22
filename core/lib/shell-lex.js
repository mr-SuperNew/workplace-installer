/**
 * shell-lex.js - общий лексер shell-команд (Bash и PowerShell) для сторожей-хуков.
 * Копия проверенного лексера из рабочей системы автора пакета: код функций не изменён, заменён только этот заголовок.
 * Менять тело функций можно только вместе с прогоном tests/unit/ сторожей.
 *
 * lex(src, mode) -> { stages:[{words:[{t,q,op}], stmt, here:[{body}]}], subs:[код $(...) и `...`] }
 *   mode 'sh' | 'ps'; stage = простая команда; stmt растёт на  ;  перевод строки  &&  ||  &; конвейер (|) остаётся в том же stmt.
 * Позиция слова в stage решает, команда это или текст: grep/echo/commit -m "..." не исполняют свои аргументы.
 */
'use strict';
const os = require('os');
const path = require('path');

// ------------------------------------ лексер ----------------------------------------------------
const isWs = (c) => c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v';

/** s[i] === '(' -> индекс парной ')' (или s.length). Кавычки без пары считаются обычным символом. */
function matchParen(s, i) {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === "'" || c === '"') {
      const e = s.indexOf(c, j + 1);
      if (e >= 0) { j = e; continue; }
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return j; }
  }
  return s.length;
}

/**
 * Разбор строки команды на стадии (stage = одна простая команда). stmt — номер оператора (растёт на ; \n && || &),
 * конвейер (|) остаётся в том же stmt. Скобки и фигурные скобки разделяют стадии, но stmt не меняют.
 * Возвращает { stages: [{ words:[{t,q,op}], stmt, here:[{body}], depth }], subs: [код подстановок $(...) / `...`] }.
 */
function lex(src, mode) {
  const ps = mode === 'ps';
  const n = src.length;
  const stages = [];
  const subs = [];
  let words = [];
  let here = [];
  let pending = [];
  let cur = '';
  let has = false;
  let q = false;
  let stmt = 0;
  let pdepth = 0;      // вложенность круглых скобок: `(cd папка && команда) > файл` - cd действует только внутри скобок
  let i = 0;
  const endWord = () => { if (has) words.push({ t: cur, q }); cur = ''; has = false; q = false; };
  const endStage = (inc) => {
    endWord();
    if (words.length) stages.push({ words, stmt, here, depth: pdepth });
    words = []; here = [];
    if (inc) stmt++;
  };

  while (i < n) {
    const c = src[i];
    const nx = src[i + 1];

    if (c === '\n') {
      endStage(true);
      i++;
      if (pending.length) {
        for (const p of pending) {
          const body = [];
          let pos = i;
          while (pos < n) {
            const le = src.indexOf('\n', pos);
            const line = src.slice(pos, le < 0 ? n : le).replace(/\r$/, '');
            pos = le < 0 ? n : le + 1;
            const cmp = p.strip ? line.replace(/^\t+/, '') : line;
            if (cmp === p.delim) break;
            body.push(line);
          }
          p.ref.body = body.join('\n');
          i = pos;
        }
        pending = [];
      }
      continue;
    }
    if (isWs(c)) { endWord(); i++; continue; }

    // продолжение строки
    if (!ps && c === '\\' && (nx === '\n' || (nx === '\r' && src[i + 2] === '\n'))) { i += nx === '\n' ? 2 : 3; continue; }
    if (ps && c === '`' && (nx === '\n' || (nx === '\r' && src[i + 2] === '\n'))) { i += nx === '\n' ? 2 : 3; continue; }

    // комментарии
    if (c === '#' && !has) { while (i < n && src[i] !== '\n') i++; continue; }
    if (ps && c === '<' && nx === '#' && !has) { const e = src.indexOf('#>', i + 2); i = e < 0 ? n : e + 2; continue; }

    // here-string PowerShell: @'  ...  '@  /  @"  ...  "@
    if (ps && c === '@' && (nx === "'" || nx === '"') && /^\r?\n/.test(src.slice(i + 2, i + 4))) {
      const close = '\n' + nx + '@';
      const e = src.indexOf(close, i + 2);
      const bodyStart = src.indexOf('\n', i + 2) + 1;
      cur += src.slice(bodyStart, e < 0 ? n : e).replace(/\r$/, '');
      has = true; q = true;
      i = e < 0 ? n : e + close.length;
      continue;
    }

    if (c === "'") {
      has = true; q = true; i++;
      while (i < n) {
        if (src[i] === "'") {
          if (ps && src[i + 1] === "'") { cur += "'"; i += 2; continue; }
          break;
        }
        cur += src[i++];
      }
      i++;
      continue;
    }

    if (c === '"') {
      has = true; q = true; i++;
      while (i < n) {
        const d = src[i];
        if (d === '"') {
          if (ps && src[i + 1] === '"') { cur += '"'; i += 2; continue; }
          break;
        }
        if (!ps && d === '\\' && i + 1 < n && '"\\$`\n'.includes(src[i + 1])) { if (src[i + 1] !== '\n') cur += src[i + 1]; i += 2; continue; }
        if (ps && d === '`' && i + 1 < n) { cur += src[i + 1]; i += 2; continue; }
        if (d === '$' && src[i + 1] === '(') {
          const e = matchParen(src, i + 1);
          subs.push(src.slice(i + 2, e));
          cur += src.slice(i, e + 1);
          i = e + 1;
          continue;
        }
        if (!ps && d === '`') {
          const e = src.indexOf('`', i + 1);
          const end = e < 0 ? n : e;
          subs.push(src.slice(i + 1, end));
          cur += src.slice(i, end + 1);
          i = end + 1;
          continue;
        }
        cur += d; i++;
      }
      i++;
      continue;
    }

    if (c === '$') {
      if (nx === '(') {
        const e = matchParen(src, i + 1);
        subs.push(src.slice(i + 2, e));
        cur += src.slice(i, e + 1); has = true;
        i = e + 1;
        continue;
      }
      if (nx === '{') {
        const e = src.indexOf('}', i + 2);
        const end = e < 0 ? n : e;
        cur += src.slice(i, end + 1); has = true;
        i = end + 1;
        continue;
      }
      cur += c; has = true; i++;
      continue;
    }

    if (c === '`') {
      if (ps) { if (i + 1 < n) { cur += src[i + 1]; has = true; } i += 2; continue; }
      const e = src.indexOf('`', i + 1);
      const end = e < 0 ? n : e;
      subs.push(src.slice(i + 1, end));
      cur += src.slice(i, end + 1); has = true;
      i = end + 1;
      continue;
    }

    if (c === '\\' && !ps) {
      if (i + 1 < n && ' "\'$;&|()<>`'.includes(src[i + 1])) { cur += src[i + 1]; has = true; i += 2; continue; }
      cur += c; has = true; i++;
      continue;
    }

    if (c === ';') { endStage(true); i++; continue; }

    if (c === '&') {
      if (nx === '&') { endStage(true); i += 2; continue; }
      if (nx === '>') { endWord(); words.push({ t: '&>', q: false, op: true }); i += 2; if (src[i] === '>') i++; continue; }
      if (ps && !has && words.length === 0) { words.push({ t: '&', q: false }); i++; continue; }
      endStage(true); i++;
      continue;
    }

    if (c === '|') {
      if (nx === '|') { endStage(true); i += 2; continue; }
      endStage(false); i++;
      if (src[i] === '&') i++;
      continue;
    }

    if (c === '(' || c === ')') { endStage(false); pdepth = c === '(' ? pdepth + 1 : Math.max(0, pdepth - 1); i++; continue; }

    if (c === '{') {
      if (ps || (!has && (nx === undefined || isWs(nx) || nx === '\n' || nx === ';'))) { endStage(false); i++; continue; }
      cur += c; has = true; i++;
      continue;
    }
    if (c === '}') {
      if (ps || (!has && (i === 0 || isWs(src[i - 1]) || src[i - 1] === ';' || src[i - 1] === '\n'))) { endStage(false); i++; continue; }
      cur += c; has = true; i++;
      continue;
    }

    if (c === '<' || c === '>') {
      if (has && !q && /^\d+$/.test(cur)) { cur = ''; has = false; } else endWord();
      let op = c; i++;
      if (src[i] === c) {
        op += c; i++;
        if (c === '<' && src[i] === '<') { op += '<'; i++; }
        else if (c === '<' && src[i] === '-' && !ps) { op += '-'; i++; }
      }
      if (c === '>' && src[i] === '|') { op += '|'; i++; }
      if (src[i] === '&') { op += '&'; i++; while (i < n && /[\d-]/.test(src[i])) op += src[i++]; }
      words.push({ t: op, q: false, op: true });
      if (!ps && (op === '<<' || op === '<<-')) {
        while (i < n && isWs(src[i])) i++;
        let delim = '';
        const quote = src[i] === "'" || src[i] === '"' ? src[i] : null;
        if (quote) i++;
        while (i < n && (quote ? src[i] !== quote : !/[\s;&|()<>]/.test(src[i]))) delim += src[i++];
        if (quote) i++;
        const ref = { body: '' };
        here.push(ref);
        pending.push({ ref, delim, strip: op === '<<-' });
      }
      continue;
    }

    cur += c; has = true; i++;
  }
  endStage(false);
  return { stages, subs };
}

// --------------------------------- вспомогательное ---------------------------------------------
/** Слова стадии без перенаправлений: { args, redirs:[{op,target}] }. */
function splitRedirects(words) {
  const args = [];
  const redirs = [];
  for (let k = 0; k < words.length; k++) {
    const w = words[k];
    if (w.op) {
      if (/^(&?>>?\|?|<)$/.test(w.t) && k + 1 < words.length) { redirs.push({ op: w.t, target: words[k + 1].t }); k++; }
      continue;
    }
    args.push(w);
  }
  return { args, redirs };
}

function baseName(t) {
  return String(t).replace(/\\/g, '/').split('/').pop().toLowerCase().replace(/^@/, '');
}
function cmdKey(t) { return baseName(t).replace(/\.exe$/, ''); }

function resolvePath(p, cwd) {
  let s = String(p).replace(/\\/g, '/');
  s = s.replace(/^\/([a-zA-Z])\//, '$1:/');
  if (/^~\//.test(s)) s = path.join(os.homedir(), s.slice(2)).replace(/\\/g, '/');
  if (!/^[a-zA-Z]:\//.test(s) && !s.startsWith('/')) s = path.resolve(cwd || process.cwd(), s).replace(/\\/g, '/');
  return s;
}

module.exports = { lex, splitRedirects, baseName, cmdKey, resolvePath, matchParen, isWs };
