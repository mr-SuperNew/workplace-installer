'use strict';
// Обновление установленной главной папки из нового пакета: `update plan` только показывает, `update apply --yes` пишет после «да» человека.
// Флаг --yes сам «да» не доказывает (его ставит ИИ): apply сверяет последнее сообщение человека, записанное хуком human-message в корне (requireHumanUpdate ниже).
// Основа - update plan/apply из v3 (setup.js). Запускается ТОЛЬКО из нового пакета (распакованный архив версии) с --root <существующий корень>.
// Не трогает: AGENTS.md, CLAUDE.md, tasks.md, MEMORY.md, .gitignore, STATE.md, install-report.md, checks/, workspaces/, handoffs/, state.json, config.json (в него добавляются только новые ключи по умолчанию),
// файлы модулей человека. Файл пакета, который правил человек, по умолчанию не заменяется: показывается и ждёт «да» (--overwrite путь,путь).
// «Правил человек» определяется по хешу установленной версии: state.json (files{путь: sha256}) записывает хеши при init и при каждом apply. Три исхода для файла пакета:
//   не тронут (совпал с записанным хешем)  -> обновится;
//   изменён человеком (не совпал)          -> ОТЛИЧАЕТСЯ, не трогаю без «да» (apply с --overwrite <путь>);
//   удалён человеком (записан, но нет)      -> УДАЛЁН, не восстанавливаю без «да» (apply с --overwrite <путь>).
const fs = require('fs');
const path = require('path');
const u = require('./util');
const rootLib = require('./root');
const config = require('./config');
const state = require('./state');
const wiring = require('./wiring');
const layout = require('./layout');
const { makeGuard } = require('./fsguard');
const consent = require('./consent');

function walkFiles(dir, base) {
  const out = [];
  (function w(d) { for (const it of fs.readdirSync(d, { withFileTypes: true })) { if (it.name === 'node_modules' || it.name === '.git') continue; const p = path.join(d, it.name); if (it.isDirectory()) w(p); else if (it.isFile()) out.push(path.relative(base, p).split(path.sep).join('/')); } })(dir);
  return out.sort();
}

// Проверка корня и пакета ДО чтения чего-либо ещё. Текст отказа или null.
function refusal(root, kit, installed) {
  if (installed) return 'update запускается только из нового пакета (распакованный архив): node <пакет>/core/cli/wp.js update plan --root <корень>. Скрипт из <корень>/.workplace обновлять сам себя не может. Ничего не сделано.';
  if (!root) return 'Нужен --root <существующая главная папка>.';
  let lst = null; try { lst = fs.lstatSync(root); } catch (_) { /* нет */ }
  if (!lst) return 'Папки ' + root + ' нет. Ничего не сделано.';
  if (lst.isSymbolicLink() || !lst.isDirectory()) return 'Главная папка должна быть настоящей папкой, не ссылкой. Ничего не сделано.';
  const home = u.homeDir();
  if (u.same(root, home) || u.same(root, path.parse(root).root)) return 'Главная папка не может быть домашней папкой или корнем диска.';
  const need = ['.workplace/state.json', '.workplace/config.json', '.workplace/core', '.workplace/VERSION', 'AGENTS.md'];
  const miss = need.filter((f) => !u.exists(path.join(root, f)));
  if (miss.length) return 'Это не главная папка нашей установки (нет: ' + miss.join(', ') + '). Ничего не сделано.';
  const st = u.readJson(path.join(root, '.workplace', 'state.json'));
  if (!st || st.version !== state.STATE_VERSION || !st.stages || !st.stages['P1.root']) return '.workplace/state.json не похож на состояние установки v4. Ничего не сделано.';
  if (u.same(kit, root) || u.within(root, kit)) return 'Пакет лежит внутри главной папки: распакуй новый архив отдельно (например, в Загрузки) и запусти оттуда.';
  return null;
}

function items(root, kit) {
  const st = state.load(root) || {};
  const recorded = st.files && typeof st.files === 'object' ? st.files : null;   // null: старая установка без записи хешей
  const layoutDone = !!(st.stages && st.stages['P2.core'] && st.stages['P2.core'].status === 'done');   // раскладка выполнялась: отсутствие навыка в .claude/skills значит, что его удалили
  const list = [];
  const add = (rel, src, kind, old) => list.push({ rel, src, kind, old: old || null });
  for (const f of walkFiles(path.join(kit, 'core'), path.join(kit, 'core'))) add('.workplace/core/' + f, path.join(kit, 'core', f), 'pkg');
  if (u.isDir(path.join(kit, 'modules'))) for (const f of walkFiles(path.join(kit, 'modules'), path.join(kit, 'modules'))) add('.workplace/modules/' + f, path.join(kit, 'modules', f), 'pkg');
  if (u.isDir(path.join(kit, 'docs'))) for (const f of walkFiles(path.join(kit, 'docs'), path.join(kit, 'docs'))) add('.workplace/docs/' + f, path.join(kit, 'docs', f), 'pkg');
  for (const f of ['VERSION', 'INSTALL.md']) if (u.exists(path.join(kit, f))) add('.workplace/' + f, path.join(kit, f), 'pkg');
  // навыки ядра в .claude/skills и .agents/skills: заменяются, только если человек их не правил (сверка с прежней копией в .workplace/core/skills)
  const skillsBase = path.join(kit, 'core', 'skills');
  for (const sk of u.listDir(skillsBase) || []) {
    if (!u.isDir(path.join(skillsBase, sk))) continue;
    for (const f of walkFiles(path.join(skillsBase, sk), path.join(skillsBase, sk))) {
      for (const dst of ['.claude/skills', '.agents/skills']) add(dst + '/' + sk + '/' + f, path.join(skillsBase, sk, f), 'skill', path.join(root, '.workplace', 'core', 'skills', sk, f));
    }
  }
  for (const it of list) {
    const dst = path.join(root, it.rel);
    const cur = u.sha256File(dst), neu = u.sha256File(it.src);
    it.neu = neu;
    if (it.kind === 'pkg') {
      const rec = recorded ? recorded[it.rel] : undefined;
      if (cur === null) it.status = rec !== undefined ? 'deleted' : 'new';
      else if (cur === neu) it.status = 'same';
      else if (!recorded) it.status = 'custom';                        // нет записи хешей (N6 этапа Ж): правку человека от старой версии не отличить, поэтому любое отличие это «ОТЛИЧАЕТСЯ», без «да» не заменяется
      else it.status = rec !== undefined && cur === rec ? 'update' : 'custom';
    } else {
      const old = it.old ? u.sha256File(it.old) : null;
      if (cur === null) it.status = old !== null && layoutDone ? 'deleted' : 'new';
      else if (cur === neu) it.status = 'same';
      else it.status = old !== null && cur === old ? 'update' : 'custom';
    }
  }
  return list;
}

function commitUpdate(root, msg, written) {
  if (!u.exists(path.join(root, '.git'))) return 'git главной папки: репозитория нет, коммит не делался';
  const gs = require('./recon').gitStatus();
  if (!gs.ok) return 'git главной папки: git недоступен, коммит не делался';
  const top = layout.gitTop(gs.path, root);
  if (!top || !u.same(top, root)) return 'git главной папки: корень не отдельный репозиторий, коммит не делался';
  const g = (a) => u.run(gs.path, ['-C', root, ...a]);
  if (!g(['config', 'user.name']).out || !g(['config', 'user.email']).out) return 'git главной папки: нет имени и почты для коммитов, коммит не делался (изменения лежат в рабочей папке)';
  const pre = g(['diff', '--cached', '--name-only']);
  if (!pre.ok) return 'git главной папки: не удалось проверить индекс, коммит не делался';
  if (pre.out.split(/\r?\n/).filter(Boolean).length) return 'git главной папки: коммит пропущен: в индексе чужие изменения; закоммить сам или попроси ИИ (файлы обновлены в рабочей папке)';
  const ign = g(['check-ignore', '--', ...written]).out.split(/\r?\n/).filter(Boolean);
  const paths = written.filter((p) => !ign.includes(p));
  if (!paths.length) return 'git главной папки: коммитить нечего';
  if (!g(['add', '--', ...paths]).ok) { g(['reset', '-q', '--', ...paths]); return 'git главной папки: git add не удался, коммит не делался'; }
  const staged = g(['diff', '--cached', '--name-only']).out.split(/\r?\n/).filter(Boolean);
  const bad = staged.filter((f) => /(^|\/)\.env($|\.(?!example$))|settings\.local\.json|\.workplace\/(state|recon-before)\.json|\.workplace\/(snapshots|backup-update|npm-cache)\/|\.bak-/.test(f));
  if (bad.length) { g(['reset', '-q', '--', ...paths]); return 'git главной папки: в коммит попали служебные файлы (' + bad.join(', ') + '), добавление откатил, коммит не делался'; }
  if (!staged.length) return 'git главной папки: коммитить нечего';
  const c = g(['commit', '-q', '-m', msg]);
  if (!c.ok) { g(['reset', '-q', '--', ...paths]); return 'git главной папки: commit не удался, изменения остались в рабочей папке'; }
  return 'git главной папки: коммит создан (файлов ' + staged.length + ', без push)';
}

// «Да» человека для apply. Флаг --yes подтверждением не является: его ставит ИИ.
// В главной папке сторож сообщений человека подключён всегда (хук human-message пишет .workplace/human-messages.json), поэтому слов «от ИИ» здесь нет, --human-said не принимается.
// Нужно: «да» в последнем сообщении человека; в двух последних сообщениях (или в принятом плане: wp.js consent plan) сказано «обнови»/«update» либо названа версия пакета.
// --overwrite: каждый файл, который правил или удалил человек, должен быть назван (путь или имя файла) в тех же сообщениях или плане. Папка-родитель файл не называет.
// Возвращает запись о подтверждении для state.updates.
const UPDATE_WORDS = ['обнови', 'обновл', 'update', 'upgrade', 'апдейт'];
function requireHumanUpdate(root, newVer, overwriteRels) {
  const wp = u.tilde(path.join(root, '.workplace', 'core', 'cli', 'wp.js'));
  const show = 'Покажи человеку план обновления (update plan) и дождись его «да», затем повтори команду.';
  const names = UPDATE_WORDS.concat(newVer && newVer !== '?' ? [newVer, 'v' + newVer] : []);
  const res = consent.evaluate(root, null, { kind: 'target', targets: [{ kind: 'name', names }] });
  if (!res.ok) {
    const why = res.why === 'no-record'
      ? 'сторож не видит сообщений человека (хук human-message не подключён или не доверен; у Codex проекту нужно доверие, команда /hooks; проверка: node ' + wp + ' hooks status), подтвердить нечем. Скажи человеку простыми словами, что обновится, и попроси выполнить ту же команду самому в терминале.'
      : res.why === 'no-yes'
        ? 'в последнем сообщении человека нет «да». ' + show
        : 'в двух последних сообщениях человека нет слова «обнови»/«update» и версии ' + newVer + ', и принятого плана нет. ' + show + ' Чтобы одно «да» покрыло план, зарегистрируй показанное: node ' + wp + ' consent plan "обновляю пакет до ' + newVer + ', вот что изменится: ..." и спроси «да».';
    throw new u.WpError('update apply: ' + why + ' Один флаг --yes подтверждением не является. Ничего не сделано.', 3);
  }
  if (overwriteRels.length) {
    const miss = consent.filesNotNamed(root, null, overwriteRels.map((rel) => ({ rel, abs: path.join(root, rel) }))).map((f) => f.rel);
    if (miss.length) throw new u.WpError('update apply --overwrite: человек не назвал эти файлы (' + miss.join(', ') + '): их он правил сам или удалил, перезапись и восстановление только с его «да» на конкретный файл. Покажи ему список, зарегистрируй его (node ' + wp + ' consent plan "заменяю: ' + miss.join(', ') + '"), дождись «да» и повтори. Ничего не сделано.', 3);
  }
  return { via: 'сообщение человека (сторож видел его сам)', overwrite: overwriteRels.length ? 'файлы названы человеком или в принятом им плане' : null };
}

// sub: 'plan' | 'apply'; o: { root, kit, installed, yes, overwrite: [rel...] }. Печать через say.
function run(sub, o, say) {
  const root = o.root ? path.resolve(o.root) : null;
  const ref = refusal(root, o.kit, o.installed);
  if (ref) throw new u.WpError(ref, 3);
  const oldVer = (u.readText(path.join(root, '.workplace', 'VERSION')) || '?').trim();
  const newVer = (u.readText(path.join(o.kit, 'VERSION')) || '?').trim();
  const list = items(root, o.kit);
  const by = (st) => list.filter((i) => i.status === st);
  // Файлы, которые прежняя версия записала, а новый пакет уже не содержит: остаются на диске и в state.json, ничего не удаляется (N6)
  const knownRel = new Set(list.map((i) => i.rel));
  const obsolete = Object.keys((state.load(root) || {}).files || {}).filter((rel) => !knownRel.has(rel) && u.exists(path.join(root, rel))).sort();
  const overwrite = new Set((o.overwrite || []).map((x) => x.trim().replace(/\\/g, '/')).filter(Boolean));
  const unknown = [...overwrite].filter((x) => !list.some((i) => i.rel === x && (i.status === 'custom' || i.status === 'deleted')));
  if (unknown.length) throw new u.WpError('--overwrite: этих файлов нет среди «ОТЛИЧАЕТСЯ» и «УДАЛЁН» (' + unknown.join(', ') + '). Ничего не сделано.', 2);
  // подключение сторожей по хукам нового пакета
  const g = makeGuard(root);
  const tp = wiring.templatePaths();
  const wpDirNew = o.kit;   // ключи «core/hooks/x.js» относительно корня нового пакета
  const claudeWant = wiring.filterAvailable(wiring.renderTemplate(tp.claude, root), wpDirNew).tpl;
  const codexWant = wiring.filterAvailable(wiring.renderTemplate(tp.codex, root), wpDirNew).tpl;
  const settingsNow = u.readJson(path.join(root, '.claude', 'settings.json')) || {};
  const codexNow = u.readJson(path.join(root, '.codex', 'hooks.json')) || {};
  const mc = wiring.mergeInto(settingsNow, claudeWant, { prune: true });
  const mx = wiring.mergeInto(codexNow, codexWant, { prune: true });
  const cfgNow = u.readJson(config.file(root)) || {};
  const cfgMerged = config.merge(cfgNow);
  const cfgNew = JSON.stringify(config.strip(cfgMerged)) !== JSON.stringify(cfgNow);
  const giMiss = u.exists(path.join(root, '.gitignore')) ? layout.gitignoreMissing(root) : [];
  say('Обновление главной папки ' + u.tilde(root) + ': пакет ' + oldVer + ' -> ' + newVer + '.');
  say('Файлов пакета: новых ' + by('new').length + ', обновится ' + by('update').length + ', без изменений ' + by('same').length + ', ОТЛИЧАЕТСЯ (ты правил сам) ' + by('custom').length + ', УДАЛЕНО тобой ' + by('deleted').length + '.');
  if (!(state.load(root) || {}).files) say('В state.json нет записи хешей установленных файлов (старая установка): правки человека от прежней версии пакета отличить нельзя, поэтому каждый файл, который отличается от нового, показан как «ОТЛИЧАЕТСЯ» и без твоего «да» (apply с --overwrite) не заменяется. Копии заменяемых файлов лягут в backup-update.');
  for (const i of by('new')) say('  новый: ' + i.rel);
  for (const i of by('update')) say('  обновится: ' + i.rel);
  for (const i of by('custom')) say('  ОТЛИЧАЕТСЯ, не трогаю без твоего «да» (apply с --overwrite ' + i.rel + '): ' + i.rel);
  for (const i of by('deleted')) say('  УДАЛЁН тобой, не восстанавливаю без твоего «да» (apply с --overwrite ' + i.rel + '): ' + i.rel);
  for (const rel of obsolete) say('  устарел в новой версии, не удаляю: ' + rel);
  say('.claude/settings.json: добавлю хуков ' + mc.stat.added + ', обновлю ' + mc.stat.updated + ', уберу наших устаревших ' + mc.stat.removed + ', разрешений ' + mc.stat.perms + ' (чужие правила остаются).');
  say('.codex/hooks.json: добавлю хуков ' + mx.stat.added + ', обновлю ' + mx.stat.updated + ', уберу наших устаревших ' + mx.stat.removed + ' (чужие остаются).');
  if (cfgNew) say('.workplace/config.json: добавлю новые ключи по умолчанию (значения человека не меняю).');
  if (giMiss.length) say('.gitignore: допишу строки: ' + giMiss.join(', '));
  const rulesNow = u.readText(path.join(root, 'AGENTS.md'));
  const rulesNew = u.fill(layout.tpl('AGENTS.md.tpl'), layout.names(cfgMerged));
  if (rulesNow !== null && rulesNow !== rulesNew) say('AGENTS.md: шаблон правил в новом пакете отличается от вашего файла; не заменяю (это ваши правила), разницу покажу по просьбе.');
  say('Не трогаю: AGENTS.md, CLAUDE.md, tasks.md, MEMORY.md, STATE.md, install-report.md, checks/, workspaces/, handoffs/, подключённые модули, твои проекты и файлы вне главной папки. Ничего не удаляю.');
  say('Копии заменяемых файлов лягут в .workplace/backup-update/<метка>/.');
  const result = { obsolete, counts: { new: by('new').length, update: by('update').length, same: by('same').length, custom: by('custom').length, deleted: by('deleted').length }, applied: false };
  if (sub === 'plan') { say('Это только план: ничего не записано. Дальше: покажи его человеку, получи его «да» (в сообщении или в зарегистрированном плане должно быть «обнови»/«update» или версия ' + newVer + ') и update apply --yes; один флаг --yes подтверждением не является' + (by('custom').length + by('deleted').length ? ' (для файлов «ОТЛИЧАЕТСЯ» и «УДАЛЁН» отдельный вопрос и --overwrite)' : '') + '.'); return result; }
  if (!o.yes) throw new u.WpError('apply пишет файлы: сначала update plan, покажи его человеку и дождись «да», затем повтори с --yes. Ничего не сделано.', 2);
  const conf = requireHumanUpdate(root, newVer, [...overwrite]);
  const stamp = u.stamp();
  const bdir = path.join(root, '.workplace', 'backup-update', stamp);
  const counts = { new: 0, update: 0, same: by('same').length, custom_kept: 0, deleted_kept: 0, overwritten: 0 };
  const hashes = [];   // [путь, sha256] файлов пакета, которые теперь совпадают с новой версией: попадут в state.json
  const kept = [];
  const keptDeleted = [];
  const written = [];
  const backup = (rel) => { const src = path.join(root, rel); if (u.exists(src)) g.cf(src, path.join(bdir, rel)); };
  for (const i of list) {
    if (i.status === 'same') { if (i.kind === 'pkg') hashes.push([i.rel, i.neu]); continue; }
    const dst = path.join(root, i.rel);
    if (i.status === 'custom' && !overwrite.has(i.rel)) { counts.custom_kept++; kept.push(i.rel); continue; }
    if (i.status === 'deleted' && !overwrite.has(i.rel)) { counts.deleted_kept++; keptDeleted.push(i.rel); continue; }
    if (i.status !== 'new' && i.status !== 'deleted') backup(i.rel);
    g.cf(i.src, dst); written.push(i.rel);
    if (i.kind === 'pkg') hashes.push([i.rel, i.neu]);
    if (i.status === 'new') counts.new++; else if (i.status === 'custom' || i.status === 'deleted') counts.overwritten++; else counts.update++;
    say((i.status === 'new' ? 'создан: ' : i.status === 'deleted' ? 'восстановлен: ' : 'обновлён: ') + i.rel);
  }
  // сторожа: слияние уже по файлам, лежащим в главной папке
  for (const [rel, merged, file] of [['.claude/settings.json', mc, path.join(root, '.claude', 'settings.json')], ['.codex/hooks.json', mx, path.join(root, '.codex', 'hooks.json')]]) {
    if (merged.changed) { if (u.exists(file)) backup(rel); g.wf(file, JSON.stringify(merged.cur, null, 2) + '\n'); written.push(rel); say(rel + ': подключение обновлено'); }
  }
  if (cfgNew) { config.save(root, cfgMerged); say('.workplace/config.json: новые ключи добавлены'); }
  if (giMiss.length) { backup('.gitignore'); const r = layout.gitignoreAppend(g, root, false); written.push('.gitignore'); say('.gitignore: ' + r.text); }
  const gitNote = commitUpdate(root, 'Обновление пакета рабочего места до ' + newVer, written);
  say(gitNote);
  const s = state.need(root);
  s.kit_version = newVer;
  s.files = Object.assign({}, s.files || {});
  for (const [rel, sha] of hashes) s.files[rel] = sha;
  s.updates.push({ at: new Date().toISOString(), from: oldVer, to: newVer, backup: '.workplace/backup-update/' + stamp, counts, custom_kept: kept, deleted_kept: keptDeleted, confirmation: conf, settings: { claude: mc.stat, codex: mx.stat }, git: gitNote });
  state.save(root, s);
  state.log(root, 'пакет обновлён: ' + oldVer + ' -> ' + newVer + ' (создано ' + counts.new + ', обновлено ' + counts.update + ', не тронуто из-за правок ' + counts.custom_kept + ', не восстановлено удалённых ' + counts.deleted_kept + ')');
  say('Готово. Обновлено файлов: ' + counts.update + ', создано: ' + counts.new + ', не тронуто из-за твоих правок: ' + counts.custom_kept + ', не восстановлено удалённых тобой: ' + counts.deleted_kept + '. Копии прежних файлов: .workplace/backup-update/' + stamp + '/. Дальше из главной папки: snapshot before --force, verify all --live, report.');
  result.applied = true; result.counts = counts; result.custom_kept = kept; result.deleted_kept = keptDeleted;
  return result;
}

module.exports = { run, items, refusal, commitUpdate, walkFiles, requireHumanUpdate };
