'use strict';
// Папка проверки checks/<id>/ для тестов, собранная вручную: манифест, prompt.md, verdict.md и (по умолчанию) run.json, как их пишут prepare-check, run-check и finalize-check.
// Нужна тестам, которые проверяют, КАК сторож и verify относятся к манифесту, не запуская проверяющего. Настоящий путь (run-check с заглушкой) проверяют unit/skills и matrix.
// Ручной вердикт БЕЗ run.json (proof: 'none') это ровно то, что находка H1 называет ложным GREEN: такая проверка засчитываться не должна.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');

// o: id, label, verdict ('GREEN'), reviewer ('codex'; undefined: поля нет), status ('checked'), files [{role, path, sha256}], kit_version, ageMin (насколько давно принята, мин; по умолчанию 5),
//    proof: 'full' | 'none' (нет run.json) | 'no-mark' (нет отметки finalize в манифесте);
//    run: правки run.json (например { provider: 'claude', ok: false, started_at: ... }); tamperVerdict: true (verdict.md изменён после запуска)
function writeCheck(dir, o) {
  const now = Date.now();
  const checked = new Date(now - (o.ageMin === undefined ? 5 : o.ageMin) * 60000);
  const created = new Date(checked.getTime() - 60000);
  const verdictText = 'ВЕРДИКТ: ' + (o.verdict === undefined ? 'GREEN' : o.verdict) + '\nПрочитано:\nНаходки: нет\n';
  const promptText = 'задание проверяющему\n';
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'prompt.md'), promptText);
  fs.writeFileSync(path.join(dir, 'verdict.md'), verdictText);
  const manifest = {
    id: path.basename(dir), label: o.label || null, mode: 'result', status: o.status || 'checked', verdict: o.verdict === undefined ? 'GREEN' : o.verdict,
    created: created.toISOString(), checked_at: checked.toISOString(), kit_version: o.kit_version, files: o.files || [],
  };
  if (o.reviewer !== undefined) manifest.reviewer = o.reviewer;
  if (o.proof !== 'no-mark') manifest.run_proof = { provider: o.reviewer, verdict_sha256: sha(verdictText) };
  if (o.proof !== 'none') {
    const run = Object.assign({
      check_id: manifest.id, provider: o.reviewer, reviewer: o.reviewer, model: null, kind: 'ok', ok: true, exit_code: 0,
      started_at: new Date(created.getTime() + 5000).toISOString(), finished_at: new Date(created.getTime() + 25000).toISOString(), seconds: 20,
      prompt_sha256: sha(promptText), verdict_bytes: Buffer.byteLength(verdictText), verdict_sha256: sha(verdictText), in_place: false,
    }, o.run || {});
    fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(run, null, 2));
  }
  if (o.tamperVerdict) fs.writeFileSync(path.join(dir, 'verdict.md'), verdictText + 'дописано рукой после запуска\n');
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

module.exports = { writeCheck, sha };
