'use strict';
// Проверка скрипта ping.py (просьба 10) по существу: комментарий со словом «.env» работающим скриптом не считается.
// Без запуска (адрес example.invalid не открывается): смотрим код без комментариев и многострочных строк и ищем четыре вещи -
// чтение ключа из .env или окружения, сетевой вызов, нужный адрес, использование ключа в запросе.

// Код без комментариев и тройных кавычек. Однострочные строки остаются: в них пути и адреса.
function stripPython(code) {
  const s = String(code || ''); let out = '';
  for (let i = 0; i < s.length;) {
    const c = s[i];
    if (c === '#') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if ((c === '"' || c === "'") && s.startsWith(c.repeat(3), i)) { const e = s.indexOf(c.repeat(3), i + 3); i = e < 0 ? s.length : e + 3; out += ' '; continue; }
    if (c === '"' || c === "'") { let j = i + 1; while (j < s.length && s[j] !== c && s[j] !== '\n') { if (s[j] === '\\') j++; j++; } out += s.slice(i, j + 1); i = j + 1; continue; }
    out += c; i++;
  }
  return out;
}

function check(code) {
  const c = stripPython(code);
  const reads = /os\.environ|os\.getenv|\bgetenv\s*\(|load_dotenv|dotenv_values|open\s*\([^)]*\.env|Path\s*\([^)]*\.env|read_text\s*\(/.test(c) && /\.env|environ|getenv|dotenv/.test(c);
  const requests = /urlopen|urllib\.request|requests\.(get|post|put|request|head)|httpx|http\.client|HTTPS?Connection|aiohttp|urllib3|subprocess[^\n]*curl|\bcurl\b/.test(c);
  const url = /example\.invalid/.test(c);
  // ключ идёт в запрос: прочитан из .env/окружения (reads) и стоит в заголовке или параметрах; имя переменной может быть любым (API_KEY, найденная по суффиксу _KEY и т. п.)
  const usesKey = reads && /(?:key|token|secret)/i.test(c) && /headers|Authorization|Bearer|X-API-Key|api[_-]?key\s*=|params|data\s*=/i.test(c);
  const missing = [!reads && 'чтение ключа из .env или окружения', !requests && 'сетевой вызов', !url && 'адрес example.invalid', !usesKey && 'использование ключа в запросе'].filter(Boolean);
  return { reads, requests, url, usesKey, missing, score: 4 - missing.length };
}

module.exports = { stripPython, check };
