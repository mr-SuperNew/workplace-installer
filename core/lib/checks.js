'use strict';
// Проверки этапов: общие для `wp.js verify` и `wp.js report` (отчёт и итог берут ОДИН результат каждой проверки, поэтому не противоречат себе).
// Вход определяется по `<программа> login status` / `claude auth status`, а не по файлу; `claude auth status` создаёт файлы и запускается только с live: true (после «да»).
const fs = require('fs');
const path = require('path');
const u = require('./util');
const rootLib = require('./root');
const config = require('./config');
const state = require('./state');
const recon = require('./recon');
const layout = require('./layout');
const wiring = require('./wiring');
const providers = require('../providers');
const runproof = require('./runproof');

// Привязка самопроверки к пакету: версия пакета и хеши вымышленных данных в манифесте должны совпадать с теми, что лежат в .workplace сейчас.
const FIXTURE = { 'selftest-good': 'result.md', 'selftest-bad': 'result-with-error.md' };
function selftestBinding(c, m) {
  const ver = (u.readText(path.join(c.p.mark, 'VERSION')) || '').trim();
  if (!m.kit_version || m.kit_version !== ver) return 'проверка сделана на пакете ' + (m.kit_version || 'неизвестной версии') + ', сейчас ' + (ver || '?');
  const fx = path.join(c.p.mark, 'core', 'skills', 'cross-check', 'fixtures', 'selftest');
  const need = [['result', FIXTURE[m.label]], ['source', 'input.md']];
  for (const [role, name] of need) {
    const want = u.sha256File(path.join(fx, name));
    const f = (m.files || []).find((x) => x.role === role && x.path === 'selftest/' + name);
    if (!want || !f || f.sha256 !== want) return 'данные selftest/' + name + ' не совпадают с данными пакета (самопроверка делается только на них)';
  }
  return null;
}

function providerCheck(name, role, ctx) {
  const p = providers.get(name);
  const d = ctx.detect(name);
  const needConsole = role === 'reviewer';
  if (needConsole ? d.console : d.present) {
    return { ok: true, detail: d.console ? p.label + ' ' + d.primary.version + ' (' + u.tilde(d.primary._abs) + ')' : p.label + ' есть в расширении VS Code ' + d.extension.version + '; консольной команды нет' };
  }
  const bad = d.copies.filter((c) => !c.usable);
  return { ok: false, detail: bad.length ? p.label + ' найден, но не запускается (' + (bad[0].error || '?') + ')' : p.label + (needConsole ? ' (консольная команда) не найден' : ' не найден') };
}
function loginCheck(name, ctx) {
  const p = providers.get(name);
  const d = ctx.detect(name);
  if (!d.console) {
    if (name === ctx.cfg.main && d.extension) return { ok: true, detail: 'работает через расширение VS Code (вход виден по работе панели)' };
    return { ok: false, detail: 'нет консольной команды ' + p.name + ': входа не проверить' };
  }
  if (!ctx.live) {
    if (d.login_hint.state === 'present') return { ok: true, detail: 'признак входа есть; живая проверка не запускалась (добавь --live: после «да»)' };
    return { ok: false, detail: 'признака входа нет: вход в браузере делает человек' };
  }
  const st = p.loginStatus({ confirmed: true, detect: d });
  if (st.state === 'ok') return { ok: true, detail: 'вход выполнен (' + (st.method || 'способ не назван') + ')' };
  if (st.state === 'api-key') return { ok: false, detail: st.detail };
  return { ok: false, detail: st.detail };
}

const CHECKS = {
  'P0.recon': (c) => ({ ok: u.exists(c.p.reconBefore) || (c.s && c.s.stages['P0.recon'].status === 'done'), detail: 'разведка выполнена' }),
  'P1.root': (c) => ({ ok: u.exists(c.p.state) && u.exists(c.p.config) && u.exists(c.p.cli), detail: 'главная папка ' + u.tilde(c.root) + ', пакет в .workplace' + (c.cfg._invalid ? '; config.json: ' + c.cfg._invalid.join('; ') : '') }),
  'P1.node': () => { const v = u.ver(process.version); return { ok: u.atLeast(v, recon.MIN.node), detail: 'Node ' + process.version + ' (нужен 18 или новее)' }; },
  'P1.python': () => { const t = recon.collectTools(); return t.python.version ? { ok: true, detail: 'Python ' + t.python.version } : { ok: false, detail: 'Python не найден' + (t.python.stubs.length ? ' (есть только заглушка системы)' : '') }; },
  'P1.git': () => { const g = recon.gitStatus(); if (!g.ok) return { ok: false, detail: g.note }; return { ok: true, detail: (u.run(g.path, ['--version']).out || 'git') }; },
  'P1.main': (c) => providerCheck(c.cfg.main, 'main', c),
  'P1.reviewer': (c) => providerCheck(c.cfg.reviewer, 'reviewer', c),
  'P1.main-login': (c) => loginCheck(c.cfg.main, c),
  'P1.reviewer-login': (c) => loginCheck(c.cfg.reviewer, c),
  'P1.vscode': () => { const v = require('./vscode').collect(); return { ok: !!v.version, detail: v.version ? 'VS Code ' + v.version : 'VS Code не найден (по выбору)' }; },
  'P2.core': (c) => {
    const miss = [];
    for (const f of ['AGENTS.md', 'CLAUDE.md', 'tasks.md', 'MEMORY.md', '.gitignore', 'STATE.md']) if (!u.exists(path.join(c.root, f))) miss.push(f);
    const am = u.readText(path.join(c.root, 'AGENTS.md')) || '';
    if (am.startsWith(layout.BOOT_MARK)) miss.push('AGENTS.md ещё временный (layout не выполнялся)');
    const cm = u.readText(path.join(c.root, 'CLAUDE.md')) || '';
    if (cm && !/^\s*@AGENTS\.md\s*$/m.test(cm)) miss.push('в CLAUDE.md нет строки @AGENTS.md');
    const gm = u.exists(path.join(c.root, '.gitignore')) ? layout.gitignoreMissing(c.root) : [];
    if (gm.length) miss.push('в .gitignore не хватает: ' + gm.join(', '));
    for (const sk of layout.skillSources(c.root)) for (const base of [c.p.claudeSkills, c.p.agentsSkills]) if (!u.exists(path.join(base, sk, 'SKILL.md'))) miss.push(path.basename(path.dirname(base)) + '/skills/' + sk);
    if (c.cfg.main === 'codex' && layout.codexNetConfigState(u.readText(path.join(c.root, '.codex', 'config.toml'))) !== 'ok') miss.push('.codex/config.toml: нет sandbox_workspace_write.network_access = true (основной Codex вызывает проверяющего Claude из песочницы; wp.js layout её пишет)');
    const bad = config.validate(c.cfg); if (bad.length) miss.push('config.json: ' + bad.join('; '));
    return { ok: !miss.length, detail: miss.length ? 'не хватает: ' + miss.join('; ') : 'правила, память, навыки и настройки на месте' };
  },
  'P2.hooks': (c) => {
    const rows = layout.hooksStatus(c.root);
    const present = rows.filter((r) => r.present);
    if (!present.length) return { ok: false, detail: 'в пакете нет хуков (core/hooks пуст)' };
    const prob = [];
    for (const r of present) {
      if (r.syntax === false) prob.push(r.hook + ': ошибка синтаксиса');
      if (r.claude.wanted && !r.claude.wired) prob.push(r.hook + ': не подключён в .claude/settings.json');
      if (r.codex.wanted && !r.codex.wired) prob.push(r.hook + ': не подключён в .codex/hooks.json');
    }
    const tp = wiring.templatePaths();
    const want = (wiring.renderTemplate(tp.claude, c.root).permissions || {}).allow || [];
    const have = ((u.readJson(c.p.claudeSettings) || {}).permissions || {}).allow || [];
    const noPerm = want.filter((r) => !have.includes(r));
    if (noPerm.length) prob.push('нет разрешений на скрипты пакета (' + noPerm.length + '): wp.js hooks wire');
    const absent = rows.filter((r) => !r.present).map((r) => r.hook);
    return { ok: !prob.length && !absent.length, detail: prob.length || absent.length ? (prob.concat(absent.length ? ['нет в пакете: ' + absent.join(', ')] : [])).join('; ') : 'все сторожа подключены в оба провайдера и проходят проверку синтаксиса' };
  },
  'P2.git': (c) => {
    const gs = recon.gitStatus();
    if (!gs.ok) return { ok: false, detail: gs.note };
    const top = layout.gitTop(gs.path, c.root);
    if (!top || !u.same(top, c.root)) return { ok: false, detail: 'главная папка не является git-репозиторием' };
    const n = u.run(gs.path, ['-C', c.root, 'rev-list', '--count', 'HEAD']);
    const rm = u.run(gs.path, ['-C', c.root, 'remote']).out;
    return { ok: n.ok && +n.out >= 1, detail: n.ok ? 'коммитов ' + n.out + (rm ? ', удалённый адрес: ' + rm + ' (добавил человек)' : ', без удалённого адреса') : 'нет коммитов' };
  },
  'P3.hooks-test': (c) => { const r = layout.hooksTest(c.root); return { ok: !r.bad.length, detail: r.bad.length ? r.bad.join('; ') : 'сторожа (' + r.checked + ') отвечают на тестовые вводы как положено' }; },
  'P3.selftest': (c) => {
    const dir = c.p.checks;
    let ds = []; try { ds = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort(); } catch (_) { ds = []; }
    const all = ds.map((d) => ({ d, m: u.readJson(path.join(dir, d, 'manifest.json')) })).filter((x) => x.m && x.m.status === 'checked');
    const label = providers.get(c.cfg.reviewer).label;
    // Самопроверка засчитывается только за того проверяющего, который сейчас записан в config.json: после `config set main ...` старые GREEN и RED
    // от другого проверяющего не доказывают ничего про нового. В манифесте проверяющий записывается как reviewer (prepare-check.js); манифест без него не засчитывается.
    const mine = all.filter((x) => x.m.reviewer === c.cfg.reviewer && /^selftest-(good|bad)$/.test(x.m.label || ''));
    // H1: засчитывается только проверка с доказательством настоящего запуска проверяющего (run.json от run-check.js, хеш verdict.md, время, проверяющий), а не рукописный verdict.md.
    // M6: и только на этом же пакете и на тех же вымышленных данных, что лежат в пакете (после update и правки данных старая пара не засчитывается).
    const unproven = [];
    const accept = (x) => {
      const pr = runproof.verifyAccepted(path.join(dir, x.d), x.m, c.cfg.reviewer);
      if (!pr.ok) { unproven.push(x.d + ': ' + pr.problems[0]); return false; }
      const b = selftestBinding(c, x.m);
      if (b) { unproven.push(x.d + ': ' + b); return false; }
      return true;
    };
    const good = mine.find((x) => x.m.label === 'selftest-good' && ['GREEN', 'YELLOW'].includes(x.m.verdict) && accept(x));
    const bad = mine.find((x) => x.m.label === 'selftest-bad' && x.m.verdict === 'RED' && accept(x));
    if (good && bad) return { ok: true, detail: 'самопроверка пройдена проверяющим ' + label + ' (запуск подтверждён run.json): верный результат ' + good.m.verdict + ', результат с вшитой ошибкой RED' };
    const other = all.filter((x) => /^selftest-(good|bad)$/.test(x.m.label || '') && x.m.reviewer !== c.cfg.reviewer);
    if (unproven.length) return { ok: false, detail: 'самопроверка не засчитана: нет доказательства, что проверяющий ' + label + ' запускался на этих данных (' + unproven.slice(0, 2).join('; ') + '). Повтори selftest-run.js: вердикт руками не пишется' };
    if (other.length) return { ok: false, detail: 'самопроверка проходила другим проверяющим (' + [...new Set(other.map((x) => x.m.reviewer || 'не записан'))].join(', ') + '), а сейчас проверяет ' + c.cfg.reviewer + ': повтори selftest-run.js' };
    return { ok: false, detail: 'нет принятых проверок selftest-good (GREEN или YELLOW) и selftest-bad (RED) от проверяющего ' + c.cfg.reviewer + ' в checks/' };
  },
  'P5.report': (c) => ({ ok: u.exists(c.p.report), detail: 'install-report.md в главной папке' }),
};

function context(root, o) {
  o = o || {};
  const cache = {};
  const cfg = config.load(root);
  return {
    root, p: rootLib.paths(root), cfg, s: state.load(root), live: !!o.live,
    detect(name) { if (!cache[name]) cache[name] = providers.get(name).detect(); return cache[name]; },
  };
}
// Одна проверка. Возвращает { ok, detail }; ошибка внутри проверки = «не ок» с текстом.
function run(id, ctx) {
  if (!CHECKS[id]) throw new u.WpError('Нет такого этапа: ' + id + '. Этапы: ' + state.STAGE_IDS.join(', '), 2);
  try { return CHECKS[id](ctx); } catch (e) { return { ok: false, detail: 'ошибка проверки: ' + e.message }; }
}
function runAll(root, ids, o) {
  const ctx = context(root, o);
  const out = {};
  for (const id of ids || state.STAGE_IDS) out[id] = run(id, ctx);
  return out;
}

module.exports = { CHECKS, context, run, runAll };
