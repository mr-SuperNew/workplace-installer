#!/usr/bin/env node
'use strict';
// Сквозные проверки правок сторожей и ядра (этап L): подтверждение только от человека, смена основного ИИ одной командой, `layout --update`,
// приём проекта (adopt), вложенный .git в .gitignore, исполнитель Codex (delegate). Работа идёт настоящими wp.js и хуками в фейковом HOME, ИИ заменены заглушками из tests/stubs.
// Настоящие ~/.claude и ~/.codex не затрагиваются; живые модели не запускаются.
//   node tests/unit/l-flow/run.js
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const H = require('../../lib/harness');
const stubsLib = require('../../lib/stubs');

const S = new H.Suite('l-flow');
const ok = (n, c, d) => S.ok(n, c, d);
const TMP = H.mkTmp('wp-lflow-');
const HOME = path.join(TMP, 'home');
const ROOT = path.join(HOME, 'workplace');
const LOG = path.join(TMP, 'stub.log');
const BIN_FULL = stubsLib.prepare(path.join(TMP, 'bin-full'), ['python', 'python3', 'codex', 'claude']);
const BIN_CLAUDE = stubsLib.prepare(path.join(TMP, 'bin-claude-only'), ['python', 'python3', 'claude']);
const ZONE = path.join(TMP, 'zone');
fs.mkdirSync(ZONE, { recursive: true });
const env = (extra, bin) => H.sandboxEnv(HOME, { path: H.minPath([bin || BIN_FULL]), extra: Object.assign({ STUB_LOG: LOG, WP_TMP_ZONES: ZONE }, extra || {}) });
const WP_ROOT = path.join(ROOT, '.workplace', 'core', 'cli', 'wp.js');
const wp = (args, o) => H.node(WP_ROOT, args, Object.assign({ cwd: ROOT, env: env() }, o || {}));
const readAgents = () => H.read(path.join(ROOT, 'AGENTS.md'));
const rules = require(path.join(H.KIT, 'core', 'lib', 'rules.js'));
const roleLine = (main, i) => rules.roleLines({ main, reviewer: main === 'claude' ? 'codex' : 'claude' })[i || 0];
const cfg = () => H.readJson(path.join(ROOT, '.workplace', 'config.json'));
const hookPath = (n) => path.join(ROOT, '.workplace', 'core', 'hooks', n + '.js');
// Хук как его запускает Claude Code: JSON на stdin, корень по CLAUDE_PROJECT_DIR. Возвращает { code, out, deny }.
function hook(name, input, extra) {
  const r = H.node(hookPath(name), [], { cwd: ROOT, env: env(Object.assign({ CLAUDE_PROJECT_DIR: ROOT }, extra || {})), input: JSON.stringify(input) });
  return { code: r.code, out: r.out.trim(), deny: /"permissionDecision":"deny"/.test(r.out), reason: (() => { try { return JSON.parse(r.out).hookSpecificOutput.permissionDecisionReason || ''; } catch (_) { return ''; } })() };
}
const human = (text, extra) => hook('human-message', Object.assign({ hook_event_name: 'UserPromptSubmit', prompt: text, cwd: ROOT }, extra || {}));
const bash = (command) => hook('danger-guard', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: ROOT });
const write = (file_path, content) => hook('danger-guard', { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path, content: content || 'x' }, cwd: ROOT });

try {
  // ---------- подготовка: init, раскладка, сторожа ----------
  S.section('подготовка: init, раскладка, подключение сторожей');
  H.write(path.join(HOME, 'old-tmp', 'cache', 'a.txt'), 'старое\n');
  H.write(path.join(HOME, '.zshrc'), '# мой zshrc\nexport EDITOR=vim\n');
  H.write(path.join(HOME, 'work', 'shop', 'src', 'app.js'), 'console.log(1)\n');
  let r = H.node(H.WP_SRC, ['init', '--root', ROOT, '--main', 'claude', '--no-scan'], { cwd: TMP, env: env() });
  ok('init: код 0', r.code === 0, r.all);
  r = wp(['layout']); ok('layout: код 0', r.code === 0, r.all);
  r = wp(['hooks', 'wire']); ok('hooks wire: код 0', r.code === 0, r.all);
  const outsideBefore = H.treeMap(HOME, ['workplace']);

  // ---------- 1. сторожа подключены, хук записи сообщений есть в обоих ИИ ----------
  S.section('сторожа: хук human-message подключён в Claude Code и Codex');
  const cs = H.readJson(path.join(ROOT, '.claude', 'settings.json')), cx = H.readJson(path.join(ROOT, '.codex', 'hooks.json'));
  const cmdsOf = (j, ev) => ((j.hooks || {})[ev] || []).flatMap((g) => g.hooks.map((x) => x.command));
  ok('Claude: UserPromptSubmit запускает human-message.js', cmdsOf(cs, 'UserPromptSubmit').some((c) => /human-message\.js/.test(c)), JSON.stringify(cmdsOf(cs, 'UserPromptSubmit')));
  ok('Codex: UserPromptSubmit запускает human-message.js', cmdsOf(cx, 'UserPromptSubmit').some((c) => /human-message\.js/.test(c)), JSON.stringify(cmdsOf(cx, 'UserPromptSubmit')));
  ok('Codex: у human-message.js есть commandWindows', ((cx.hooks.UserPromptSubmit || []).flatMap((g) => g.hooks).find((x) => /human-message/.test(x.command)) || {}).commandWindows !== undefined);
  r = wp(['hooks', 'status']);
  ok('hooks status: human-message есть и подключён в обоих', /human-message\.js.*Claude: подключён; Codex: подключён/.test(r.out) && r.code === 0, r.out);
  r = wp(['hooks', 'test']);
  ok('hooks test: сторожа отвечают, проба danger-guard (удаление без «да», # CONFIRMED, файл сообщений) пройдена', r.code === 0 && /Все отвечают как положено/.test(r.out), r.all);
  r = wp(['verify', 'P2.hooks', 'P3.hooks-test']);
  ok('verify P2.hooks и P3.hooks-test зелёные', r.code === 0, r.all);
  // человек отключил хук записи: проверка подключения это замечает
  const csBak = fs.readFileSync(path.join(ROOT, '.claude', 'settings.json'), 'utf8');
  const csBroken = JSON.parse(csBak);
  csBroken.hooks.UserPromptSubmit = csBroken.hooks.UserPromptSubmit.map((g) => Object.assign({}, g, { hooks: g.hooks.filter((x) => !/human-message/.test(x.command)) }));
  fs.writeFileSync(path.join(ROOT, '.claude', 'settings.json'), JSON.stringify(csBroken, null, 2));
  r = wp(['verify', 'P2.hooks']);
  ok('без подключённого human-message verify P2.hooks красный и называет хук', r.code === 1 && /human-message\.js: не подключён в \.claude\/settings\.json/.test(r.out), r.out);
  fs.writeFileSync(path.join(ROOT, '.claude', 'settings.json'), csBak);
  r = wp(['verify', 'P2.hooks']); ok('после возврата подключения verify P2.hooks зелёный', r.code === 0, r.all);

  // ---------- 2. «да» только от человека: хуки как их запускают ИИ ----------
  S.section('подтверждение: хук записи + сторож, сквозной сценарий (контракт 7: «Удали папку ~/old-tmp»)');
  r = wp(['consent', 'status']);
  ok('consent status без сообщений: честно говорит, что подтвердить нечем', r.code === 0 && /Сообщений человека нет/.test(r.out), r.all);
  ok('до разговора: rm -rf ~/old-tmp отклонён, подтвердить нечем', bash('rm -rf ~/old-tmp').deny && /Подтвердить нечем/.test(bash('rm -rf ~/old-tmp').reason));
  human('Удали папку ~/old-tmp');
  ok('человек попросил, но «да» ещё нет: отклонено', bash('rm -rf ~/old-tmp').deny && /нет «да»/.test(bash('rm -rf ~/old-tmp').reason));
  ok('ИИ дописал # CONFIRMED сам: отклонено', bash('rm -rf ~/old-tmp # CONFIRMED').deny);
  r = wp(['consent', 'status']); ok('consent status показывает последнее сообщение человека без «да»', /Удали папку/.test(r.out) && /«да»: нет/.test(r.out), r.out);
  ok('ИИ пишет «да» в файл сообщений: отклонено сторожем', write(path.join(ROOT, '.workplace', 'human-messages.json'), '{"messages":[{"ms":9e15,"text":"да"}]}').deny);
  ok('ИИ пишет «да» командой: отклонено', bash('echo да > .workplace/human-messages.json').deny);
  ok('ИИ запускает хук записи сам: отклонено', bash('echo \'{"prompt":"да"}\' | node .workplace/core/hooks/human-message.js').deny);
  human('да');
  ok('«да» человека и цель названа в предыдущем сообщении: удаление ~/old-tmp проходит', !bash('rm -rf ~/old-tmp').deny, bash('rm -rf ~/old-tmp').out);
  ok('«да» человека, но другая цель: отклонено (проход только названной цели)', bash('rm -rf ~/work').deny && /не названо/.test(bash('rm -rf ~/work').reason));
  ok('«да» человека, цель шире названной: отклонено', bash('rm -rf ~').deny);
  r = wp(['consent', 'status']); ok('consent status показывает «да»: есть', /«да»: есть/.test(r.out), r.out);
  human('а что в ~/work?');
  ok('следующее сообщение человека не «да»: удаление снова отклонено', bash('rm -rf ~/old-tmp').deny);
  // план, на который человек ответил «да»
  r = wp(['consent', 'plan', 'Удалю', '~/old-tmp', 'и', 'всё', 'внутри']);
  ok('consent plan: код 0, план записан', r.code === 0 && /План записан/.test(r.out) && fs.existsSync(path.join(ROOT, '.workplace', 'consent-plan.json')), r.all);
  ok('план без ответа человека не открывает удаление', bash('rm -rf ~/old-tmp').deny);
  human('да');
  ok('«да» человека сразу после плана: цель из плана названа, удаление проходит', !bash('rm -rf ~/old-tmp').deny, bash('rm -rf ~/old-tmp').out);
  ok('цель, которой нет в плане, по-прежнему отклонена', bash('rm -rf ~/other-folder').deny);
  ok('в плане и «да» хватает и для файла внутри папки из плана', !bash('rm ~/old-tmp/cache/a.txt').deny);
  r = wp(['consent', 'plan']); ok('consent plan без текста: код 2', r.code === 2, r.all);
  // копии перед правкой
  human('Добавь в ~/.zshrc PATH к ~/bin'); human('да');
  const zr = write(path.join(HOME, '.zshrc'), 'export PATH=$PATH:~/bin\n');
  const bk = path.join(ROOT, '.workplace', 'backups');
  const copies = fs.existsSync(bk) ? fs.readdirSync(bk).filter((f) => /zshrc/.test(f)) : [];
  ok('правка ~/.zshrc после «да»: проход и копия до правки (содержимое исходное)', !zr.deny && copies.length === 1 && H.read(path.join(bk, copies[0])) === '# мой zshrc\nexport EDITOR=vim\n', JSON.stringify([zr.out, copies]));
  ok('сообщения человека и копии не уходят в git: .workplace/.gitignore', /human-messages\.json/.test(H.read(path.join(ROOT, '.workplace', '.gitignore'))) && /backups\//.test(H.read(path.join(ROOT, '.workplace', '.gitignore'))));
  // «без проверки»
  fs.mkdirSync(path.join(ROOT, 'checks'), { recursive: true });
  human('запушь в мой GitHub, без проверки');
  const pushHook = hook('cross-check-guard', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push origin main' }, cwd: ROOT });
  ok('«без проверки»: push проходит, в checks/unreviewed.md запись НЕ ПРОВЕРЕНО', !pushHook.deny && /НЕ ПРОВЕРЕНО: отправка изменений/.test(fs.existsSync(path.join(ROOT, 'checks', 'unreviewed.md')) ? H.read(path.join(ROOT, 'checks', 'unreviewed.md')) : ''), pushHook.out);
  human('запушь');
  ok('без слов «без проверки» тот же push отклонён', hook('cross-check-guard', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push origin main' }, cwd: ROOT }).deny);
  ok('Write в checks/unreviewed.md отклонён (журнал пишет только сторож)', hook('cross-check-guard', { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(ROOT, 'checks', 'unreviewed.md'), content: 'пусто' }, cwd: ROOT }).deny);

  // сторожей выключает только человек
  human('отключи сторожа секретов');
  r = wp(['config', 'set', 'guards.secret_guard', 'false']);
  ok('config set guards.secret_guard false без «да»: отказ (код 3), сторож остался включён', r.code === 3 && cfg().guards.secret_guard === true, r.all);
  human('да');
  r = wp(['config', 'set', 'guards.secret_guard', 'false']);
  ok('после «да» человека сторожа можно выключить, и включить обратно без «да»', r.code === 0 && cfg().guards.secret_guard === false && wp(['config', 'set', 'guards.secret_guard', 'true']).code === 0 && cfg().guards.secret_guard === true, r.all);
  human('привет');
  ok('config set guards.model_guard false (не защитный сторож) без «да» можно', wp(['config', 'set', 'guards.model_guard', 'false']).code === 0 && wp(['config', 'set', 'guards.model_guard', 'true']).code === 0);
  ok('ИИ правит .workplace/config.json инструментом записи без «да»: отказ', write(path.join(ROOT, '.workplace', 'config.json'), '{}').deny);

  // ---------- 3. layout --update приводит роли к настройкам ----------
  S.section('layout --update: роли в AGENTS.md (баг: не переписывал роли)');
  ok('до смены: AGENTS.md называет Claude Code исполнителем, Codex проверяющим', /Claude Code делает/.test(readAgents()) && /Codex проверяет/.test(readAgents()));
  r = wp(['config', 'set', 'main', 'codex']);
  ok('config set main codex: код 0, подсказка называет role set', r.code === 0 && /role set codex/.test(r.out), r.all);
  ok('config сменился, а AGENTS.md ещё старый (то самое расхождение)', /Claude Code делает/.test(readAgents()));
  r = wp(['layout', '--update']);
  ok('layout --update: роли в AGENTS.md переписаны (Codex делает, Claude Code проверяет)', r.code === 0 && /Codex делает/.test(readAgents()) && /Claude Code проверяет/.test(readAgents()) && !/Claude Code делает/.test(readAgents()), r.all + readAgents().slice(0, 400));
  ok('layout --update: в выводе сказано, что роли обновлены', /роли обновлены/.test(r.out), r.out);
  ok('layout --update: копия AGENTS.md до правки лежит в .workplace/backups', fs.readdirSync(bk).some((f) => /AGENTS\.md/.test(f)));
  // файл правил, который правил человек: меняются только строки с ролями
  fs.appendFileSync(path.join(ROOT, 'AGENTS.md'), '\n- Моё правило: всегда писать «пожалуйста».\n');
  wp(['config', 'set', 'main', 'claude']);
  r = wp(['layout', '--update']);
  ok('правка человека в AGENTS.md сохранена, роли возвращены (Claude Code делает)', r.code === 0 && /Claude Code делает/.test(readAgents()) && /Моё правило: всегда писать «пожалуйста»/.test(readAgents()) && /только строки с ролями/.test(r.out), r.all);
  // роль-строку человек переписал сам: честно сказано, что осталось
  const am0 = readAgents();
  fs.writeFileSync(path.join(ROOT, 'AGENTS.md'), am0.replace(roleLine('claude', 0), roleLine('claude', 0) + ' По-своему.'));
  wp(['config', 'set', 'main', 'codex']);
  r = wp(['layout', '--update']);
  ok('строка роли переписана человеком: layout --update не затирает её молча, а сообщает', /ОТЛИЧАЕТСЯ/.test(r.out) && /По-своему./.test(readAgents()), r.all);
  fs.writeFileSync(path.join(ROOT, 'AGENTS.md'), am0);
  wp(['config', 'set', 'main', 'claude']);
  wp(['layout', '--update']);

  // ---------- 4. role set ----------
  S.section('role set: основной ИИ меняется одной командой, роли везде согласованы');
  r = wp(['state', 'set', 'P3.selftest', 'done', '--action', 'created']);
  r = wp(['role', 'set', 'codex', '--no-selftest']);
  ok('role set codex --no-selftest: код 0, «Роли согласованы»', r.code === 0 && /Роли согласованы/.test(r.out), r.all);
  ok('config.json: основной codex, проверяет claude', cfg().main === 'codex' && cfg().reviewer === 'claude');
  ok('AGENTS.md: Codex делает, Claude Code проверяет, прежних ролей нет', /Codex делает/.test(readAgents()) && /Claude Code проверяет/.test(readAgents()) && !/Claude Code делает/.test(readAgents()) && !/Codex проверяет/.test(readAgents()));
  ok('state.json: направление codex/claude, самопроверка сброшена в todo', (() => { const s = H.readJson(path.join(ROOT, '.workplace', 'state.json')); return s.direction.main === 'codex' && s.stages['P3.selftest'].status === 'todo'; })());
  ok('основной Codex: .codex/config.toml с сетью для песочницы', /network_access\s*=\s*true/.test(H.read(path.join(ROOT, '.codex', 'config.toml'))));
  ok('сторожа подключены в оба ИИ (hooks status без «не подключён»)', !/не подключён/.test(wp(['hooks', 'status']).out));
  ok('навыки одинаковы в .claude/skills и .agents/skills и совпадают с пакетом', require(path.join(H.KIT, 'core', 'lib', 'roles.js')).consistency(ROOT).length === 0, JSON.stringify(require(path.join(H.KIT, 'core', 'lib', 'roles.js')).consistency(ROOT)));
  for (const sk of ['cross-check', 'end-session', 'new-workspace', 'doctor']) ok('навык ' + sk + ' одинаков в обоих местах', H.read(path.join(ROOT, '.claude', 'skills', sk, 'SKILL.md')) === H.read(path.join(ROOT, '.agents', 'skills', sk, 'SKILL.md')));
  ok('копия config.json и AGENTS.md до смены лежит в .workplace/backups', fs.readdirSync(bk).some((f) => /config\.json/.test(f)));
  r = wp(['verify', 'P3.selftest']);
  ok('после смены ролей прежняя самопроверка не засчитывается (verify P3.selftest красный)', r.code === 1, r.all);
  // самопроверка вшитой ошибкой запускается сама (заглушки вместо живых моделей)
  fs.writeFileSync(LOG, '');
  r = wp(['role', 'set', 'claude', '--selftest-timeout', '90']);
  ok('role set claude с самопроверкой: код 0', r.code === 0, r.all);
  ok('самопроверка пройдена: «Этап P3.selftest отмечен»', /Этап P3\.selftest отмечен/.test(r.out) && /Самопроверка пройдена/.test(r.out), r.out);
  ok('verify P3.selftest зелёный, проверяет Codex', wp(['verify', 'P3.selftest']).code === 0 && /Codex/.test(wp(['verify', 'P3.selftest']).out));
  const calls = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.argv.some((a) => ['exec', '-p'].includes(a)));
  ok('самопроверка вызвала только нового проверяющего (codex), дважды: верная копия и копия с ошибкой', calls.length === 2 && calls.every((c) => c.provider === 'codex'), JSON.stringify(calls.map((c) => c.provider)));
  ok('роли после role set claude: Claude Code делает, Codex проверяет', /Claude Code делает/.test(readAgents()) && /Codex проверяет/.test(readAgents()) && cfg().main === 'claude');
  r = wp(['role', 'set', 'codex', '--selftest-timeout', '90']);
  ok('role set codex с самопроверкой: проверяет Claude, самопроверка пройдена', r.code === 0 && /Этап P3\.selftest отмечен/.test(r.out) && wp(['verify', 'P3.selftest']).code === 0, r.all);
  ok('слепой проверяющий (STUB_MODE=lazy) самопроверку не проходит: код 1 и «слепая»', (() => { const x = wp(['role', 'set', 'claude', '--selftest-timeout', '90'], { env: env({ STUB_MODE: 'lazy' }) }); return x.code === 1 && /НЕ пройдена|не пройдена/.test(x.all); })());
  wp(['config', 'set', 'reviewer_model', 'gpt-x']);
  r = wp(['role', 'set', 'codex', '--no-selftest']);
  ok('модель прежнего проверяющего при смене сбрасывается (reviewer_model: null)', r.code === 0 && cfg().reviewer_model === null, JSON.stringify(cfg()));
  r = wp(['role', 'set', 'codex', '--no-selftest', '--reviewer-model', 'sonnet']);
  ok('--reviewer-model задаёт модель нового проверяющего', r.code === 0 && cfg().reviewer_model === 'sonnet');
  r = wp(['role', 'set', 'gemini']); ok('role set gemini: код 2', r.code === 2, r.all);
  r = wp(['role', 'set']); ok('role set без аргумента: код 2', r.code === 2, r.all);
  // согласованность ломается и чинится
  fs.writeFileSync(path.join(ROOT, 'AGENTS.md'), readAgents().replace(roleLine('codex', 0), roleLine('claude', 0)));
  const bad = require(path.join(H.KIT, 'core', 'lib', 'roles.js')).consistency(ROOT);
  ok('consistency замечает расхождение ролей в AGENTS.md', bad.some((p) => /AGENTS\.md/.test(p)), JSON.stringify(bad));
  r = wp(['role', 'set', 'codex', '--no-selftest']);
  ok('повторный role set чинит расхождение', r.code === 0 && require(path.join(H.KIT, 'core', 'lib', 'roles.js')).consistency(ROOT).length === 0, r.all);
  fs.appendFileSync(path.join(ROOT, '.claude', 'skills', 'cross-check', 'SKILL.md'), '\nправка\n');
  ok('consistency замечает навык, отличающийся от пакета', require(path.join(H.KIT, 'core', 'lib', 'roles.js')).consistency(ROOT).some((p) => /навык cross-check.*отличается/.test(p)));
  r = wp(['role', 'set', 'codex', '--no-selftest']);
  ok('role set возвращает навык к пакету', r.code === 0 && require(path.join(H.KIT, 'core', 'lib', 'roles.js')).consistency(ROOT).length === 0, r.all);
  wp(['role', 'set', 'claude', '--no-selftest']);

  // ---------- 5. adopt и вложенный .git ----------
  S.section('adopt: проект в главной папке (любой путь), вложенный .git в .gitignore');
  r = wp(['git-init', '--name', 'Test Person', '--email', 'test@example.com']);
  ok('git-init: код 0', r.code === 0, r.all);
  const mkProject = (dir, withGit) => {
    H.write(path.join(dir, 'README.md'), '# проект\n'); H.write(path.join(dir, 'src', 'main.js'), 'console.log(1)\n');
    if (withGit) { H.run('git', ['init', '-q', '-b', 'main', dir], { env: env() }); H.git(dir, ['config', 'user.name', 'T'], env()); H.git(dir, ['config', 'user.email', 't@example.com'], env()); H.git(dir, ['add', '.'], env()); H.git(dir, ['commit', '-q', '-m', 'first'], env()); }
    return dir;
  };
  const shop = mkProject(path.join(ROOT, 'shop'), true);
  const shopHash = H.treeHash(shop);
  r = wp(['adopt', 'shop']);
  ok('adopt shop (проект со своим git прямо в корне): код 0', r.code === 0, r.all);
  ok('в .gitignore главной папки дописано /shop/ (не только projects/)', H.read(path.join(ROOT, '.gitignore')).split(/\r?\n/).includes('/shop/'), H.read(path.join(ROOT, '.gitignore')).slice(-200));
  ok('git главной папки проект не видит (check-ignore)', H.git(ROOT, ['check-ignore', '-q', 'shop/src/main.js'], env()).code === 0);
  ok('git status главной папки не показывает shop', !/shop/.test(H.git(ROOT, ['status', '--short'], env()).out), H.git(ROOT, ['status', '--short'], env()).out);
  ok('копия проекта до первой правки лежит в .workplace/backups', fs.readdirSync(bk).some((f) => /adopt-shop/.test(f)) && fs.existsSync(path.join(bk, fs.readdirSync(bk).find((f) => /adopt-shop/.test(f)), 'src', 'main.js')));
  ok('сам проект adopt не изменил ни байта (хеш дерева с .git тот же)', H.treeHash(shop) === shopHash);
  ok('в выводе: копия сделана, .gitignore дополнен, git проект не видит', /Копия до правок/.test(r.out) && /В \.gitignore главной папки дописано/.test(r.out), r.out);
  r = wp(['adopt', 'shop']);
  ok('повторный adopt не дублирует строку в .gitignore', r.code === 0 && H.read(path.join(ROOT, '.gitignore')).split(/\r?\n/).filter((l) => l === '/shop/').length === 1 && /Уже закрыто/.test(r.out), r.all);
  ok('state.json помнит принятый проект', (H.readJson(path.join(ROOT, '.workplace', 'state.json')).projects || []).some((p) => p.dir === 'shop'));
  const deep = mkProject(path.join(ROOT, 'workspaces', 'client one', 'sub', 'app'), true);
  r = wp(['adopt', 'workspaces/client one/sub/app']);
  ok('adopt проекта на глубине с пробелом в пути: код 0 и строка точного пути', r.code === 0 && H.read(path.join(ROOT, '.gitignore')).split(/\r?\n/).includes('/workspaces/client one/sub/app/'), r.all);
  ok('проект на глубине закрыт для git главной папки', H.git(ROOT, ['check-ignore', '-q', 'workspaces/client one/sub/app/src/main.js'], env()).code === 0);
  const plain = mkProject(path.join(ROOT, 'notes-project'), false);
  const giBefore = H.read(path.join(ROOT, '.gitignore'));
  r = wp(['adopt', 'notes-project']);
  ok('проект без своего git: код 0, .gitignore не меняется, сказано, что .git нет', r.code === 0 && H.read(path.join(ROOT, '.gitignore')) === giBefore && /Своего \.git у проекта нет/.test(r.out), r.all);
  const proj2 = mkProject(path.join(ROOT, 'projects', 'p2'), true);
  r = wp(['adopt', 'projects/p2']);
  ok('проект в projects/ уже закрыт шаблоном: «Уже закрыто», строк не добавлено', r.code === 0 && /Уже закрыто/.test(r.out) && H.read(path.join(ROOT, '.gitignore')) === giBefore, r.all);
  // вложенный репозиторий, о котором adopt не просили
  mkProject(path.join(ROOT, 'workspaces', 'lone', 'tool'), true);
  r = wp(['gitignore', 'check']);
  ok('gitignore check находит вложенный репозиторий без строки и даёт код 1', r.code === 1 && /Вложенные репозитории не закрыты в \.gitignore: workspaces\/lone\/tool/.test(r.out), r.all);
  r = wp(['gitignore', 'nested', '--dry-run']);
  ok('gitignore nested --dry-run показывает, но не пишет', r.code === 0 && /Добавил бы/.test(r.out) && !H.read(path.join(ROOT, '.gitignore')).includes('/workspaces/lone/tool/'), r.all);
  r = wp(['gitignore', 'nested']);
  ok('gitignore nested дописывает', r.code === 0 && H.read(path.join(ROOT, '.gitignore')).split(/\r?\n/).includes('/workspaces/lone/tool/'), r.all);
  r = wp(['gitignore', 'check']);
  ok('gitignore check после этого зелёный', r.code === 0, r.all);
  ok('git add по именам и git status главной папки не видят ни один вложенный проект', !/shop|notes-project|workspaces\/lone|client one/.test(H.git(ROOT, ['status', '--short'], env()).out.replace(/notes-project/, '')), H.git(ROOT, ['status', '--short'], env()).out);
  r = wp(['adopt', 'no-such-dir']); ok('adopt несуществующей папки: код 2', r.code === 2, r.all);
  r = wp(['adopt', ROOT]); ok('adopt самой главной папки: отказ', r.code === 2, r.all);
  r = wp(['adopt', HOME]); ok('adopt папки, внутри которой лежит главная: отказ (код 3)', r.code === 3, r.all);
  r = wp(['adopt', '.workplace']); ok('adopt служебной папки .workplace: отказ (код 3)', r.code === 3, r.all);
  // проект снаружи: копия с историей через migrate-project
  const ext = H.makeForeignRepo(path.join(HOME, 'ext-shop'), env(), 'ext-shop');
  const extHash = H.treeHash(ext);
  const extHead = H.git(ext, ['rev-parse', 'HEAD'], env()).out;
  r = wp(['adopt', ext, '--name', 'ext-shop']);
  ok('adopt внешнего проекта: код 0', r.code === 0, r.all);
  ok('копия лежит в projects/ext-shop, история та же (тот же HEAD)', H.exists(path.join(ROOT, 'projects', 'ext-shop', '.git')) && H.git(path.join(ROOT, 'projects', 'ext-shop'), ['rev-parse', 'HEAD'], env()).out === extHead, r.out.slice(-400));
  ok('исходный внешний проект не изменён (хеш дерева)', H.treeHash(ext) === extHash);
  ok('git главной папки внешний проект не видит', H.git(ROOT, ['check-ignore', '-q', 'projects/ext-shop/src/app.py'], env()).code === 0);
  ok('state.json помнит копию', (H.readJson(path.join(ROOT, '.workplace', 'state.json')).projects || []).some((p) => p.dir === 'projects/ext-shop' && p.kind === 'outside'));
  r = wp(['adopt', ext, '--name', 'ext-shop']);
  ok('повторная копия под тем же именем не перезаписывает: отказ, исходник цел', r.code !== 0 && H.treeHash(ext) === extHash, r.all);

  // ---------- 6. исполнитель Codex ----------
  S.section('delegate: «отдай задачу Codex» выполняется (codex exec --sandbox workspace-write)');
  const codex = require(path.join(H.KIT, 'core', 'providers', 'codex.js'));
  const ra = codex.runArgs({ dir: '/d', outFile: '/o.md' });
  ok('runArgs: exec, --sandbox workspace-write, -C папка, -o файл, задание через stdin', ra[0] === 'exec' && ra[ra.indexOf('--sandbox') + 1] === 'workspace-write' && ra[ra.indexOf('-C') + 1] === '/d' && ra[ra.indexOf('-o') + 1] === '/o.md' && ra[ra.length - 1] === '-', ra.join(' '));
  ok('runArgs не read-only, а проверяющий остался read-only', !ra.includes('read-only') && codex.reviewArgs({ dir: '/d', outFile: '/o.md' }).includes('read-only'));
  ok('runArgs: модель из параметра', codex.runArgs({ dir: '/d', outFile: '/o.md', model: 'terra' }).includes('terra'));
  wp(['role', 'set', 'claude', '--no-selftest']);
  fs.writeFileSync(LOG, '');
  r = wp(['delegate', 'Сделай', 'заметку', 'в', 'файл', 'notes.md']);
  ok('delegate (основной Claude -> исполнитель Codex): код 0, итог показан', r.code === 0 && /Готово за/.test(r.out) && /ВЕРДИКТ|stub|Прочитано/.test(r.out), r.all);
  const dl = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.provider === 'codex' && l.argv.includes('exec'));
  ok('Codex запущен: exec, workspace-write, в папке главной (cwd), без read-only', dl.length === 1 && dl[0].argv.includes('workspace-write') && !dl[0].argv.includes('read-only') && fs.realpathSync(dl[0].cwd).toLowerCase() === fs.realpathSync(ROOT).toLowerCase(), JSON.stringify(dl));
  ok('итог задачи сохранён в .workplace/delegate/<метка>/answer.md', (() => { const d = path.join(ROOT, '.workplace', 'delegate'); return H.exists(d) && fs.readdirSync(d).some((x) => H.exists(path.join(d, x, 'answer.md'))); })());
  H.write(path.join(TMP, 'task.txt'), 'Задание из файла\n');
  r = wp(['delegate', '--task-file', path.join(TMP, 'task.txt')]);
  ok('delegate --task-file: код 0', r.code === 0, r.all);
  r = wp(['delegate']); ok('delegate без задания: код 2', r.code === 2, r.all);
  r = wp(['delegate', '--to', 'claude', 'сделай']); ok('delegate --to claude: честный отказ (исполнитель Claude не подключён), код 2', r.code === 2 && /Исполнителем может быть пока только Codex/.test(r.err + r.out), r.all);
  r = wp(['delegate', '--dir', path.join(HOME, 'work', 'shop'), 'сделай']);
  ok('delegate в папку вне главной без «да» человека: отказ (код 3)', r.code === 3 && /вне главной папки/.test(r.err + r.out), r.all);
  human('Отдай Codex задачу в моём проекте ~/work/shop'); human('да');
  r = wp(['delegate', '--dir', path.join(HOME, 'work', 'shop'), 'сделай']);
  ok('delegate в проект человека после «да» и названной папки: код 0', r.code === 0, r.all);
  human('отдай Codex задачу в ~/work/shop'); human('да');
  r = wp(['delegate', '--dir', path.join(HOME, 'old-tmp'), 'сделай']);
  ok('delegate в другую папку: отказ, «да» к ней не относится', r.code === 3, r.all);
  r = wp(['delegate', 'сделай'], { env: env({ STUB_MODE: 'quota' }) });
  ok('лимит Codex: код 1 и подсказка про лимит', r.code === 1 && /лимит/i.test(r.out), r.all);
  r = wp(['delegate', 'сделай'], { env: env({}, BIN_CLAUDE) });
  ok('Codex не установлен: код 1, честное сообщение', r.code === 1 && /не найдена|не запускается|not-installed/.test(r.out), r.all);
  wp(['role', 'set', 'codex', '--no-selftest']);
  r = wp(['delegate', 'сделай']);
  ok('основной Codex: --to по умолчанию claude, у него запуска задач нет: честный отказ (код 2)', r.code === 2, r.all);
  wp(['role', 'set', 'claude', '--no-selftest']);

  // ---------- 7. вне главной папки ничего не изменилось ----------
  S.section('вне главной папки');
  const outsideAfter = H.treeMap(HOME, ['workplace', 'ext-shop']);
  const dd = H.mapDiff(outsideBefore, outsideAfter);
  ok('фейковый HOME вне главной папки байт-в-байт тот же (кроме ~/.zshrc? нет: сторож только разрешил, правит ИИ, не тест)', dd.changed.length === 0 && dd.removed.length === 0, H.mapDiffText(outsideBefore, outsideAfter));
} catch (e) {
  ok('прогон дошёл до конца без исключения', false, e && e.stack);
} finally {
  H.rmTree(TMP);
}
process.exit(S.finish());
