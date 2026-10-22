'use strict';
// Сторож кросс-проверки: необратимый или наружный шаг идёт только при свежей принятой проверке (манифест checks/*/manifest.json, v1 по mtime).
const fs = require('fs');
const path = require('path');
const h = require('./_harness');
const P = require('../../lib/proof');

const PUSH = 'pu' + 'sh';

// Корень со своими проверками. o.manifest: { id, status, verdict, ageMin, reviewer, proof, run, files:[{path, after?, touched?}] }; o.oldSkip: { ageMin } (старый файл-выключатель, больше не действует);
// o.says: сообщения человека по порядку (их пишет хук human-message.js; «без проверки» в последнем снимает требование проверки); o.config.
// Манифест собирает tests/lib/proof.js: вместе с prompt.md, verdict.md и run.json, как оставляют run-check.js и finalize-check.js (H1).
// files: after: true = содержимое изменено после проверки; touched: true = только время изменения новее, содержимое то же (изменением не считается).
function fx(o) {
  o = o || {};
  const root = h.makeRoot({ config: o.config, timeline: (o.says || []).map((x) => ({ say: x })) });
  const now = Date.now();
  if (o.manifest) {
    const m = o.manifest;
    const t = now - (m.ageMin === undefined ? 5 : m.ageMin) * 60000;
    const files = [];
    for (const f of m.files || []) {
      const abs = path.join(root, f.path);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, 'x');
      files.push({ role: 'result', path: f.path, sha256: P.sha('x') });
      if (f.after) fs.writeFileSync(abs, 'x изменён после проверки');
      const mt = new Date(f.after || f.touched ? t + 60000 : t - 60000);
      fs.utimesSync(abs, mt, mt);
    }
    const dir = path.join(root, 'checks', m.id || '2026-10-21-1200-a');
    P.writeCheck(dir, { label: m.label, status: m.status, verdict: m.verdict, ageMin: m.ageMin, reviewer: m.reviewer === undefined ? 'codex' : m.reviewer, proof: m.proof, run: m.run, files });
    if (m.noTime) { const f = path.join(dir, 'manifest.json'); const j = JSON.parse(fs.readFileSync(f, 'utf8')); delete j.checked_at; fs.writeFileSync(f, JSON.stringify(j, null, 2)); }
  }
  if (o.deleteFiles) for (const f of (o.manifest && o.manifest.files) || []) fs.rmSync(path.join(root, f.path));
  if (o.oldSkip) {
    fs.mkdirSync(path.join(root, 'checks'), { recursive: true });
    const f = path.join(root, 'checks', '.skip');
    fs.writeFileSync(f, 'не проверяй сейчас, отправляю черновик');
    const mt = new Date(now - (o.oldSkip.ageMin || 1) * 60000);
    fs.utimesSync(f, mt, mt);
  }
  return { projectDir: root };
}
const GOOD = { files: [{ path: 'src/a.txt' }] };
const unreviewed = (op) => { try { return fs.readFileSync(path.join(op.projectDir, 'checks', 'unreviewed.md'), 'utf8'); } catch (_) { return null; } };
const logged = (re) => (op) => { const s = unreviewed(op); return s && re.test(s) ? null : 'в checks/unreviewed.md нет строки НЕ ПРОВЕРЕНО (' + (s === null ? 'файла нет' : s.slice(-160)) + ')'; };
const notLogged = (op) => (unreviewed(op) === null ? null : 'checks/unreviewed.md не должен появляться, а он есть');
const cmdCase = (name, cmd, expect, o, more) => Object.assign({ name, input: (op) => h.bash(cmd, { cwd: op.projectDir }), expect, make: () => fx(o) }, more || {});

const cases = [];

// --- состояние проверок
cases.push(cmdCase('нет checks/ -> deny', 'git ' + PUSH + ' origin main', 'deny', {}, { has: ['кросс-проверки', 'нет'] }));
cases.push(cmdCase('свежий манифест GREEN -> allow', 'git ' + PUSH + ' origin main', 'silent', { manifest: GOOD }));
cases.push(cmdCase('свежий манифест YELLOW -> allow', 'git ' + PUSH + ' origin main', 'silent', { manifest: Object.assign({ verdict: 'YELLOW' }, GOOD) }));
cases.push(cmdCase('вердикт RED -> deny', 'git ' + PUSH + ' origin main', 'deny', { manifest: Object.assign({ verdict: 'RED' }, GOOD) }, { has: 'RED' }));
cases.push(cmdCase('манифест старше ttl (120 мин) -> deny', 'git ' + PUSH + ' origin main', 'deny', { manifest: Object.assign({ ageMin: 300 }, GOOD) }, { has: 'старше 120' }));
cases.push(cmdCase('ttl из config.json (10 мин): манифест 30 мин -> deny', 'git ' + PUSH + ' origin main', 'deny', { manifest: Object.assign({ ageMin: 30 }, GOOD), config: { cross_check_ttl_min: 10 } }, { has: 'старше 10' }));
cases.push(cmdCase('файл изменён после проверки -> deny, файл назван', 'git ' + PUSH + ' origin main', 'deny', { manifest: { files: [{ path: 'src/a.txt', after: true }] } }, { has: ['изменены или исчезли после', 'src/a.txt'] }));
cases.push(cmdCase('статус not_checked -> deny', 'git ' + PUSH + ' origin main', 'deny', { manifest: Object.assign({ status: 'not_checked' }, GOOD) }));
cases.push(cmdCase('манифест без checked_at: берётся mtime файла манифеста -> allow', 'git ' + PUSH + ' origin main', 'silent', { manifest: Object.assign({ noTime: true }, GOOD) }));
cases.push(cmdCase('файл из манифеста удалён -> deny (исчезновение файла считается изменением)', 'git ' + PUSH + ' origin main', 'deny', { manifest: GOOD, deleteFiles: true }, { has: ['src/a.txt', 'больше нет'] }));
cases.push(cmdCase('только время изменения файла новее, содержимое то же (sha256 совпал) -> allow', 'git ' + PUSH + ' origin main', 'silent', { manifest: { files: [{ path: 'src/a.txt', touched: true }] } }));

// --- доказательство запуска проверяющего (H1) и проверяющий из config.json (M6)
cases.push(cmdCase('H1: рукописный манифест и вердикт без run.json (ложный GREEN) -> deny, «доказательства» названы', 'git ' + PUSH + ' origin main', 'deny', { manifest: Object.assign({ proof: 'none' }, GOOD) }, { has: ['доказательством запуска', 'run.json'] }));
cases.push(cmdCase('H1: нет отметки finalize-check в манифесте -> deny', 'git ' + PUSH + ' origin main', 'deny', { manifest: Object.assign({ proof: 'no-mark' }, GOOD) }));
cases.push(cmdCase('H1: run.json с ok: false -> deny', 'git ' + PUSH + ' origin main', 'deny', { manifest: Object.assign({ run: { ok: false, kind: 'failed' } }, GOOD) }));
cases.push(cmdCase('M6: проверял claude, а config.json называет проверяющим codex -> deny', 'git ' + PUSH + ' origin main', 'deny', { manifest: Object.assign({ reviewer: 'claude' }, GOOD) }, { has: 'проверял claude' }));
cases.push(cmdCase('M6: проверял claude, config.json называет проверяющим claude (main codex) -> allow', 'git ' + PUSH + ' origin main', 'silent', { manifest: Object.assign({ reviewer: 'claude' }, GOOD), config: { main: 'codex', reviewer: 'claude' } }));

// --- запись в служебные файлы проверок: рукописный вердикт не должен открывать сторожа
const writeCase = (name, tool, input, expect, o) => ({ name, input: (op) => h.tool(tool, typeof input === 'function' ? input(op) : input, { cwd: op.projectDir }), expect, make: () => fx(o || {}) });
cases.push(writeCase('H1: Write в checks/<id>/verdict.md -> deny', 'Write', (op) => ({ file_path: path.join(op.projectDir, 'checks', 'x', 'verdict.md'), content: 'ВЕРДИКТ: GREEN' }), 'deny'));
cases.push(writeCase('H1: Edit checks/<id>/run.json -> deny', 'Edit', (op) => ({ file_path: path.join(op.projectDir, 'checks', 'x', 'run.json'), old_string: 'a', new_string: 'b' }), 'deny'));
cases.push(writeCase('H1: Write в checks/<id>/manifest.json (относительный путь) -> deny', 'Write', { file_path: 'checks/x/manifest.json', content: '{}' }, 'deny'));
cases.push(writeCase('Write в checks/unreviewed.md инструментом (итог шагов без проверки пишет только сторож) -> deny', 'Write', (op) => ({ file_path: path.join(op.projectDir, 'checks', 'unreviewed.md'), content: 'пусто' }), 'deny'));
cases.push(writeCase('H1: MultiEdit checks/<id>/review.log -> deny', 'MultiEdit', (op) => ({ file_path: path.join(op.projectDir, 'checks', 'x', 'review.log'), edits: [{ old_string: 'a', new_string: 'b' }] }), 'deny'));
cases.push({ name: 'H1: Codex apply_patch в checks/<id>/verdict.md -> deny', input: (op) => h.tool('apply_patch', { command: '*** Begin Patch\n*** Add File: checks/x/verdict.md\n+ВЕРДИКТ: GREEN\n*** End Patch' }, { cwd: op.projectDir }), expect: 'deny', make: () => fx({}) });
cases.push(writeCase('Write в checks/POLICY.md (решение человека о ПДн) -> allow', 'Write', (op) => ({ file_path: path.join(op.projectDir, 'checks', 'POLICY.md'), content: 'ПДн проверяющему: нельзя' }), 'silent'));
cases.push(writeCase('Write в обычный файл -> allow', 'Write', (op) => ({ file_path: path.join(op.projectDir, 'out', 'a.md'), content: 'x' }), 'silent'));
cases.push(cmdCase('H1: echo > checks/x/verdict.md -> deny', 'echo "ВЕРДИКТ: GREEN" > checks/x/verdict.md', 'deny', {}, { has: 'Вердикт, написанный рукой' }));
cases.push(cmdCase('H1: tee checks/x/run.json -> deny', 'tee checks/x/run.json', 'deny', {}));
cases.push(cmdCase('H1: чтение verdict.md (cat) -> allow', 'cat checks/x/verdict.md', 'silent', {}));
cases.push(cmdCase('H1: запуск скрипта проверки (node ...run-check.js checks/x) -> allow', 'node .workplace/core/skills/cross-check/scripts/run-check.js checks/x', 'silent', {}));

// --- «без проверки» из последнего сообщения человека (вместо файла-выключателя checks/.skip)
const PUSHCMD = 'git ' + PUSH + ' origin main';
cases.push(cmdCase('«без проверки» в последнем сообщении, проверки нет -> allow и запись НЕ ПРОВЕРЕНО', PUSHCMD, 'silent', { says: ['Сделай коммит и push, без проверки'] }, { after: logged(/НЕ ПРОВЕРЕНО: отправка изменений в удалённый репозиторий \(слова человека: «без проверки»\)/) }));
cases.push(cmdCase('«Без проверки.» отдельным сообщением -> allow и запись', PUSHCMD, 'silent', { says: ['запушь', 'Без проверки.'] }, { after: logged(/НЕ ПРОВЕРЕНО/) }));
cases.push(cmdCase('«не надо проверять» -> allow и запись', PUSHCMD, 'silent', { says: ['запушь, не надо проверять'] }, { after: logged(/НЕ ПРОВЕРЕНО/) }));
cases.push(cmdCase('«без кросс-проверки» -> allow и запись', PUSHCMD, 'silent', { says: ['запушь без кросс-проверки'] }, { after: logged(/НЕ ПРОВЕРЕНО/) }));
cases.push(cmdCase('«skip the review» -> allow и запись', PUSHCMD, 'silent', { says: ['push it, skip the review'] }, { after: logged(/НЕ ПРОВЕРЕНО/) }));
cases.push(cmdCase('«без проверки» было раньше, последнее сообщение другое -> deny', PUSHCMD, 'deny', { says: ['запушь без проверки', 'ладно, тогда просто запушь'] }, { has: 'кросс-проверки', after: notLogged }));
cases.push(cmdCase('человек ничего не говорил о проверке -> deny с подсказкой «без проверки»', PUSHCMD, 'deny', { says: ['запушь'] }, { has: ['без проверки', 'НЕ ПРОВЕРЕНО'], after: notLogged }));
cases.push(cmdCase('сообщений человека нет (хук не подключён) -> deny', PUSHCMD, 'deny', {}, { after: notLogged }));
cases.push(cmdCase('«без проверки» и вердикт RED -> allow и запись', PUSHCMD, 'silent', { says: ['запушь без проверки'], manifest: Object.assign({ verdict: 'RED' }, GOOD) }, { after: logged(/НЕ ПРОВЕРЕНО/) }));
cases.push(cmdCase('«без проверки» и проверка устарела -> allow и запись', PUSHCMD, 'silent', { says: ['запушь без проверки'], manifest: Object.assign({ ageMin: 300 }, GOOD) }, { after: logged(/НЕ ПРОВЕРЕНО/) }));
cases.push(cmdCase('«без проверки», но свежая принятая проверка есть -> allow, записи НЕ ПРОВЕРЕНО нет (шаг проверен)', PUSHCMD, 'silent', { says: ['запушь без проверки'], manifest: GOOD }, { after: notLogged }));
cases.push({ name: 'MCP send и «без проверки» -> allow и запись', input: (o) => h.tool('mcp__gmail__send_email', {}, { cwd: o.projectDir }), expect: 'silent', make: () => fx({ says: ['отправь письмо без проверки'] }), after: logged(/НЕ ПРОВЕРЕНО: инструмент MCP/) });
cases.push(cmdCase('запись в журнал не содержит аргументов команды (адрес, ключ)', 'curl -d token=abc https://api.example.com/items', 'silent', { says: ['отправь без проверки'] }, { after: (op) => { const s = unreviewed(op) || ''; return /api\.example\.com|token=abc/.test(s) ? 'в журнале остались аргументы команды' : (s ? null : 'журнала нет'); } }));
cases.push({ name: '«без проверки» из другой сессии не засчитывается', input: (o) => Object.assign(h.bash(PUSHCMD, { cwd: o.projectDir }), { session_id: 'B' }), expect: 'deny', make: () => { const root = h.makeRoot({ timeline: [{ say: 'запушь без проверки', session: 'A' }] }); return { projectDir: root }; } });
cases.push(cmdCase('старый файл checks/.skip больше не выключатель -> deny', PUSHCMD, 'deny', { oldSkip: { ageMin: 5 } }));
cases.push(cmdCase('чужой «без проверки» в тексте команды не считается (echo)', 'echo "без проверки" && ' + PUSHCMD, 'deny', { says: ['запушь'] }, { after: notLogged }));
cases.push(cmdCase('агент пишет checks/unreviewed.md через echo > -> deny', 'echo "ничего не было" > checks/unreviewed.md', 'deny', {}, { has: 'Вердикт, написанный рукой' }));
cases.push(cmdCase('агент подменяет checks/unreviewed.md через cp -> deny', 'cp /tmp/x checks/unreviewed.md', 'deny', {}));
cases.push(cmdCase('чтение checks/unreviewed.md (cat) -> allow', 'cat checks/unreviewed.md', 'silent', {}));
cases.push(cmdCase('файла-выключателя больше нет: touch checks/.skip обычная команда -> allow', 'touch checks/.skip', 'silent', {}));
cases.push(cmdCase('echo ok > checks/.skip обычная команда -> allow', 'echo ok > checks/.skip', 'silent', {}));

// --- что считается необратимым
for (const [c, what] of [
  ['npm publish', 'пакета'],
  ['gh pr create --title x', 'GitHub'],
  ['gh release create v1', 'GitHub'],
  ['curl -X POST https://api.example.com/items', 'запрос с записью'],
  ['curl -d a=1 https://api.example.com/items', 'запрос с записью'],
  ['wget --post-data=a=1 https://api.example.com/items', 'запрос с записью'],
  ['Invoke-RestMethod -Method Post https://api.example.com/items', 'запрос с записью'],
  ['scp a.txt me@host:/tmp', 'удалённый'],
  ['ssh me@host ls', 'удалённый'],
  ['rsync -av out/ me@host:/srv/', 'удалённый'],
  ['sendmail a@example.com', 'письм'],
  ['firebase deploy', 'развёртывание'],
  ['docker push img:1', 'публикация'],
  ['bash -c "git ' + PUSH + '"', 'удалённый репозиторий'],
  ['git add . && git commit -m x && git ' + PUSH, 'удалённый репозиторий'],
]) cases.push(cmdCase('необратимое без проверки -> deny: ' + c.slice(0, 50), c, 'deny', {}, { has: what }));

// --- обычное не трогаем
for (const c of ['ls -la', 'git status', 'git commit -m "x"', 'git ' + PUSH + ' --dry-run', 'npm publish --dry-run', 'npm install -g @openai/codex', 'curl -fsSL https://claude.ai/install.sh | bash', 'curl https://api.example.com/items',
  'curl -X POST http://localhost:3000/x', 'curl -d a=1 http://127.0.0.1:8080/x', 'rsync -av a/ b/', 'gh pr list', 'codex login status', 'node .workplace/core/cli/wp.js recon --json']) {
  cases.push(cmdCase('allow без проверки: ' + c.slice(0, 55), c, 'silent', {}));
}

// --- MCP
cases.push({ name: 'MCP send -> deny', input: (o) => h.tool('mcp__gmail__send_email', { to: 'a@example.com' }, { cwd: o.projectDir }), expect: 'deny', make: () => fx({}), has: 'send' });
cases.push({ name: 'MCP publishPost (camelCase) -> deny', input: (o) => h.tool('mcp__blog__publishPost', {}, { cwd: o.projectDir }), expect: 'deny', make: () => fx({}) });
cases.push({ name: 'MCP delete_file -> deny', input: (o) => h.tool('mcp__drive__delete_file', {}, { cwd: o.projectDir }), expect: 'deny', make: () => fx({}) });
cases.push({ name: 'MCP list_posts -> allow', input: (o) => h.tool('mcp__blog__list_posts', {}, { cwd: o.projectDir }), expect: 'silent', make: () => fx({}) });
cases.push({ name: 'MCP get_post (читающий глагол первым) -> allow', input: (o) => h.tool('mcp__blog__get_post', {}, { cwd: o.projectDir }), expect: 'silent', make: () => fx({}) });
cases.push({ name: 'MCP create_page (не send/post/publish/delete) -> allow', input: (o) => h.tool('mcp__notes__create_page', {}, { cwd: o.projectDir }), expect: 'silent', make: () => fx({}) });
cases.push({ name: 'MCP send при свежей проверке -> allow', input: (o) => h.tool('mcp__gmail__send_email', {}, { cwd: o.projectDir }), expect: 'silent', make: () => fx({ manifest: GOOD }) });

// --- имена инструментов Codex, режимы, выключатели
cases.push({ name: 'Codex shell_command без проверки -> deny', input: (o) => h.tool('shell_command', { command: 'git ' + PUSH, workdir: o.projectDir }, { cwd: o.projectDir }), expect: 'deny', make: () => fx({}) });
cases.push({ name: 'Codex shell (список) без проверки -> deny', input: (o) => h.tool('shell', { command: ['bash', '-lc', 'npm publish'] }, { cwd: o.projectDir }), expect: 'deny', make: () => fx({}) });
cases.push({ name: 'Codex-режим: без CLAUDE_PROJECT_DIR, корень по cwd -> deny', input: (o) => h.bash('git ' + PUSH, { cwd: o.root }), expect: 'deny', make: () => ({ root: fx({}).projectDir }) });
cases.push({ name: 'флаг guards.cross_check_guard=false -> молчит', input: (o) => h.bash('git ' + PUSH, { cwd: o.projectDir }), expect: 'silent', make: () => fx({ config: { guards: { cross_check_guard: false } } }) });
cases.push({ name: 'вне рабочего места (корня нет) -> молчит', input: (o) => h.bash('git ' + PUSH, { cwd: o.cwd }), expect: 'silent', make: () => ({ cwd: h.makeBare() }) });
cases.push({ name: 'не оболочка и не MCP (Write обычного файла) -> молчит', input: (o) => h.tool('Write', { file_path: 'a.txt', content: 'x' }, { cwd: o.projectDir }), expect: 'silent', make: () => fx({}) });

// --- этап Ж: R1 (чтение служебных файлов не отказ, запись отказ) и N2 (обход через cd, относительный путь, node -e, python -c)
for (const c of ['sed -n 1,5p checks/x/verdict.md', 'jq . checks/x/run.json', 'shasum -a 256 checks/x/verdict.md', 'sha256sum checks/x/run.json', 'awk \'{print $1}\' checks/x/verdict.md',
  'Select-String -Path checks/x/verdict.md -Pattern GREEN', 'Get-FileHash checks\\x\\verdict.md', 'diff checks/x/verdict.md /tmp/a.md', 'nl checks/x/verdict.md', 'sort checks/x/review.log',
  'cut -d: -f1 checks/x/manifest.json', 'file checks/x/verdict.md', 'od -c checks/x/run.json']) {
  cases.push(cmdCase('R1 allow (чтение): ' + c, c, 'silent', {}));
}
for (const c of ['sed -i s/a/b/ checks/x/verdict.md', 'sed -i.bak s/a/b/ checks/x/run.json', 'sed --in-place s/a/b/ checks/x/verdict.md', 'sort -o checks/x/verdict.md /tmp/a.md', 'cp /tmp/v.md checks/x/verdict.md', 'mv /tmp/r.json checks/x/run.json']) {
  cases.push(cmdCase('R1 deny (запись): ' + c, c, 'deny', {}, { has: 'Вердикт, написанный рукой' }));
}
for (const c of ['cd checks/x && cp /tmp/v.md verdict.md', 'cd checks/x && echo {} > run.json', 'cd checks/x && printf x > ./run.json', 'cd checks/x && tee manifest.json', 'cd checks/x; touch verdict.md',
  'cd checks/x && echo x >> review.log', 'cd checks/x && sed -i s/a/b/ verdict.md', 'cd checks/x/.. && cp /tmp/v.md x/verdict.md', 'cd checks && touch x/run.json']) {
  cases.push(cmdCase('N2 deny (cd и относительный путь): ' + c, c, 'deny', {}));
}
for (const c of ['cd checks/x && cat verdict.md', 'cd checks/x && ls', 'cd checks/x && sed -n 1,3p run.json', 'cd checks/x && shasum -a 256 verdict.md', 'cd checks/x && echo x > notes.txt', 'cd out && cp a.md verdict.md']) {
  cases.push(cmdCase('N2 allow: ' + c, c, 'silent', {}));
}
for (const c of ['node -e "require(\'fs\').writeFileSync(\'checks/x/run.json\', \'{}\')"', 'python3 -c "open(\'checks/x/run.json\', \'w\').write(\'{}\')"',
  'node -e "require(\'fs\').appendFileSync(require(\'path\').join(\'checks\', \'x\', \'verdict.md\'), \'ВЕРДИКТ: GREEN\')"', 'python3 -c "import shutil; shutil.copy(\'/tmp/v.md\', \'checks/x/verdict.md\')"',
  'perl -e \'open(F, ">checks/x/run.json"); print F "{}"\'']) {
  cases.push(cmdCase('N2 deny (код на интерпретаторе): ' + c.slice(0, 60), c, 'deny', {}));
}
cases.push(cmdCase('N2 deny: python с heredoc, пишет verdict.md', 'python3 - <<\'EOF\'\nimport shutil\nshutil.copy(\'/tmp/v.md\', \'checks/x/verdict.md\')\nEOF', 'deny', {}));
cases.push(cmdCase('N2 allow: node -e читает run.json (без записи)', 'node -e "console.log(JSON.parse(require(\'fs\').readFileSync(\'checks/x/run.json\', \'utf8\')).ok)"', 'silent', {}));
cases.push(cmdCase('N2 allow: node -e пишет в другой файл', 'node -e "require(\'fs\').writeFileSync(\'out/a.json\', \'{}\')"', 'silent', {}));
cases.push({ name: 'N2 deny: Write относительным путём verdict.md при cwd = checks/x', input: (o) => h.tool('Write', { file_path: 'verdict.md', content: 'ВЕРДИКТ: GREEN' }, { cwd: path.join(o.projectDir, 'checks', 'x') }), expect: 'deny', make: () => fx({}) });
cases.push({ name: 'N2 allow: Write относительным путём notes.md при cwd = checks/x', input: (o) => h.tool('Write', { file_path: 'notes.md', content: 'x' }, { cwd: path.join(o.projectDir, 'checks', 'x') }), expect: 'silent', make: () => fx({}) });
cases.push({ name: 'N2 deny: Bash с cwd = checks/x (поле cwd входа), запись run.json перенаправлением', input: (o) => h.bash('echo {} > run.json', { cwd: path.join(o.projectDir, 'checks', 'x') }), expect: 'deny', make: () => fx({}) });
cases.push({ name: 'N2 deny: cd checks && touch unreviewed.md (итог шагов без проверки пишет только сторож)', input: (o) => h.bash('cd checks && touch unreviewed.md', { cwd: o.projectDir }), expect: 'deny', make: () => fx({}), has: 'Вердикт, написанный рукой' });

module.exports = { hook: 'cross-check-guard', cases };
