'use strict';
// План установки по результату разведки и выбранному направлению. Ничего не выполняет и не пишет: только строит список шагов.
// Матрица (PROJECT.md, раздел 2): порядок шагов один и тот же для обоих направлений: Node, Python, git (по «да»), основной ИИ, проверяющий ИИ, входы.
// Различие направлений собрано в core/providers (installPlan), здесь условного `if (claude)` нет.
const u = require('./util');
const recon = require('./recon');
const providers = require('../providers');
const config = require('./config');
const macsupport = require('./macsupport');
const path = require('path');

function wingetRun(id) { return { cmd: 'winget', args: ['install', '-e', '--id', id, '--accept-package-agreements', '--accept-source-agreements'] }; }

// Установка Node, Python и git не выполняется самим wp.js: Node нужен ему самому, остальное выполняет ИИ командами из шага после «да» (или `wp.js install python|git`).
// Mac (N1, N3 этапа Ж): Homebrew поддерживается только на Apple Silicon с macOS 15 и новее, на Intel это Tier 3 (core/lib/macsupport.js). Поэтому:
//  - Homebrew стоит И поддерживается: `brew install node` и `brew install python`;
//  - иначе Node это официальный архив с nodejs.org в ~/.local/node (core/scripts/install-node-user.sh: без пароля и двойных щелчков, sha256 по SHASUMS256.txt),
//    Python и git это Command Line Tools (`xcode-select --install`, системное окно; python3 проверяется без запуска заглушки);
//  - Homebrew сам не ставится: только если человек сам попросил и его Mac поддерживается (команду берёт человек с https://brew.sh).
const SCRIPT_ABS = path.join(__dirname, '..', 'scripts', 'install-node-user.sh');
const NODE_PKG_FALLBACK = 'Запасной путь, если архив не скачался или не прошёл проверку: установщик LTS (.pkg) с https://nodejs.org/en/download (для macOS ниже 13.5 это версия 22 из раздела прошлых выпусков). Это ручной шаг с двойным щелчком и паролем компьютера, поэтому он только запасной.';
const PY_ORG_FALLBACK = 'Запасной путь, если Command Line Tools не поставились: установщик Python для macOS с https://www.python.org/downloads/macos/ (скачанный файл запускает человек двойным щелчком и вводит пароль компьютера; версию выбирай ту, что поддерживает его macOS: это написано на странице).';
function nodeArchiveCommand(arch) {
  const flag = arch.major ? ' --major ' + arch.major : '';
  return { display: 'bash ' + u.tilde(SCRIPT_ABS) + flag, source: 'официальный архив с https://nodejs.org/dist/latest-v' + (arch.major || 'N') + '.x/ (скрипт пакета core/scripts/install-node-user.sh: sha256 по SHASUMS256.txt, папка ~/.local/node, пароль не нужен)', script: true };
}
function systemSteps(r, o) {
  const win = r.os.platform === 'win32';
  const mac = !win;
  const hasBrew = r.tools.managers.some((m) => m.name === 'brew');
  const brew = mac ? macsupport.brewSupport(r.os) : { supported: false, why: '' };
  const brewOk = mac && hasBrew && brew.supported;                    // Homebrew стоит и для этого Mac поддерживается
  const arch = mac ? macsupport.nodeArchive(r.os) : null;
  const steps = [];
  // Node
  const nodeMissing = !r.tools.node.copies.length || !r.tools.node.ok;
  const nodeOld = r.tools.node.copies.length && !r.tools.node.ok;
  let nodeStep;
  if (!nodeMissing) nodeStep = { stage: 'P1.node', title: 'Node.js', status: 'done', action: 'present', note: 'Node ' + (r.tools.node.copies[0] ? r.tools.node.copies[0].version : r.tools.node.running.version) };
  else {
    nodeStep = {
      stage: 'P1.node', title: 'Node.js 18 или новее', status: 'needs-install', beforeWp: true,
      ask: nodeOld ? 'Стоит Node старше 18. Новая версия станет Node для всех ваших проектов: ставлю только после «да».' : null,
      needsPassword: false, needsAdmin: false,
    };
    if (win) {
      nodeStep.commands = [{ display: 'winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements', source: 'winget, пакет OpenJS.NodeJS.LTS', run: wingetRun('OpenJS.NodeJS.LTS') }];
      nodeStep.after = 'После установки проверь программу в НОВОМ окне терминала или по полному пути (`where.exe node`): профили оболочки не запускаем.';
    } else if (brewOk) {
      nodeStep.commands = [{ display: 'brew install node', source: 'Homebrew (стоит, и для этого Mac поддерживается)', run: { cmd: 'brew', args: ['install', 'node'] } }];
      nodeStep.after = 'После установки проверь программу в НОВОМ окне терминала или по полному пути (/opt/homebrew/bin/node): профили оболочки не запускаем.';
    } else if (!arch.ok) {
      nodeStep.commands = [];
      nodeStep.blocked = arch.why + '. Node здесь не поставить без обновления macOS: скажи человеку простыми словами и остановись, не выбирай ничего за него.';
      nodeStep.fallback = NODE_PKG_FALLBACK;
    } else {
      nodeStep.commands = [nodeArchiveCommand(arch)];
      nodeStep.fallback = NODE_PKG_FALLBACK;
      nodeStep.after = 'Node ляжет в ~/.local/node/bin и в PATH сам не попадёт: до записи PATH вызывай его по полному пути (`~/.local/node/bin/node`, им же запускай команды wp.js). Строку PATH в профиль допишет `wp.js path-fix --yes` по «да» человека (предупреждение ему: эта Node станет первой в новых окнах терминала). Сторожа запускают `node` по PATH, поэтому после path-fix программу ИИ нужно закрыть и открыть заново в новом окне терминала; шаг 9 это проверит.';
      if (hasBrew && !brew.supported) nodeStep.warn = 'Homebrew на этом Mac стоит, но для него не поддерживается (' + brew.why + '): Node ставлю архивом, Homebrew не трогаю.';
      else if (!brew.supported) nodeStep.warn = 'Homebrew для вашего Mac не поддерживается (' + brew.why + '): не предлагаю и не ставлю его, Node беру официальным архивом с nodejs.org, Python и git через Command Line Tools.';
      else nodeStep.homebrewNote = 'Homebrew для этой установки не нужен. Если он нужен вам для других программ и ваш Mac его поддерживает, команду установки вы берёте на https://brew.sh и запускаете сами (пароль вводите вы); я его не ставлю.';
    }
  }
  steps.push(nodeStep);
  // Python
  const pyBrew = brewOk;
  const pyViaClt = mac && !pyBrew;
  steps.push(r.tools.python.version ? { stage: 'P1.python', title: 'Python', status: 'done', action: 'present', note: 'Python ' + r.tools.python.version } : {
    stage: 'P1.python', title: 'Python 3', status: 'needs-install',
    commands: win ? [{ display: 'winget install -e --id Python.Python.3.13 --accept-package-agreements --accept-source-agreements', source: 'winget, пакет Python.Python.3.13 (идентификатор проверен `winget search Python.Python` 21.10.2026)', run: wingetRun('Python.Python.3.13') }]
      : (pyBrew ? [{ display: 'brew install python', source: 'Homebrew (стоит, и для этого Mac поддерживается)', run: { cmd: 'brew', args: ['install', 'python'] } }]
        : [{ display: 'xcode-select --install', human: true, source: 'системное окно macOS: человек нажимает «Установить» и ждёт 5-15 минут; Command Line Tools ставят и python3, и git' }]),
    fallback: pyViaClt ? PY_ORG_FALLBACK : null,
    needsPassword: false, needsAdmin: false,
    hint: pyViaClt ? 'После окна проверь `xcode-select -p` (печатает путь) и только потом `/usr/bin/python3 --version`: до этого /usr/bin/python3 заглушка, её запуск открывает системное окно. Затем `wp.js verify P1.python`.'
      : 'Заглушку системы (псевдоним магазина Windows, /usr/bin/python3 без Command Line Tools) не запускать: разведка на Mac сначала проверяет `xcode-select -p`.',
  });
  // git: по «да», желателен
  const gitOk = r.tools.git && !r.tools.git.note;
  steps.push(gitOk ? { stage: 'P1.git', title: 'git', status: 'done', action: 'present', note: 'git ' + r.tools.git.version } : {
    stage: 'P1.git', title: 'git (желателен: ведёт историю главной папки)', status: 'needs-install', optional: true,
    commands: win ? [{ display: 'winget install -e --id Git.Git --accept-package-agreements --accept-source-agreements', source: 'winget, пакет Git.Git', run: wingetRun('Git.Git') }]
      : [{ display: 'xcode-select --install', human: true, source: 'системное окно macOS: человек нажимает «Установить», ждёт 5-15 минут' }],
    note: pyViaClt && !r.tools.python.version ? 'это то же окно, что для Python: Command Line Tools ставят оба, второй раз не запускай' : null,
    needsPassword: false, needsAdmin: false,
  });
  return steps;
}

function providerSteps(r, o, role) {
  const name = o[role];
  const p = providers.get(name);
  const d = r[name];
  const ip = p.installPlan({ platform: r.os.platform, arch: r.os.arch }, { root: o.root });
  const stageProg = role === 'main' ? 'P1.main' : 'P1.reviewer';
  const stageLogin = role === 'main' ? 'P1.main-login' : 'P1.reviewer-login';
  const out = [];
  // Проверяющему нужна консольная программа (мы её запускаем). Основному достаточно любой копии, включая расширение VS Code.
  const needConsole = role === 'reviewer';
  const ok = needConsole ? d.console : d.present;
  if (ok) {
    out.push({ stage: stageProg, title: p.label + ' (' + (role === 'main' ? 'основной' : 'проверяющий') + ')', status: 'done', action: 'present', note: d.console ? p.name + ' ' + d.primary.version : 'есть в расширении VS Code, консольную команду можно поставить позже' });
  } else {
    out.push({
      stage: stageProg, title: p.label + ' (' + (role === 'main' ? 'основной' : 'проверяющий') + ')', status: 'needs-install', provider: name, role,
      install: ip, wpCommand: 'node .workplace/core/cli/wp.js install ' + name + ' --yes --human-said "<мои слова с «да» дословно>"',
      fallbackCommand: 'node .workplace/core/cli/wp.js install ' + name + ' --yes --human-said "<мои слова с «да» дословно>" --npm',
      broken: d.copies.filter((c) => !c.usable).map((c) => c.path + ': ' + (c.error || 'не запускается')),
    });
  }
  const loggedHint = d.login_hint.state === 'present';
  out.push({
    stage: stageLogin, title: 'Вход в ' + p.label, status: loggedHint ? 'todo' : 'needs-human', provider: name, role,
    login: ip.login, note: loggedHint ? 'признак входа есть: проверит ' + (name === 'codex' ? '`codex login status`' : '`claude auth status` после «да»') : 'человек входит в браузере',
  });
  return out;
}

// o: { main, reviewer, root }. Направление по умолчанию - предложенное разведкой.
function buildPlan(r, o) {
  o = Object.assign({}, o || {});
  o.main = o.main || r.case.suggested.main;
  o.reviewer = o.reviewer || config.other(o.main);
  if (o.main === o.reviewer) throw new u.WpError('Проверяющий должен отличаться от основного.', 2);
  const steps = [];
  steps.push(...systemSteps(r, o));
  steps.push(...providerSteps(r, o, 'main'));
  steps.push(...providerSteps(r, o, 'reviewer'));
  steps.push({ stage: 'P1.vscode', title: 'VS Code (по выбору, модуль vscode)', status: 'optional', note: 'расширения, доверие папке и настройка «Claude Code: Toggle Focus view»' });
  const questions = [
    { id: 'yes', text: 'Ставлю недостающее по списку ниже, главную папку и сторожей. Ответьте «да», если согласны.' },
    { id: 'direction', text: 'Основной ИИ: ' + o.main + ', проверяет ' + o.reviewer + '. Если нужно наоборот, скажите одним словом.' },
  ];
  const touchesProfile = steps.filter((s) => s.install && s.install.primary && s.install.primary.editsProfile).map((s) => s.install.provider + ': ' + (s.install.primary.writes || []).join(', '));
  return {
    case: r.case,
    direction: { main: o.main, reviewer: o.reviewer, suggested: r.case.suggested },
    steps,
    rows: r.plan,
    questions,
    warnings: r.warnings,
    profile_notice: touchesProfile.length ? 'Официальные установщики сами дописывают PATH в профиль оболочки или пользовательский PATH: ' + touchesProfile.join('; ') + '. Это согласованное действие, оно записывается как объявленное.' : null,
    npm_note: 'Запасной путь, если официальный установщик не сработал: `npm install -g` без sudo (при EACCES с префиксом в домашней папке), кэш npm в главную папку.',
  };
}

// Перенос плана в state.json: чего не хватает - `needs-install` («поставить после да»), а не skipped.
function applyToState(s, plan) {
  const st = require('./state');
  for (const step of plan.steps) {
    const x = s.stages[step.stage];
    if (!x) continue;
    if (['done'].includes(x.status) && step.status !== 'done') continue;   // уже сделанное не откатываем
    if (step.status === 'done') st.setStage(s, step.stage, 'done', step.action || 'present', step.note || '');
    else if (step.status === 'optional') { if (!['done', 'skipped'].includes(x.status)) st.setStage(s, step.stage, 'optional', null, step.note || x.note); }
    else if (step.status === 'needs-human') st.setStage(s, step.stage, step.status, null, step.note || '');
    else st.setStage(s, step.stage, step.status, null, step.broken && step.broken.length ? 'найден, но не запускается: ' + step.broken[0] : '');
  }
  s.case = plan.case.id;
  s.direction = { main: plan.direction.main, reviewer: plan.direction.reviewer };
  return s;
}

function render(plan) {
  const L = [];
  L.push('Случай: ' + recon.CASE_TITLE[plan.case.id] + '. Направление: основной ' + plan.direction.main + ', проверяет ' + plan.direction.reviewer + '.');
  L.push('');
  for (const s of plan.steps) {
    let how = '';
    if (s.status === 'done') how = 'уже есть' + (s.note ? ' (' + s.note + ')' : '') + ': не трогаю';
    else if (s.status === 'optional') how = 'по выбору';
    else if (s.install) how = 'после «да»: `' + s.install.primary.display + '` (запасной путь: npm без sudo)';
    else if (s.commands) how = 'после «да»: ' + s.commands.map((c) => (c.human ? c.display : '`' + c.display + '`')).join('; затем ') + (s.needsPassword ? ' (пароль компьютера вводит человек)' : '') + (s.fallback ? ' [' + s.fallback + ']' : '');
    else if (s.login) how = s.status === 'needs-human' ? 'делает человек: ' + s.login.how : 'проверю статус входа (' + s.note + ')';
    if (s.blocked) how = 'НЕ ПОСТАВИТЬ: ' + s.blocked;
    L.push('- [' + s.stage + '] ' + s.title + ': ' + how);
    for (const extra of [s.warn, s.homebrewNote, s.commands && s.note && s.status !== 'done' ? s.note : null, s.after && s.status === 'needs-install' && s.stage === 'P1.node' && !s.blocked ? s.after : null]) if (extra) L.push('    ' + extra);
  }
  L.push('');
  if (plan.profile_notice) L.push(plan.profile_notice, '');
  L.push(plan.npm_note);
  L.push('');
  for (const q of plan.questions) L.push('- ' + q.text);
  return L.join('\n');
}

module.exports = { buildPlan, applyToState, render, systemSteps, providerSteps };
