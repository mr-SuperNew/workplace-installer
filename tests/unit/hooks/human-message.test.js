'use strict';
// Хук human-message.js (UserPromptSubmit): записывает сообщение человека в .workplace/human-messages.json. Ничего не отвечает и не блокирует.
// Это единственный источник «да» для сторожей: проверяется, что записано, в каком порядке, что чужие и пустые сообщения и секреты не пишутся.
const fs = require('fs');
const path = require('path');
const h = require('./_harness');

const FILE = (root) => path.join(root, '.workplace', 'human-messages.json');
const read = (root) => { try { return JSON.parse(fs.readFileSync(FILE(root), 'utf8')).messages; } catch (_) { return null; } };
const prompt = (text, extra) => Object.assign({ hook_event_name: 'UserPromptSubmit', prompt: text }, extra || {});
const mk = (files) => () => ({ projectDir: h.makeRoot({ files }) });
const cases = [];

cases.push({ name: 'сообщение записывается, хук молчит', input: (o) => prompt('да', { cwd: o.projectDir }), expect: 'silent', make: mk(), after: (o) => { const m = read(o.projectDir); return m && m.length === 1 && m[0].text === 'да' ? null : 'в файле: ' + JSON.stringify(m); } });
cases.push({ name: 'запись видна как «да» через lib/consent.isYes', input: (o) => prompt('Да, удаляй', { cwd: o.projectDir }), expect: 'silent', make: mk(), after: (o) => { const m = read(o.projectDir); return m && require('../../../core/lib/consent').isYes(m[0].text) ? null : 'не распознано как «да»'; } });
cases.push({ name: 'текст сохраняется как есть, с кириллицей и переводами строк', input: (o) => prompt('первая строка\nвторая строка: ~/old-tmp', { cwd: o.projectDir }), expect: 'silent', make: mk(), after: (o) => { const m = read(o.projectDir); return m && m[0].text === 'первая строка\nвторая строка: ~/old-tmp' ? null : 'текст другой: ' + JSON.stringify(m && m[0].text); } });
cases.push({ name: 'второе сообщение дописывается после первого, время строго растёт', input: (o) => prompt('второе', { cwd: o.projectDir }), expect: 'silent', make: () => ({ projectDir: h.makeRoot({ timeline: [{ say: 'первое' }] }) }), after: (o) => { const m = read(o.projectDir); return m && m.length === 2 && m[0].text === 'первое' && m[1].text === 'второе' && m[1].ms > m[0].ms ? null : 'в файле: ' + JSON.stringify(m); } });
cases.push({ name: 'хранятся последние 8 сообщений', input: (o) => prompt('девятое', { cwd: o.projectDir }), expect: 'silent', make: () => ({ projectDir: h.makeRoot({ timeline: Array.from({ length: 8 }, (_, i) => ({ say: 'сообщение ' + (i + 1) })) }) }), after: (o) => { const m = read(o.projectDir); return m && m.length === 8 && m[0].text === 'сообщение 2' && m[7].text === 'девятое' ? null : 'в файле: ' + JSON.stringify(m && m.map((x) => x.text)); } });
cases.push({ name: 'номер сессии записывается', input: (o) => prompt('привет', { cwd: o.projectDir, session_id: 'sess-1' }), expect: 'silent', make: mk(), after: (o) => { const m = read(o.projectDir); return m && m[0].session === 'sess-1' ? null : 'сессия: ' + JSON.stringify(m && m[0].session); } });
cases.push({ name: 'команда со слэша тоже записывается (она новее прежнего «да»)', input: (o) => prompt('/end-session', { cwd: o.projectDir }), expect: 'silent', make: () => ({ projectDir: h.makeRoot({ timeline: [{ say: 'да' }] }) }), after: (o) => { const m = read(o.projectDir); return m && m.length === 2 && m[1].text === '/end-session' ? null : 'в файле: ' + JSON.stringify(m); } });
cases.push({ name: 'пустое сообщение не записывается', input: (o) => prompt('   ', { cwd: o.projectDir }), expect: 'silent', make: mk(), after: (o) => (read(o.projectDir) === null ? null : 'файл появился') });
cases.push({ name: 'нет поля prompt: не записывается', input: (o) => ({ hook_event_name: 'UserPromptSubmit', cwd: o.projectDir }), expect: 'silent', make: mk(), after: (o) => (read(o.projectDir) === null ? null : 'файл появился') });
cases.push({ name: 'prompt не строка: не записывается', input: (o) => ({ hook_event_name: 'UserPromptSubmit', prompt: { x: 1 }, cwd: o.projectDir }), expect: 'silent', make: mk(), after: (o) => (read(o.projectDir) === null ? null : 'файл появился') });
cases.push({ name: 'строка, похожая на ключ, не попадает в файл', input: (o) => prompt('вот пароль\npassword = "' + 'Xk92' + 'mPq7Lz4wR1' + '"\nда', { cwd: o.projectDir }), expect: 'silent', make: mk(), after: (o) => { const s = fs.readFileSync(FILE(o.projectDir), 'utf8'); return !s.includes('Xk92') && s.includes('да') && s.includes('строка скрыта') ? null : 'в файле: ' + s.slice(0, 200); } });
cases.push({ name: 'вне рабочего места файл не создаётся, хук молчит', input: (o) => prompt('да', { cwd: o.cwd }), expect: 'silent', make: () => ({ cwd: h.makeBare() }), after: (o) => (fs.existsSync(path.join(o.cwd, '.workplace')) ? 'создана папка .workplace' : null) });
cases.push({ name: 'рядом с файлом сообщений лежит .gitignore: сообщения не уйдут в git', input: (o) => prompt('да', { cwd: o.projectDir }), expect: 'silent', make: mk(), after: (o) => { const s = fs.readFileSync(path.join(o.projectDir, '.workplace', '.gitignore'), 'utf8'); return /human-messages\.json/.test(s) && /consent-plan\.json/.test(s) && /backups\//.test(s) ? null : 'в .workplace/.gitignore: ' + s; } });
cases.push({ name: 'повреждённый файл сообщений заменяется, хук молчит', input: (o) => prompt('да', { cwd: o.projectDir }), expect: 'silent', make: mk({ '.workplace/human-messages.json': 'не json{{' }), after: (o) => { const m = read(o.projectDir); return m && m.length === 1 && m[0].text === 'да' ? null : 'в файле: ' + JSON.stringify(m); } });
cases.push({ name: 'Codex: то же событие записывается (корень по cwd, без CLAUDE_PROJECT_DIR)', input: (o) => prompt('да', { cwd: o.cwd }), expect: 'silent', make: () => ({ cwd: h.makeRoot() }), after: (o) => { const m = read(o.cwd); return m && m.length === 1 ? null : 'в файле: ' + JSON.stringify(m); } });
cases.push({ name: 'мусорный ввод: тишина, код 0', input: 'не json{{', expect: 'silent', make: mk() });

module.exports = { hook: 'human-message', cases };
