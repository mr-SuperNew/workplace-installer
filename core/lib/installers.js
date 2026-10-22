'use strict';
// Адреса официальных установщиков Claude Code и Codex: ЕДИНСТВЕННЫЙ источник.
// Его читают core/providers/*.installPlan (что показать человеку и что запустить) и core/hooks/danger-guard.js (что можно скачать и выполнить без отметки,
// потому что человек уже сказал «да» на план установки). Менять адрес только здесь; тест tests/unit/core/run.js сверяет оба потребителя.
// Источник адресов: research/2026-10-21-external-facts.md, разделы 1 и 2.
const INSTALLERS = Object.freeze({
  claude: Object.freeze({ sh: 'https://claude.ai/install.sh', ps1: 'https://claude.ai/install.ps1' }),
  codex: Object.freeze({ sh: 'https://chatgpt.com/codex/install.sh', ps1: 'https://chatgpt.com/codex/install.ps1' }),
});

const OFFICIAL_INSTALLER_URLS = Object.freeze(Object.values(INSTALLERS).flatMap((x) => Object.values(x)));

module.exports = { INSTALLERS, OFFICIAL_INSTALLER_URLS };
