'use strict';
// Доказательство того, что проверяющий действительно запускался (находка H1 этапа Г: «ложный GREEN самопроверки»).
// Принятая проверка (manifest.status "checked") считается настоящей, только если рядом лежит run.json, который записал run-check.js:
//   - ok: true, kind "ok", exit_code 0;
//   - provider равен проверяющему из config.json и manifest.reviewer;
//   - check_id равен manifest.id, а prompt_sha256 и verdict_sha256 совпадают с файлами prompt.md и verdict.md;
//   - started_at не раньше manifest.created, finished_at не раньше started_at.
// Рукописный verdict.md без запуска проверяющего этим условиям не удовлетворяет.
// Честная граница: это защита от невнимательного агента, а не от злоумышленника: run.json тоже файл. Запись в checks/*/{verdict.md,run.json,manifest.json,review.log,prompt.md}
// инструментами и командами останавливает cross-check-guard; здесь файлы только читаются.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SKEW_MS = 2000;

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); } catch (_) { return null; } }
function shaOf(p) { try { return sha256(fs.readFileSync(p)); } catch (_) { return null; } }

// dir: <корень>/checks/<id>. expectReviewer: проверяющий из config.json. Возвращает { ok, problems: [строка...] }.
function verifyRun(dir, manifest, expectReviewer) {
  const problems = [];
  const rj = readJson(path.join(dir, 'run.json'));
  if (!rj || typeof rj !== 'object') return { ok: false, problems: ['нет run.json (его пишет только run-check.js после запуска проверяющего): вердикт не получен от проверяющего'] };
  if (rj.ok !== true || rj.kind !== 'ok') problems.push('run.json: запуск проверяющего не закончился успехом (итог ' + rj.kind + ')');
  if (rj.exit_code !== 0) problems.push('run.json: код выхода проверяющего не 0 (' + rj.exit_code + ')');
  const want = expectReviewer || (manifest && manifest.reviewer);
  if (rj.provider !== want) problems.push('run.json: проверял ' + (rj.provider || 'неизвестно кто') + ', а проверяющий по config.json ' + want);
  if (manifest && manifest.reviewer && rj.provider !== manifest.reviewer) problems.push('run.json: проверяющий не тот, что записан в манифесте (' + manifest.reviewer + ')');
  if (manifest && manifest.id && rj.check_id !== manifest.id) problems.push('run.json относится к другой папке проверки (' + rj.check_id + ')');
  const vsha = shaOf(path.join(dir, 'verdict.md'));
  if (!vsha) problems.push('нет verdict.md');
  else if (rj.verdict_sha256 !== vsha) problems.push('verdict.md не тот, что записал run-check.js (хеш не совпал): файл правили после запуска проверяющего');
  const psha = shaOf(path.join(dir, 'prompt.md'));
  if (!psha || rj.prompt_sha256 !== psha) problems.push('prompt.md не тот, что отдан проверяющему (хеш не совпал)');
  const t0 = Date.parse(rj.started_at), t1 = Date.parse(rj.finished_at);
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) problems.push('run.json: нет времени начала и конца запуска');
  else {
    if (t1 < t0) problems.push('run.json: конец запуска раньше начала');
    const created = manifest && manifest.created ? Date.parse(manifest.created) : NaN;
    if (Number.isFinite(created) && t0 < created - SKEW_MS) problems.push('run.json: запуск начался раньше подготовки проверки (prepare-check): это запуск не этой проверки');
    if (t1 > Date.now() + 60000) problems.push('run.json: время конца запуска в будущем');
  }
  return { ok: problems.length === 0, problems };
}

// Принятая проверка: к тому же finalize-check записал в манифест хеш вердикта, который он разбирал, и он совпадает с файлом сейчас.
function verifyAccepted(dir, manifest, expectReviewer) {
  const r = verifyRun(dir, manifest, expectReviewer);
  if (!r.ok) return r;
  const vsha = shaOf(path.join(dir, 'verdict.md'));
  if (!manifest.run_proof || manifest.run_proof.verdict_sha256 !== vsha) return { ok: false, problems: ['в манифесте нет отметки finalize-check о принятом вердикте (или verdict.md изменён после приёмки)'] };
  return { ok: true, problems: [] };
}

module.exports = { verifyRun, verifyAccepted, sha256, shaOf, readJson };
