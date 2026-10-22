'use strict';
// Маскирование персональных данных: почты, телефоны (из cross-check/lib.js v3) и пути с именем пользователя (для отчёта).
const secrets = require('./secrets-scan');

// Почта: оставляем первую букву и домен (домен нужен для проверки фактов): i***@company.ru
// Телефон: оставляем последние две цифры. Длинные числа без разделителей и без плюса (ИНН, ОГРН) не трогаем.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;
// Дата или метка времени, которую PHONE_RE иначе принимал бы за телефон («2026-10-21 19», «10.10.2025 12», «20261021-191550»). Дефект v3, найден при сборке отчёта.
const DATE_LIKE = /^(\d{4}-\d{2}-\d{2}|\d{1,2}[.\/]\d{1,2}[.\/]\d{2,4}|\d{8}-\d{4,6})(?!\d)/;
const PHONE_RE = /(?<![\w.@])(\+?\d[\d\s().-]{8,}\d)(?![\w@])/g;

// code = true: файл с кодом. Почты маскируем, телефоны только с «+» или разделителями (голые числа в коде это числа, а не телефоны).
function maskText(text, code) {
  let emails = 0, phones = 0;
  let out = String(text).replace(EMAIL_RE, (m, domain) => { emails++; return m[0] + '***@' + domain; });
  out = out.replace(PHONE_RE, (m) => {
    if (DATE_LIKE.test(m.trim())) return m;   // дата и время, а не телефон
    const digits = m.replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 15) return m;
    const hasSep = /[\s().-]/.test(m);
    const hasPlus = m.startsWith('+');
    const ruLike = digits.length === 11 && (digits[0] === '7' || digits[0] === '8');
    if (!hasPlus && !hasSep && !ruLike) return m;      // похоже на ИНН или другой номер документа
    if (code && !hasPlus && !hasSep) return m;         // в коде голое число: не телефон
    if (!hasPlus && hasSep && /^\d{1,3}(\s\d{3})+$/.test(m.trim())) return m;   // «1 234 567 890»: число с пробелами
    phones++;
    return '+*** *** ** ' + digits.slice(-2);
  });
  return { text: out, emails, phones };
}

// Для отчёта установки: пути вида /Users/<имя>/..., C:\Users\<имя>\... становятся ~/...; почты маскируются.
function maskPaths(text) {
  return String(text)
    .replace(/[A-Za-z]:[\\/]Users[\\/][^\\/\s"'`|)]+/gi, '~')
    .replace(/\/(?:Users|home)\/[^/\s"'`|)]+/g, '~');
}
// В отчёте маскируются пути и почты. Телефоны не ищутся: у отчёта установки их нет, а ищущий их образец принимал за телефон даты и время («2026-10-21 19:15»,
// «20261021-191550»): так искажалась метка копии обновления. (Дефект проявился при повторном использовании maskText из v3 для отчёта.)
function maskReport(text) {
  return maskPaths(text).replace(EMAIL_RE, (m, domain) => m[0] + '***@' + domain);
}

// Проверка готового отчёта (G8): что в нём остались личные данные. Возвращает список проблем (пусто = чисто).
function reportProblems(text) {
  const t = String(text);
  const p = [];
  if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(t)) p.push('в отчёте есть почта');
  if (/\/Users\/[^/\s]+\//.test(t) || /[A-Za-z]:[\\/]Users[\\/][^\\/\s]+/i.test(t) || /\/home\/[^/\s]+\//.test(t)) p.push('в отчёте есть путь с именем пользователя');
  if (secrets.hasSecret(t, { allowPlaceholders: false })) p.push('в отчёте есть строка, похожая на ключ или пароль');
  return p;
}

module.exports = { maskText, maskPaths, maskReport, reportProblems, EMAIL_RE, PHONE_RE };
