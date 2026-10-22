#!/usr/bin/env node
'use strict';
// Все тесты пакета одной командой: node tests/run-all.js [--with-negative]
// Печатает по строке на набор и итог «выполнено N из M наборов, падений K». Код выхода 0 только если выполнены ВСЕ наборы и падений нет:
//   - набор вернул код 0: прошёл;
//   - набор вернул код 1: выполнен, есть падения;
//   - другой код, обрыв по времени или нет файла набора: набор НЕ ВЫПОЛНЕН (это не «пройдено»; в итоге N меньше M и код выхода 1).
// --with-negative добавляет негативную проверку «от обратного» (tests/negative/run.js): старое опасное поведение, возвращённое в копию, обязано ронять тесты.
// Каждый набор работает в своей временной папке с фейковым HOME; настоящие ~/.claude и ~/.codex не трогаются.
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const KIT = path.resolve(__dirname, '..');
const SUITES = [
  { id: 'static', title: 'синтаксис, стоп-фразы (G4), имена (G10), окончания строк', file: 'tests/static/run.js' },
  { id: 'unit/hooks', title: 'сторожа: 7 хуков (в том числе human-message), мусорный ввод', file: 'tests/unit/hooks/run.js' },
  { id: 'unit/skills', title: 'навыки: cross-check, end-session, new-workspace, doctor, оба направления', file: 'tests/unit/skills/run.js' },
  { id: 'unit/core', title: 'стыки ядра: проверяющий, шаблон правил, wiring, secrets-scan, snapshot, заглушки, установщики', file: 'tests/unit/core/run.js' },
  { id: 'unit/fixes', title: 'правки по проверке этапа Г: ложный GREEN (H1), сеть Codex (H3), update (H4), разведка (M1), Mac (M2), отчёт (M3), config.toml (M4), PATH (M5)', file: 'tests/unit/fixes/run.js' },
  { id: 'unit/fixes-g', title: 'правки по повторной проверке этапа Ж: Mac без Homebrew (N1, N3), скрипт Node, path-fix, прокси (N5), update (N6), config.toml (N7)', file: 'tests/unit/fixes-g/run.js' },
  { id: 'unit/consent', title: 'подтверждение только от человека: «да», «без проверки», названная цель, план, копии, роли в правилах, вложенные репозитории', file: 'tests/unit/consent/run.js' },
  { id: 'unit/l-flow', title: 'сквозное (этап L): хук записи и сторож, layout --update, role set, adopt, вложенный .git, delegate Codex', file: 'tests/unit/l-flow/run.js' },
  { id: 'unit/m-flow', title: 'приёмка (этап М): переменная пути в PowerShell, «VS Code» называет настройки, backup, подтверждение для install и path-fix', file: 'tests/unit/m-flow/run.js' },
  { id: 'unit/n-flow', title: 'согласие только от человека (этап N): update apply и --overwrite, настройки VS Code, копия при layout --update, охват флагов согласия', file: 'tests/unit/n-flow/run.js' },
  { id: 'safety', title: 'чужое не трогаем: К6, К12, К19-К22', file: 'tests/safety/run.js' },
  { id: 'matrix', title: '4 случая × 2 направления на заглушках (G5)', file: 'tests/matrix/run.js' },
  { id: 'acceptance/grader', title: 'оценщик приёмочного стенда без моделей: 12 контрпримеров, секрет во всех каналах, отказ раньше успеха, оборванный ход', file: 'tests/acceptance/grader.test.js' },
  { id: 'modules/migrate-project', title: 'модуль переноса проекта', file: 'modules/migrate-project/migrate-project.test.js' },
  { id: 'modules/vscode', title: 'модуль Focus view', file: 'modules/vscode/focus-view.test.js' },
  { id: 'scripts/check-no-private (тест)', title: 'проверка перед публикацией: сам скрипт', file: 'scripts/check-no-private.test.js' },
  { id: 'scripts/build-release (тест)', title: 'сборка выпуска: архив, сумма, права 0755', file: 'scripts/build-release.test.js' },
  { id: 'check-no-private (дерево, G10)', title: 'проверка всего пакета: находок нет', file: 'scripts/check-no-private.js', args: ['.'] },
];
if (process.argv.includes('--with-negative')) SUITES.push({ id: 'negative', title: 'негативная проверка: старое опасное поведение роняет тесты', file: 'tests/negative/run.js' });
const unknown = process.argv.slice(2).filter((a) => a !== '--with-negative');
if (unknown.length) { console.error('Неизвестные параметры: ' + unknown.join(' ') + '. Можно только --with-negative.'); process.exit(2); }

const TIMEOUT_MS = 25 * 60 * 1000;
const t0 = Date.now();
const env = Object.assign({}, process.env);
for (const k of ['WP_HOME', 'CLAUDE_PROJECT_DIR', 'CODEX_HOME']) delete env[k];

function summaryLine(out) {
  const lines = String(out).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) if (/(пройдено|Итого|Находок|Сочетаний|Проверено)/i.test(lines[i]) && !/^[-–]/.test(lines[i])) return lines[i];
  return lines[lines.length - 1] || '(вывода нет)';
}

// Строки упавших проверок: строка «ПАДЕНИЕ/[НЕТ]/Error» и следом её подробности (с отступом), а не только итог набора.
// Нет ни одной такой строки: последние 40 строк вывода набора.
function failureLines(out) {
  const lines = String(out).split(/\r?\n/);
  const keep = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/ПАДЕНИЕ|\[НЕТ\]|^\s*- |Error|Ошибка|нет файла/.test(lines[i])) continue;
    keep.push(lines[i]);
    while (i + 1 < lines.length && /^\s{4,}\S/.test(lines[i + 1])) keep.push(lines[++i]);
  }
  return keep.length ? keep.slice(0, 120) : lines.filter((l) => l.trim()).slice(-40);
}

const results = [];
for (const s of SUITES) {
  const file = path.join(KIT, s.file);
  const started = Date.now();
  let r;
  if (!fs.existsSync(file)) r = { status: null, stdout: '', stderr: 'нет файла набора: ' + s.file, error: { code: 'ENOENT' } };
  else r = cp.spawnSync(process.execPath, [file, ...(s.args || [])], { cwd: KIT, encoding: 'utf8', env, timeout: TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  const out = String(r.stdout || '') + String(r.stderr || '');
  const sec = Math.round((Date.now() - started) / 1000);
  let state;
  if (r.error || r.signal || (r.status !== 0 && r.status !== 1)) state = 'НЕ ВЫПОЛНЕН';
  else state = r.status === 0 ? 'прошёл' : 'ПАДЕНИЕ';
  results.push({ s, state, status: r.status, out, sec });
  console.log(String(state).padEnd(12) + ' ' + s.id.padEnd(34) + String(sec).padStart(4) + ' с  ' + summaryLine(out).slice(0, 150));
  if (state !== 'прошёл') {
    console.log(failureLines(out).map((l) => '    ' + l).join('\n'));
    if (r.error) console.log('    причина: ' + (r.error.code || r.error.message) + (r.signal ? ', сигнал ' + r.signal : ''));
  }
}

const executed = results.filter((x) => x.state !== 'НЕ ВЫПОЛНЕН').length;
const failed = results.filter((x) => x.state === 'ПАДЕНИЕ').length;
const notRun = results.filter((x) => x.state === 'НЕ ВЫПОЛНЕН').map((x) => x.s.id);
console.log('\nвыполнено ' + executed + ' из ' + SUITES.length + ' наборов, падений ' + failed + ' (' + Math.round((Date.now() - t0) / 1000) + ' с)');
if (notRun.length) console.log('Не выполнены: ' + notRun.join(', ') + '. Набор, который не смог выполниться, считается красным.');
process.exit(failed || executed < SUITES.length ? 1 : 0);
