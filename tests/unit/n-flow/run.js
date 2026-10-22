#!/usr/bin/env node
'use strict';
// Этап N: флаги согласия, которые ИИ мог передать сам (--yes, --overwrite, --update), больше «да» человека не заменяют.
//   update apply        «да» берётся из записанных сообщений человека (хук human-message): «да» в последнем и «обнови»/«update» или версия в двух последних либо принятый план
//   update --overwrite  каждый файл, который правил или удалил человек, назван им (путь, хвост пути или имя файла) либо в принятом плане; папка-родитель файл не называет
//   update --human-said не принимается (в главной папке сторож сообщений подключён всегда)
//   focus-view          apply и revert (настройки VS Code вне главной папки): те же правила; сам модуль проверяется в modules/vscode/focus-view.test.js
//   layout --update     перед заменой файла навыка кладёт копию прежнего в .workplace/backups
//   охват               каждый файл ядра и модулей, где разбирается флаг согласия, обязан вызывать проверку сообщений человека или стоять в списке исключений с причиной
// Работа идёт настоящими wp.js и хуками в фейковом HOME; живые модели не запускаются. Настоящие ~/.claude и ~/.codex не трогаются.
//   node tests/unit/n-flow/run.js
const fs = require('fs');
const path = require('path');
const H = require('../../lib/harness');
const stubsLib = require('../../lib/stubs');

const S = new H.Suite('n-flow');
const ok = (n, c, d) => S.ok(n, c, d);
const TMP = H.mkTmp('wp-nflow-');
const HOME = path.join(TMP, 'home');
fs.mkdirSync(HOME, { recursive: true });
const BIN = stubsLib.prepare(path.join(TMP, 'bin'), ['python', 'python3', 'codex', 'claude']);
const ENV = H.sandboxEnv(HOME, { path: H.minPath([BIN]), extra: { STUB_LOG: path.join(TMP, 'stub.log') } });
const text = (p) => fs.readFileSync(p, 'utf8');
const fwd = (p) => p.replace(/\\/g, '/');
const REL = (f) => '.workplace/' + f.replace(/\\/g, '/');

function mkRoot(name) {
  const root = path.join(HOME, name);
  const r = H.node(H.WP_SRC, ['init', '--root', root, '--main', 'claude', '--no-scan'], { cwd: TMP, env: ENV });
  if (r.code !== 0) throw new Error('init: ' + r.all);
  const l = H.node(path.join(root, '.workplace', 'core', 'cli', 'wp.js'), ['layout'], { cwd: root, env: ENV });
  if (l.code !== 0) throw new Error('layout: ' + l.all);
  return root;
}
const wpIn = (root, args) => H.node(path.join(root, '.workplace', 'core', 'cli', 'wp.js'), args, { cwd: root, env: ENV });
const says = (root, t) => H.humanSays(root, t, ENV);

try {
  // ---------- новая версия пакета ----------
  const kit2 = path.join(TMP, 'kit2');
  (function cp(src, dst) { fs.mkdirSync(dst, { recursive: true }); for (const it of fs.readdirSync(src, { withFileTypes: true })) { if (['node_modules', '.git', 'release', 'dist', 'tests', 'scripts', '.github'].includes(it.name)) continue; const s = path.join(src, it.name), d = path.join(dst, it.name); if (it.isDirectory()) cp(s, d); else fs.copyFileSync(s, d); } })(H.KIT, kit2);
  const VER = '4.0.3-test';
  fs.writeFileSync(path.join(kit2, 'VERSION'), VER + '\n');
  const reminder = path.join('core', 'hooks', 'feedback-reminder.js'), modelGuard = path.join('core', 'hooks', 'model-guard.js'), casesDoc = path.join('docs', 'cases.md');
  for (const f of [reminder, modelGuard, casesDoc]) fs.appendFileSync(path.join(kit2, f), '\n// обновлено в ' + VER + '\n');
  const wp2 = (args) => H.node(path.join(kit2, 'core', 'cli', 'wp.js'), args, { cwd: TMP, env: ENV });

  S.section('update apply: один флаг --yes «да» не заменяет');
  const root = mkRoot('root-n1');
  const remSha0 = H.sha(path.join(root, REL(reminder)));
  const tree0 = H.treeHash(root);
  let r = wp2(['update', 'plan', '--root', root]);
  ok('plan работает без сообщений человека (ничего не пишет) и называет, что нужно для apply', r.code === 0 && H.treeHash(root) === tree0 && /обнови/.test(r.out) && /не является/.test(r.out), r.all);
  r = wp2(['update', 'apply', '--root', root, '--yes']);
  ok('сообщений человека нет: отказ (код 3), «один флаг --yes подтверждением не является», ничего не изменено', r.code === 3 && /Один флаг --yes подтверждением не является/.test(r.all) && /не видит сообщений человека/.test(r.all) && H.treeHash(root) === tree0, r.all);
  r = wp2(['update', 'apply', '--root', root, '--yes', '--human-said', 'да, обнови']);
  ok('--human-said у update не принимается (код 2): слова «от ИИ» там не нужны, сторож подключён всегда', r.code === 2 && /не принимает --human-said/.test(r.all) && H.treeHash(root) === tree0, r.all);
  says(root, 'Обнови установщик');
  r = wp2(['update', 'apply', '--root', root, '--yes']);
  ok('просьба «обнови» есть, «да» нет: отказ (код 3) с фразой «покажи человеку план обновления и дождись его «да»»', r.code === 3 && /нет «да»/.test(r.all) && /Покажи человеку план обновления/.test(r.all) && /дождись его «да»/.test(r.all) && H.sha(path.join(root, REL(reminder))) === remSha0, r.all);
  says(root, 'нет, подожди, не обновляй');
  r = wp2(['update', 'apply', '--root', root, '--yes']);
  ok('«нет, не обновляй» не считается «да» (код 3)', r.code === 3 && /нет «да»/.test(r.all) && H.sha(path.join(root, REL(reminder))) === remSha0, r.all);
  says(root, 'Привет, как дела');
  says(root, 'да');
  r = wp2(['update', 'apply', '--root', root, '--yes']);
  ok('«да» есть, но «обнови» и версии в двух последних сообщениях нет: отказ (код 3), файлы не тронуты', r.code === 3 && /нет слова «обнови»/.test(r.all) && H.sha(path.join(root, REL(reminder))) === remSha0, r.all);
  says(root, 'Давай версию 9.9.9');
  says(root, 'да');
  r = wp2(['update', 'apply', '--root', root, '--yes']);
  ok('«да» на другую версию (9.9.9) обновление до ' + VER + ' не покрывает (код 3)', r.code === 3 && H.sha(path.join(root, REL(reminder))) === remSha0, r.all);
  says(root, 'да, обнови');
  r = wp2(['update', 'apply', '--root', root, '--yes']);
  ok('«да, обнови» в последнем сообщении: apply проходит (код 0), файл обновлён', r.code === 0 && H.sha(path.join(root, REL(reminder))) === H.sha(path.join(kit2, reminder)), r.all);
  const st = H.readJson(path.join(root, '.workplace', 'state.json'));
  ok('в state.json у обновления записано, откуда «да»: сообщение человека, а не флаг', st.updates && st.updates[0] && /сообщение человека/.test((st.updates[0].confirmation || {}).via || ''), JSON.stringify(st.updates && st.updates[0]));

  S.section('update apply: версия вместо слова «обнови», английское «update», принятый план');
  const root2 = mkRoot('root-n2');
  says(root2, 'ставь ' + VER); says(root2, 'да');
  r = wp2(['update', 'apply', '--root', root2, '--yes']);
  ok('версия пакета названа + «да»: проходит (код 0)', r.code === 0 && H.sha(path.join(root2, REL(reminder))) === H.sha(path.join(kit2, reminder)), r.all);
  const root3 = mkRoot('root-n3');
  says(root3, 'please update the workplace'); says(root3, 'yes');
  r = wp2(['update', 'apply', '--root', root3, '--yes']);
  ok('английские «update» и «yes»: проходит (код 0)', r.code === 0 && H.sha(path.join(root3, REL(reminder))) === H.sha(path.join(kit2, reminder)), r.all);
  const root4 = mkRoot('root-n4');
  r = wpIn(root4, ['consent', 'plan', 'Обновляю пакет до ' + VER + ': обновятся хуки и документы, ваши файлы не трогаю']);
  ok('план зарегистрирован (consent plan)', r.code === 0, r.all);
  says(root4, 'подожди секунду');
  says(root4, 'да');
  r = wp2(['update', 'apply', '--root', root4, '--yes']);
  ok('человек сначала написал другое, потом «да»: план не принят, «обнови» в сообщениях нет, отказ (код 3)', r.code === 3 && H.sha(path.join(root4, REL(reminder))) === remSha0, r.all);
  wpIn(root4, ['consent', 'plan', 'Обновляю пакет до ' + VER + ': обновятся хуки и документы, ваши файлы не трогаю']);
  says(root4, 'да');
  r = wp2(['update', 'apply', '--root', root4, '--yes']);
  ok('первое сообщение после плана «да», в плане названа версия: проходит (код 0)', r.code === 0 && H.sha(path.join(root4, REL(reminder))) === H.sha(path.join(kit2, reminder)), r.all);

  S.section('update apply --overwrite: файл, который правил или удалил человек, должен быть назван');
  const root5 = mkRoot('root-n5');
  fs.appendFileSync(path.join(root5, REL(modelGuard)), '\n// моя правка в хуке\n');
  fs.rmSync(path.join(root5, REL(casesDoc)));
  const editedSha = H.sha(path.join(root5, REL(modelGuard)));
  says(root5, 'да, обнови');
  const tree5 = H.treeHash(root5);
  r = wp2(['update', 'apply', '--root', root5, '--yes', '--overwrite', REL(modelGuard)]);
  ok('«да, обнови» файл model-guard.js не называет: --overwrite отказ (код 3), правка человека цела, дерево то же', r.code === 3 && /не назвал/.test(r.all) && /model-guard\.js/.test(r.all) && H.sha(path.join(root5, REL(modelGuard))) === editedSha && H.treeHash(root5) === tree5, r.all);
  says(root5, 'да, замени всё в ' + fwd(path.join(root5, '.workplace', 'core', 'hooks')));
  r = wp2(['update', 'apply', '--root', root5, '--yes', '--overwrite', REL(modelGuard)]);
  ok('назвать папку с файлом мало: --overwrite отказ (код 3), правка человека цела', r.code === 3 && /не назвал/.test(r.all) && H.sha(path.join(root5, REL(modelGuard))) === editedSha, r.all);
  says(root5, 'да, замени model-guard.js, а ещё верни docs/cases.md и обнови');
  r = wp2(['update', 'apply', '--root', root5, '--yes', '--overwrite', REL(modelGuard) + ',' + REL(casesDoc)]);
  ok('файлы названы (по имени и по хвосту пути): заменён файл с правкой и восстановлен удалённый (код 0)', r.code === 0 && H.sha(path.join(root5, REL(modelGuard))) === H.sha(path.join(kit2, modelGuard)) && H.sha(path.join(root5, REL(casesDoc))) === H.sha(path.join(kit2, casesDoc)), r.all);
  ok('копия правки человека лежит в backup-update', fs.readdirSync(path.join(root5, '.workplace', 'backup-update')).some((d) => { const f = path.join(root5, '.workplace', 'backup-update', d, REL(modelGuard)); return fs.existsSync(f) && text(f).includes('моя правка в хуке'); }));
  const root6 = mkRoot('root-n6');
  fs.appendFileSync(path.join(root6, REL(modelGuard)), '\n// моя правка в хуке\n');
  wpIn(root6, ['consent', 'plan', 'Обновляю пакет до ' + VER + ' и заменяю ' + REL(modelGuard) + ' (вы его правили, копия прежнего останется)']);
  says(root6, 'да');
  r = wp2(['update', 'apply', '--root', root6, '--yes', '--overwrite', REL(modelGuard)]);
  ok('файл назван в принятом плане: --overwrite проходит (код 0)', r.code === 0 && H.sha(path.join(root6, REL(modelGuard))) === H.sha(path.join(kit2, modelGuard)), r.all);

  S.section('layout --update: перед заменой файла навыка лежит копия прежнего');
  const root7 = mkRoot('root-n7');
  const skill = path.join(root7, '.claude', 'skills', 'new-workspace', 'SKILL.md');
  fs.appendFileSync(skill, '\nМоя строка в навыке.\n');
  r = wpIn(root7, ['layout']);
  ok('layout без --update правку человека не трогает', /ОТЛИЧАЕТСЯ, не перезаписан/.test(r.out) && text(skill).includes('Моя строка в навыке.'), r.all);
  r = wpIn(root7, ['layout', '--update']);
  const bdir = path.join(root7, '.workplace', 'backups');
  const copies = fs.existsSync(bdir) ? fs.readdirSync(bdir).filter((f) => /SKILL\.md/.test(f)) : [];
  ok('layout --update: навык заменён пакетным, в выводе названа копия прежнего', /обновлён: \.claude\/skills\/new-workspace\/SKILL\.md \(копия прежнего: \.workplace\/backups\//.test(r.out) && !text(skill).includes('Моя строка в навыке.'), r.all);
  ok('копия прежнего навыка с правкой человека лежит в .workplace/backups', copies.some((f) => text(path.join(bdir, f)).includes('Моя строка в навыке.')), copies.join(', '));

  S.section('охват: где ещё разбирается флаг согласия');
  // Файл, где в коде встречается разбор флага согласия, обязан вызывать проверку сообщений человека (requireHuman, requireHumanUpdate) или стоять в списке исключений с причиной.
  const RX_FLAG = /(\bo\.yes\b|\bflags\.yes\b|\bflags\['yes'\]|!!flags\.yes|includes\('--yes'\)|'--yes'|BOOL = new Set\(\[[^\]]*'yes')/;
  const CHECKED = { 'core/lib/install.js': /requireHuman\(/, 'core/lib/update.js': /requireHumanUpdate\(/, 'modules/vscode/focus-view.js': /requireHuman\(root, 'apply'\)[\s\S]*requireHuman\(root, 'revert'\)/ };
  const EXCEPT = {
    'core/cli/wp.js': 'только передаёт флаг в install, path-fix и update; проверка в них (флаг snapshot --force заново снимает снимок «до» внутри .workplace, данных человека не трогает)',
    'core/lib/adopt.js': 'вызывает copy модуля migrate-project для проекта, лежащего снаружи: это копия в НОВУЮ папку внутри главной папки с резервной копией, исходник не меняется (то же исключение, что у самого модуля)',
    'modules/migrate-project/migrate-project.js': 'копирует проект в НОВУЮ папку projects/<имя> внутри главной папки, существующее не перезаписывает, исходник не меняет и не удаляет, сделана резервная копия: не необратимое; договор разрешает «копировать проекты в главную папку» по просьбе человека',
  };
  const found = [];
  (function walk(d) {
    for (const it of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, it.name);
      if (it.isDirectory()) { if (!/^(tests|node_modules|\.git|release|dist|\.github)$/.test(it.name)) walk(p); continue; }
      if (!/\.js$/.test(it.name) || /\.test\.js$/.test(it.name)) continue;
      const rel = fwd(path.relative(H.KIT, p));
      if (RX_FLAG.test(text(p))) found.push(rel);
    }
  })(H.KIT);
  ok('найдены все файлы с разбором флага согласия (install, update, wp.js, adopt, focus-view, migrate-project)', ['core/lib/install.js', 'core/lib/update.js', 'core/cli/wp.js', 'core/lib/adopt.js', 'modules/vscode/focus-view.js', 'modules/migrate-project/migrate-project.js'].every((f) => found.includes(f)), found.join(', '));
  for (const f of found) {
    const checked = CHECKED[f] && CHECKED[f].test(text(path.join(H.KIT, f)));
    ok('разбор флага согласия в ' + f + ': есть проверка сообщений человека или исключение с причиной', !!checked || !!EXCEPT[f], f);
  }
  ok('исключения не пустые отговорки (причина длиннее 60 знаков)', Object.values(EXCEPT).every((w) => w.length > 60));
  ok('wp.js: --human-said принимают только install и path-fix', (() => { const t = text(path.join(H.KIT, 'core', 'cli', 'wp.js')); return (t.match(/humanSaid: flags\['human-said'\]/g) || []).length === 2; })());

  S.section('документы: описан порядок «да» для update apply');
  const install = text(path.join(H.KIT, 'INSTALL.md')), trouble = text(path.join(H.KIT, 'docs', 'troubleshooting.md'));
  ok('INSTALL.md (раздел «Обнови установщик»): --yes «да» не заменяет, названы «обнови»/версия, consent plan, --human-said не принимается, --overwrite требует назвать файлы', (() => { const sec = install.slice(install.indexOf('### «Обнови установщик»'), install.indexOf('### Мои проекты')); return /`--yes` моё «да» не заменяет/.test(sec) && /«обнови»\/«update» или названа версия/.test(sec) && /consent plan/.test(sec) && /`--human-said` у `update` не принимается/.test(sec) && /назвать эти файлы|я должен назвать эти файлы/.test(sec); })());
  ok('troubleshooting.md: в разделе «Обновление» названы «обнови», consent plan и файлы для --overwrite', /## Обновление[\s\S]*обнови[\s\S]*consent plan[\s\S]*на этот файл[\s\S]*## Проекты человека/.test(trouble));
} catch (e) {
  ok('набор дошёл до конца без исключения', false, e && e.stack);
} finally {
  H.rmTree(TMP);
}
process.exit(S.finish());
