'use strict';
// Подтверждение «да» только от человека. Только встроенные модули Node.
//
// Откуда берётся «да»: хук UserPromptSubmit (core/hooks/human-message.js) дописывает каждое сообщение человека в `.workplace/human-messages.json`.
// ИИ писать в этот файл не может: danger-guard отклоняет любую запись в него (инструментами, перенаправлением, командой и запуском самого хука).
// Метка `# CONFIRMED` в команде больше ничего не значит: подтверждает только сообщение человека.
//
// Правило сторожа (danger-guard) для удаления, записи вне главной папки, установки и обновления:
//   1. в ПОСЛЕДНЕМ сообщении человека есть «да» или «yes» (isYes);
//   2. цель действия (путь или название программы) названа в последних двух сообщениях человека
//      или в плане, который ИИ зарегистрировал командой `wp.js consent plan "..."` и на который человек ответил «да» (его первое сообщение после плана).
// Для действий без цели (git reset --hard, push --force) хватает пункта 1.
//
// Честные пределы: файл пишет хук. Если хук не подключён или не доверен (у Codex проекту нужно доверие, команда /hooks), записей нет, и сторож отвечает
// «подтвердить нечем»: человек выполняет действие сам. Модель угрозы: невнимательный ИИ, не злоумышленник (план может зарегистрировать только сам wp.js с текущим временем).
const fs = require('fs');
const path = require('path');
const u = require('./util');
const secrets = require('./secrets-scan');

const MESSAGES = 'human-messages.json';
const PLAN = 'consent-plan.json';
const KEEP = 8;
const MAX_TEXT = 4000;

function dir(root) { return path.join(root, '.workplace'); }
function messagesFile(root) { return path.join(dir(root), MESSAGES); }
function planFile(root) { return path.join(dir(root), PLAN); }
// Файлы, в которые ИИ писать не может (проверяет danger-guard).
const PROTECTED_RX = /(^|[\\/])\.workplace[\\/](human-messages|consent-plan)\.json(\.tmp-\d+)?$/i;
const PROTECTED_WORD_RX = /human-messages?|consent-plan/i;
function isProtectedPath(p) { return PROTECTED_RX.test(String(p || '')); }

// Внутри .workplace свой .gitignore: сообщения человека, план, копии и итоги задач не попадают в коммит главной папки (общий .gitignore шаблона этих имён не знает).
const WP_GITIGNORE = '# служебное рабочего места (создано установщиком): личные сообщения, копии файлов, итоги задач; в git не попадают\n' + MESSAGES + '\n' + PLAN + '\nbackups/\ndelegate/\n';
function ensureIgnore(root) {
  const f = path.join(dir(root), '.gitignore');
  try {
    const cur = u.readText(f);
    if (cur === null) { fs.mkdirSync(dir(root), { recursive: true }); fs.writeFileSync(f, WP_GITIGNORE); return; }
    const need = ['backups/', 'delegate/', MESSAGES, PLAN].filter((l) => !cur.split(/\r?\n/).includes(l));
    if (need.length) fs.appendFileSync(f, (cur.endsWith('\n') ? '' : '\n') + need.join('\n') + '\n');
  } catch (_) { /* не критично: запись сообщений важнее */ }
}

// Строки, похожие на ключ или пароль, в файл не попадают (человек мог вставить их в чат).
function redact(text) {
  return String(text).split(/\r?\n/).map((l) => {
    let hit = false;
    try { hit = secrets.scanSecrets(l, {}).length > 0; } catch (_) { hit = false; }
    return hit ? '[строка скрыта: похожа на ключ или пароль]' : l;
  }).join('\n').slice(0, MAX_TEXT);
}

function readStore(root) {
  const j = u.readJson(messagesFile(root));
  if (!j || typeof j !== 'object' || !Array.isArray(j.messages)) return { schema: 1, messages: [] };
  return { schema: 1, messages: j.messages.filter((m) => m && typeof m.text === 'string' && Number.isFinite(m.ms)) };
}

// Записывает сообщение человека. Возвращает true, если записано.
function record(root, o) {
  const prompt = o && typeof o.prompt === 'string' ? o.prompt : '';
  if (!root || !prompt.trim()) return false;
  const st = readStore(root);
  let ms = Date.now();
  const last = st.messages[st.messages.length - 1];
  if (last && ms <= last.ms) ms = last.ms + 1;     // порядок сообщений строго возрастает
  const pl = u.readJson(planFile(root));
  if (pl && Number.isFinite(pl.ms) && ms <= pl.ms) ms = pl.ms + 1;     // сообщение после плана всегда новее плана
  st.messages.push({ at: new Date(ms).toISOString(), ms, session: o.session ? String(o.session) : null, text: redact(prompt.trim()) });
  st.messages = st.messages.slice(-KEEP);
  fs.mkdirSync(dir(root), { recursive: true });
  u.writeAtomic(messagesFile(root), JSON.stringify(st, null, 2) + '\n');
  ensureIgnore(root);
  return true;
}

const sessionOk = (m, session) => !session || !m.session || m.session === session;
// Последние n сообщений человека этой сессии (старые первыми). Без session берутся все.
function recent(root, session, n) {
  const all = readStore(root).messages.filter((m) => sessionOk(m, session));
  return all.slice(-(n || 2));
}
function hasRecords(root) { return readStore(root).messages.length > 0; }

// ---------- «да» ----------
const WORD = '(?<![A-Za-zА-Яа-яЁё0-9_])';
const WORD_END = '(?![A-Za-zА-Яа-яЁё0-9_])';
const YES_RX = new RegExp(WORD + '(да|yes|yep|yeah)' + WORD_END, 'i');
const YES_EDGE_RX = new RegExp('(^|[.!?…\\n]\\s*)(да|yes|yep|yeah)' + WORD_END + '|' + WORD + '(да|yes|yep|yeah)\\s*[.!?…]*\\s*$', 'i');
// «Да» с оговоркой (нет, не надо, не удаляй, стоп) подтверждением не считается.
const NEGATE_RX = new RegExp(WORD + '(нет|no|nope|стоп|stop|отмен\[а-яёa-z]*|cancel|не\\s+(надо|нужно|стоит|делай|удаляй|ставь|трогай|пиши|обновляй|отправляй|пуш\[а-яёa-z]*)|don\'?t|do not)' + WORD_END, 'i');
function isYes(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (NEGATE_RX.test(t)) return false;
  if (t.length <= 120) return YES_RX.test(t);
  return YES_EDGE_RX.test(t);        // в длинном сообщении «да» должно стоять в начале фразы или в конце
}

// ---------- «без проверки» ----------
const NOCHECK_RX = new RegExp(
  '(без\\s+(кросс[\\s-]*)?(проверк\[а-яёa-z]*|чек\[а-яёa-z]*|ревью)|не\\s+(надо|нужно|стоит)\\s+(кросс[\\s-]*)?(проверя\[а-яёa-z]*|проверк\[а-яёa-z]*|чекать)|не\\s+проверяй|пропусти\\s+(кросс[\\s-]*)?(проверк\[а-яёa-z]*|чек\[а-яёa-z]*)|' +
  'without\\s+(a\\s+)?(cross[\\s-]*)?(check|review)|no\\s+(cross[\\s-]*)?(check|review)|skip\\s+(the\\s+)?(cross[\\s-]*)?(check|review)|don\'?t\\s+(check|review))', 'i');
// Возвращает { phrase } или null: сказал ли человек в ПОСЛЕДНЕМ сообщении «без проверки».
function noCheck(root, session) {
  const last = recent(root, session, 1)[0];
  if (!last) return null;
  const m = NOCHECK_RX.exec(last.text);
  return m ? { phrase: m[0].replace(/\s+/g, ' ').slice(0, 40), at: last.at } : null;
}

// ---------- цели ----------
function isWin() { return process.platform === 'win32'; }
const fold = (s) => (isWin() || process.platform === 'darwin' ? String(s).toLowerCase() : String(s));
const slash = (p) => String(p).replace(/\\/g, '/');
function ancestorsOf(abs) {
  // сам путь и его родители, кроме домашней папки, корня диска и папки над домашней
  const home = path.resolve(u.homeDir());
  const out = [];
  let cur = path.resolve(abs);
  for (let i = 0; i < 40; i++) {
    if (u.same(cur, home) || u.same(cur, path.dirname(home)) || cur === path.dirname(cur)) break;
    out.push(cur);
    cur = path.dirname(cur);
  }
  return out;
}
function pathVariants(abs) {
  const home = path.resolve(u.homeDir());
  const v = new Set([slash(abs), abs]);
  const rel = path.relative(home, abs);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) { const r = slash(rel); v.add('~/' + r); v.add('$HOME/' + r); v.add('%USERPROFILE%/' + r); v.add('~\\' + rel); v.add('%USERPROFILE%\\' + rel); v.add('$env:USERPROFILE\\' + rel); }
  return [...v];
}
function containsToken(hay, needle) {
  const h = fold(slash(hay)), n = fold(slash(needle));
  let from = 0;
  for (;;) {
    const i = h.indexOf(n, from);
    if (i < 0) return false;
    const before = i > 0 ? h.charAt(i - 1) : '';
    const after = h.charAt(i + n.length), next = h.charAt(i + n.length + 1);
    // границы: перед путём не часть другого имени или пути, после него имя и путь не продолжаются (точка в конце фразы не мешает)
    const beforeOk = !before || !/[A-Za-zА-Яа-яЁё0-9_~$%/.-]/.test(before);
    const afterOk = !after || (!/[A-Za-zА-Яа-яЁё0-9_/-]/.test(after) && !(after === '.' && /[A-Za-zА-Яа-яЁё0-9_]/.test(next)));
    if (beforeOk && afterOk) return true;
    from = i + 1;
  }
}
// Называет ли текст путь abs: полным путём (с ~ и переменными), его родительской папкой (но не домашней и не корнем) или именем самого файла/папки.
// alts: другие записи того же пути (от корня рабочего места: .claude/settings.json), их человек тоже может назвать.
function textNamesPath(text, abs, alts) {
  for (const a of alts || []) if (containsToken(text, a)) return true;
  for (const a of ancestorsOf(abs)) for (const v of pathVariants(a)) if (containsToken(text, v)) return true;
  return namesBase(text, path.basename(abs));
}
// Имя файла или папки без пути: слово целиком (./имя и имя/ тоже). Слово с путём внутри (/mnt/data/имя) называет другой путь и сравнивается как путь.
function namesBase(text, base) {
  if (String(base).length < 3) return false;
  const words = String(text).split(/[\s"'«»`<>(),;]+/).map((w) => slash(w.replace(/[.,;:!?)]+$/, '')).replace(/^\.\//, '').replace(/\/+$/, ''));
  const b = fold(base);
  return words.some((w) => w && !w.includes('/') && fold(w) === b);
}
// Называет ли текст именно этот файл: полным путём, путём от главной папки (rel) или его именем. Папка-родитель файл НЕ называет (в отличие от textNamesPath).
function textNamesFileExact(text, abs, rel) {
  if (rel && containsToken(text, rel)) return true;
  if (pathVariants(abs).some((v) => containsToken(text, v))) return true;
  if (rel) {   // хвост пути от главной папки (docs/cases.md): человек обычно называет файл так
    const r = fold(slash(rel));
    const tails = String(text).split(/[\s"'«»`<>(),;]+/).map((w) => fold(slash(w.replace(/[.,;:!?)]+$/, ''))).replace(/^\.\//, '')).filter((w) => w.includes('/') && !w.startsWith('/'));
    if (tails.some((w) => r.endsWith('/' + w))) return true;
  }
  return namesBase(text, path.basename(abs));
}
// files: [{ abs, rel }]. Возвращает файлы, которые не названы ни в последних двух сообщениях человека, ни в принятом им плане.
function filesNotNamed(root, session, files) {
  const plan = approvedPlan(root, session);
  const texts = recent(root, session, 2).map((r) => r.text).concat(plan ? [plan.text] : []);
  return files.filter((f) => !texts.some((t) => textNamesFileExact(t, f.abs, f.rel)));
}

const ALIASES = {
  claude: ['клод', 'клауд', 'claude code', 'claude-code'],
  codex: ['кодекс', 'кодэкс', 'codex cli'],
  node: ['nodejs', 'node.js', 'нода', 'ноду', 'ноде', 'нод'],
  python: ['питон', 'python3', 'python 3'],
  git: ['гит'],
  ffmpeg: ['ффмпег', 'ффмпэг'],
};
const GENERIC = new Set(['code', 'tool', 'tools', 'cli', 'app', 'desktop', 'studio', 'core', 'server', 'client', 'lite', 'pro', 'free', 'latest']);
function nameForms(name) {
  const n = fold(String(name)).replace(/^@[^/]+\//, '').replace(/@[^@]*$/, '');
  const spaced = n.replace(/[-_.]+/g, ' ').trim();
  const forms = new Set([n, spaced]);
  const first = spaced.split(' ')[0];
  if (first && first.length >= 3) forms.add(first);
  for (const tok of spaced.split(' ')) if (tok.length >= 4 && !GENERIC.has(tok)) forms.add(tok);
  for (const f of [...forms]) for (const a of ALIASES[f] || []) forms.add(a);
  return [...forms].filter(Boolean);
}
function textNamesName(text, names) {
  const t = fold(text);
  for (const name of names) for (const f of nameForms(name)) {
    const re = new RegExp(WORD + f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + (/[а-яё]$/.test(f) ? '' : WORD_END), 'i');
    if (re.test(t)) return true;
  }
  return false;
}

// Цель: { kind:'path', abs } | { kind:'name', names:[...] } | { kind:'host', host } | { kind:'plan' } (нужен принятый план, названия нет).
function targetNamed(texts, target, planApproved) {
  if (target.kind === 'plan') return !!planApproved;
  return texts.some((t) => {
    if (target.kind === 'path') return textNamesPath(t, target.abs, target.alts);
    if (target.kind === 'name') return textNamesName(t, target.names);
    if (target.kind === 'host') return fold(t).includes(fold(target.host));
    return false;
  });
}
function describe(t) {
  if (t.kind === 'path') return u.tilde(t.abs);
  if (t.kind === 'name') return t.names[0];
  if (t.kind === 'host') return t.host;
  return 'весь набор из плана';
}

// ---------- план ----------
// Регистрирует то, что ИИ показал человеку. Время ставится здесь (прошлым числом записать нельзя).
function registerPlan(root, text) {
  const t = redact(String(text || '').trim());
  if (!t) throw new u.WpError('consent plan: нужен текст плана, тот же, что ты показываешь человеку.', 2);
  const st = readStore(root).messages;
  let ms = Date.now();
  const last = st[st.length - 1];
  if (last && ms <= last.ms) ms = last.ms + 1;
  fs.mkdirSync(dir(root), { recursive: true });
  u.writeAtomic(planFile(root), JSON.stringify({ schema: 1, at: new Date(ms).toISOString(), ms, text: t }, null, 2) + '\n');
  ensureIgnore(root);
  return { at: new Date(ms).toISOString(), chars: t.length };
}
// План, на который человек ответил «да»: первое сообщение человека после плана — «да», и оно же последнее.
function approvedPlan(root, session) {
  const p = u.readJson(planFile(root));
  if (!p || !Number.isFinite(p.ms) || typeof p.text !== 'string') return null;
  const after = readStore(root).messages.filter((m) => m.ms > p.ms && sessionOk(m, session));
  if (!after.length) return null;
  const first = after[0], last = after[after.length - 1];
  if (first !== last && !(last && isYes(last.text))) return null;
  return isYes(first.text) ? p : null;
}

// ---------- проверка ----------
// req: { kind: 'yes' | 'target', targets: [цель] }. Возвращает { ok:true } или { ok:false, why:'no-record'|'no-yes'|'not-named', missing:[цель], last }.
function evaluate(root, session, req) {
  if (!root) return { ok: false, why: 'no-record' };
  const recs = recent(root, session, 2);
  if (!recs.length) return { ok: false, why: 'no-record' };
  const last = recs[recs.length - 1];
  if (!isYes(last.text)) return { ok: false, why: 'no-yes', last };
  if (req.kind === 'yes' || !req.targets || !req.targets.length) return { ok: true };
  const plan = approvedPlan(root, session);
  const texts = recs.map((r) => r.text).concat(plan ? [plan.text] : []);
  const missing = req.targets.filter((t) => !targetNamed(texts, t, !!plan));
  if (missing.length) return { ok: false, why: 'not-named', missing, last };
  return { ok: true };
}
// Просьба человека, для которой отдельного «да» не нужно (push): любое из двух последних сообщений просит отправить, либо последнее — «да».
const REQUEST_RX = /(push|пуш|запуш|отправ|выложи|залей|залить|опубликуй|публик|выгрузи|publish)/i;
function requested(root, session, rx) {
  const recs = recent(root, session, 2);
  if (!recs.length) return { known: false, ok: false };
  const re = rx || REQUEST_RX;
  return { known: true, ok: recs.some((r) => re.test(r.text) && !NEGATE_RX.test(r.text)) || isYes(recs[recs.length - 1].text) };
}

module.exports = {
  MESSAGES, PLAN, PROTECTED_RX, PROTECTED_WORD_RX, isProtectedPath, messagesFile, planFile, ensureIgnore, record, recent, hasRecords, isYes, noCheck, NOCHECK_RX,
  textNamesPath, textNamesName, textNamesFileExact, filesNotNamed, targetNamed, describe, registerPlan, approvedPlan, evaluate, requested, REQUEST_RX, ancestorsOf, pathVariants,
};
