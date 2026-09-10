/**
 * Prove the TypeScript port reproduces what scikit-learn produced.
 *
 * Two separate things can drift between ml/train.py and lib/flood-risk.ts, and
 * neither one throws when it breaks:
 *
 *   1. The ARITHMETIC — standardize, dot, sigmoid. Checked against the test
 *      vectors baked into lib/flood-model.json.
 *   2. The FEATURE WINDOWS — the easier and more dangerous one. A rolling sum
 *      off by an hour, or an antecedent index that forgets to drop the current
 *      day, yields a plausible number that is simply wrong, and the model gets
 *      quietly worse with nothing in the logs to say so. Checked by replaying
 *      the raw hourly rainfall in ml/parity_fixture.json and comparing every
 *      derived feature against pandas.
 *
 * Run: node scripts/check-model-parity.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// pathToFileURL, not a bare path: on Windows an absolute path starts with a
// drive letter, which the ESM loader reads as an unknown "c:" URL scheme.
const { computeFeatures, predictFlood } = await import(
  pathToFileURL(join(ROOT, 'lib', 'flood-risk.ts')).href
);

const model = JSON.parse(readFileSync(join(ROOT, 'lib', 'flood-model.json'), 'utf8'));
const fixture = JSON.parse(readFileSync(join(ROOT, 'ml', 'parity_fixture.json'), 'utf8'));

// Tolerances. The exported model rounds its coefficients to 6 decimals and the
// fixture rounds features to 6, so exact equality is not the target — silent
// structural drift is. A window off by one hour moves these by orders of
// magnitude more than rounding does.
const FEATURE_TOL = 1e-4;
const PROB_TOL = 1e-6;

let failures = 0;

function check(label, actual, expected, tol) {
  const delta = Math.abs(actual - expected);
  if (!(delta <= tol)) {
    console.error(
      `  FAIL ${label}\n       expected ${expected}\n       actual   ${actual}\n       delta    ${delta.toExponential(3)}`
    );
    failures++;
    return false;
  }
  return true;
}

console.log(`Model ${model.modelVersion}, trained ${model.trainedAt}\n`);

// ── 1. Arithmetic ────────────────────────────────────────────────────────────
console.log(`Inference arithmetic (${model.testVectors.length} held-out vectors)`);
for (const vector of model.testVectors) {
  const { probability } = predictFlood(vector.features, vector.at);
  // predictFlood rounds its output to 4dp for the wire; compare at that scale.
  const expected = Math.round(vector.expectedProbability * 10000) / 10000;
  check(`${vector.at}`, probability, expected, PROB_TOL);
}
console.log(`  ${model.testVectors.length} vectors checked\n`);

// ── 2. Feature construction ──────────────────────────────────────────────────
console.log(`Feature construction (${fixture.cases.length} raw hourly windows)`);
for (const testCase of fixture.cases) {
  const features = computeFeatures(testCase.series);

  if (!features) {
    console.error(`  FAIL ${testCase.at}: computeFeatures returned null`);
    failures++;
    continue;
  }

  let ok = true;
  for (const [name, expected] of Object.entries(testCase.expectedFeatures)) {
    ok = check(`${testCase.at} ${name}`, features[name], expected, FEATURE_TOL) && ok;
  }

  // End to end: raw rainfall in, probability out.
  const { probability } = predictFlood(features, testCase.at);
  const expectedProb = Math.round(testCase.expectedProbability * 10000) / 10000;
  ok = check(`${testCase.at} probability`, probability, expectedProb, PROB_TOL) && ok;

  if (ok) console.log(`  ok   ${testCase.at}  p=${probability.toFixed(4)}`);
}

console.log();
if (failures > 0) {
  console.error(`FAIL — ${failures} mismatch${failures === 1 ? '' : 'es'}.`);
  console.error('The TypeScript port and the trained model have diverged.');
  process.exit(1);
}
console.log('PASS — TypeScript inference matches scikit-learn on every case.');
