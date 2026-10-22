'use strict';
// Поиск секретов в тексте и по именам файлов. Образцы взяты из cross-check/scripts/lib.js (v3), дополнены.
// Ничего не возвращает из значений: только номер строки и название класса. Значение секрета нигде не печатается.

// Точные образцы: годятся для запрета записи (сторож секретов) и отказа передать файл проверяющему.
const SECRET_PATTERNS = [
  ['закрытый ключ', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['ключ sk-...', /\bsk-[A-Za-z0-9_-]{20,}/],
  ['ключ AWS', /\bAKIA[0-9A-Z]{16}\b/],
  ['токен GitHub', /\bgh[pousr]_[A-Za-z0-9]{30,}/],
  ['токен GitHub (fine-grained)', /\bgithub_pat_[A-Za-z0-9_]{30,}/],
  ['токен GitLab', /\bglpat-[A-Za-z0-9_-]{15,}/],
  ['токен npm', /\bnpm_[A-Za-z0-9]{30,}/],
  ['токен Slack', /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ['ключ Google', /\bAIza[0-9A-Za-z_-]{35}/],
  ['токен бота Telegram', /\b\d{8,10}:[A-Za-z0-9_-]{34,}/],
  // Допустима кавычка после имени: JSON "password": "значение".
  ['пароль или ключ в присвоении', /\b(api[_-]?key|secret|token|passw(or)?d|passwd)\b['"]?\s*[:=]\s*['"][^'"\s]{12,}['"]/i],
  // Строка вида ИМЯ_ПАРОЛЯ=значение без кавычек (файлы .env, export в оболочке): только имена в верхнем регистре, чтобы не ловить прозу.
  ['пароль или ключ в строке окружения', /^\s*(?:export\s+)?[A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY)[A-Z0-9_]*\s*=\s*[^\s'"#]{12,}\s*$/m],
];

// Присвоение без кавычек (YAML, ini, .properties): `password: Xk92mPq7Lz4wR1`. Ловится только строка целиком «имя: значение» (после значения допустим комментарий),
// чтобы не задевать документацию и прозу. Значение считается секретом, если оно похоже на пароль, а не на слово или код:
//  - не короче 12 знаков, без пробелов и скобок, есть и буква, и цифра (проза вроде «token: expired» и «password: configuration» не подходит);
//  - не заглушка (<...>, ${...}, %...%, YOUR_..., changeme, example...), не путь к переменной вида process.env.X или config.token1, не ссылка без пароля внутри.
const BARE_ASSIGN = /^\s*(?:[-*]\s+)?(?:export\s+)?["']?[\w.-]*?(?:passw(?:or)?d|passwd|secret|token|api[_-]?key|private[_-]?key)[\w.-]*["']?\s*[:=]\s*([^\s'"#,;]{12,})\s*(?:(?:#|\/\/).*)?$/i;
// То же внутри строки команды: перед именем пробел или кавычка, после значения конец строки, пробел, кавычка, `\n` печатающей команды, запятая или `;`.
const BARE_IN_COMMAND = /(?:^|[\s'"])[\w.-]*?(?:passw(?:or)?d|passwd|secret|token|api[_-]?key|private[_-]?key)[\w.-]*['"]?\s*[:=]\s*([^\s'"#,;\\]{12,})(?:\\[nr]|['"\s,;]|$)/i;
function bareValueLooksSecret(v) {
  if (!/[A-Za-z]/.test(v) || !/\d/.test(v)) return false;
  if (/^[<\[{(\$%@*]/.test(v) || /[()<>{}\[\]]/.test(v)) return false;           // заглушка, подстановка, вызов функции
  if (/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/.test(v)) return false;                  // process.env.X, config.token1
  if (/^(?:[\/~.]|[A-Za-z]:[\\\/])/.test(v)) return false;                        // путь к файлу
  if (/^https?:\/\//i.test(v) && !/\/\/[^\s\/@:]+:[^\s\/@]+@/.test(v)) return false;   // ссылка без пароля внутри
  return true;
}

// Значения-заглушки в документации и примерах: не секрет.
const PLACEHOLDER = /^(your[_-]|<|\$\{?|xxx|\*{3,}|\.{3}|changeme|example|placeholder|todo|вставьте|ваш|ключ_|пароль_)/i;
const PLACEHOLDER_ANYWHERE = /YOUR[_-]?(API[_-]?)?(KEY|TOKEN|SECRET|PASSWORD)|<(your|ваш)[^>]*>|вставьте_ключ|REDACTED|\bexample\b.*\b(key|token)\b/i;

function isPlaceholderLine(line) {
  const m = line.match(/[:=]\s*['"]?([^'"\s]+)['"]?/);
  if (m && PLACEHOLDER.test(m[1])) return true;
  return PLACEHOLDER_ANYWHERE.test(line);
}

// opts.allowPlaceholders (по умолчанию да): строки с заглушками вроде YOUR_KEY_HERE и «example» не считаются секретом.
function scanSecrets(text, opts) {
  const allow = !opts || opts.allowPlaceholders !== false;
  const hits = [];
  String(text).split(/\r?\n/).forEach((line, i) => {
    let hit = false;
    for (const [name, re] of SECRET_PATTERNS) {
      if (!re.test(line)) continue;
      hit = true;
      if (allow && isPlaceholderLine(line)) break;
      hits.push({ line: i + 1, kind: name });
      break;
    }
    if (!hit) {
      let m = BARE_ASSIGN.exec(line);
      // Текст shell-команды (opts.shell): секрет может стоять внутри echo или printf, а не в начале строки: `printf 'password: значение\n' > cfg.yml`.
      if (!m && opts && opts.shell) m = BARE_IN_COMMAND.exec(line);
      if (m && bareValueLooksSecret(m[1]) && !(allow && isPlaceholderLine(line))) hits.push({ line: i + 1, kind: 'пароль или ключ в присвоении без кавычек' });
    }
  });
  return hits;
}
function hasSecret(text, opts) { return scanSecrets(text, opts).length > 0; }

// Широкая эвристика «похоже на ключ или пароль»: для решения «копию файла не делать, хранить только хеш» (v3: SECRET_LIKE). Намеренно широкая.
const SECRET_LIKE = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/, /\bgithub_pat_[A-Za-z0-9_]{20,}/, /\bglpat-[A-Za-z0-9_-]{15,}/, /\bnpm_[A-Za-z0-9]{20,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/, /\bAIza[0-9A-Za-z_-]{30,}/,
  /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}\./,
  /\bBearer\s+[A-Za-z0-9._~+\/=-]{12,}/i,
  /\/\/[^\s\/@:]+:[^\s\/@]+@/,
  /(?:api[_-]?key|secret|token|passw(?:or)?d|credential|auth)[A-Za-z0-9_]*["']?\s*[:=]\s*["']?[^\s"'$<>{}()]{8,}/i,
];
function looksSecret(text) { return SECRET_LIKE.some((re) => re.test(String(text))); }

// Имена файлов, которые не передаются и не копируются никогда (ключи, сертификаты, учётные данные).
function isSecretName(base) {
  base = String(base);
  return /^\.env($|\.(?!example$))/i.test(base) || /\.(pem|key|p12|pfx|keystore|jks|ppk)$/i.test(base) ||
    /^(id_rsa|id_ed25519|id_ecdsa|id_dsa)/i.test(base) || /^(\.npmrc|\.pypirc|\.netrc|_netrc|\.git-credentials)$/i.test(base) ||
    /^credentials(\.|$)/i.test(base) || /secrets?\.(json|ya?ml|toml|txt)$/i.test(base) || /^auth\.json$/i.test(base) || /^\.credentials\.json$/i.test(base);
}

module.exports = { SECRET_PATTERNS, SECRET_LIKE, scanSecrets, hasSecret, looksSecret, isSecretName, isPlaceholderLine };
