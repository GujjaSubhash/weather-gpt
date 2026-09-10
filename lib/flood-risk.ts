/**
 * Flood-risk inference: the model trained in ml/train.py, run in-process.
 *
 * The model is a logistic regression, which at inference time is a dot product
 * and one exponential. That is the entire reason it was chosen over the
 * gradient-boosted alternative (which scored slightly worse anyway — see
 * ml/metrics.json): no ML runtime, no WASM, no new dependency, and every
 * coefficient is readable, so the UI can say WHY a reading is elevated rather
 * than just asserting it.
 *
 * The feature windows here MUST match ml/train.py exactly. A model trained on
 * "sum of the last 24 hours" and served "mean of the last 24 hours" does not
 * error — it just quietly gets worse. parity-check.mjs exists to stop that:
 * it replays the held-out vectors baked into flood-model.json through this file
 * and fails if any probability drifts.
 */

// The import attribute is required by Node's ESM loader, which is what runs
// scripts/check-model-parity.mjs. Turbopack and TypeScript both accept the
// standard syntax, so one form works for the app and the checker alike.
import model from './flood-model.json' with { type: 'json' };

export type FloodLevel = 'HIGH' | 'MODERATE' | 'SAFE';

/** Open-Meteo's hourly block, verbatim. Times are LOCAL and carry no offset. */
export type HourlySeries = {
  time: string[];
  precipitation: (number | null)[];
};

export type FloodFactor = {
  /** Model feature name, e.g. `api_30d`. */
  feature: string;
  /** Plain-language label for the UI, from the model export. */
  label: string;
  /** The feature's own value (mm, hours, or index units). */
  value: number;
  /**
   * Signed push on the log-odds: coefficient x standardized value. Positive
   * raises the risk. This is what ranks the explanation.
   */
  contribution: number;
};

export type FloodAssessment = {
  level: FloodLevel;
  /** Calibrated-ish probability of high river flow within two days, 0-1. */
  probability: number;
  /** Strongest upward contributors, most important first. */
  factors: FloodFactor[];
  features: Record<string, number>;
  modelVersion: string;
  /** The local hour the features describe, e.g. "2026-09-09T07:00". */
  asOf: string;
};

// Antecedent precipitation index: 30 days of daily rain, discounted by 0.9^age.
// Mirrors API_DECAY / API_WINDOW_DAYS in ml/train.py.
const API_DECAY = 0.9;
const API_WINDOW_DAYS = 30;

// An hour counts as "wet" above this, matching the training script. Below it,
// ERA5 and the live feed both emit trace amounts that are not really rain.
const WET_HOUR_MM = 0.1;

/** Longest window the features need: 30 antecedent days plus the current one. */
export const REQUIRED_HISTORY_DAYS = API_WINDOW_DAYS + 1;

function sumLast(values: number[], n: number): number {
  let total = 0;
  for (let i = Math.max(0, values.length - n); i < values.length; i++) total += values[i];
  return total;
}

function maxLast(values: number[], n: number): number {
  let best = 0;
  for (let i = Math.max(0, values.length - n); i < values.length; i++) {
    if (values[i] > best) best = values[i];
  }
  return best;
}

function countLast(values: number[], n: number, above: number): number {
  let count = 0;
  for (let i = Math.max(0, values.length - n); i < values.length; i++) {
    if (values[i] > above) count++;
  }
  return count;
}

/**
 * Antecedent precipitation index at the end of `dates[last]`.
 *
 * Deliberately EXCLUDES the current calendar day — that rain is already carried
 * by rain_24h, and counting it twice was not what the model was fitted on.
 * Day-1 carries weight 0.9^0, day-2 carries 0.9^1, and so on for 30 days.
 */
function antecedentIndex(hourTimes: string[], rain: number[]): number {
  const byDay = new Map<string, number>();
  for (let i = 0; i < hourTimes.length; i++) {
    const day = hourTimes[i].slice(0, 10); // "YYYY-MM-DD" in local time
    byDay.set(day, (byDay.get(day) ?? 0) + rain[i]);
  }

  const days = [...byDay.keys()].sort();
  // Drop the current day, then walk backwards applying the decay.
  const previous = days.slice(0, -1);
  let index = 0;
  for (let age = 0; age < API_WINDOW_DAYS; age++) {
    const day = previous[previous.length - 1 - age];
    if (day === undefined) break;
    index += (byDay.get(day) ?? 0) * API_DECAY ** age;
  }
  return index;
}

/**
 * Build the model's feature vector from an hourly rainfall series.
 *
 * Returns null when the series is too short to fill the windows — better to
 * fall back to the threshold rule than to feed the model a half-empty vector
 * it would happily score as "dry".
 */
export function computeFeatures(series: HourlySeries): Record<string, number> | null {
  const times: string[] = [];
  const rain: number[] = [];

  for (let i = 0; i < series.time.length; i++) {
    const value = series.precipitation[i];
    // A null is a gap in the record, not a zero. Stop at the first one rather
    // than inventing dry hours in the middle of the window.
    if (value === null || value === undefined || !Number.isFinite(value)) continue;
    times.push(series.time[i]);
    rain.push(Math.max(0, value));
  }

  // Need the full antecedent window; a short series would understate api_30d,
  // which is the model's heaviest feature.
  if (rain.length < API_WINDOW_DAYS * 24) return null;

  return {
    rain_1h: rain[rain.length - 1],
    rain_3h: sumLast(rain, 3),
    rain_6h: sumLast(rain, 6),
    rain_24h: sumLast(rain, 24),
    rain_72h: sumLast(rain, 72),
    rain_7d: sumLast(rain, 168),
    max_1h_in_24h: maxLast(rain, 24),
    wet_hours_24h: countLast(rain, 24, WET_HOUR_MM),
    api_30d: antecedentIndex(times, rain),
  };
}

/** Logistic function, guarded against overflow at the tails. */
function sigmoid(z: number): number {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

/**
 * Score a feature vector. Standardize, dot with the coefficients, add the
 * intercept, squash — the same three lines scikit-learn runs, just written out.
 */
export function predictFlood(
  features: Record<string, number>,
  asOf: string
): FloodAssessment {
  const { features: names, mean, scale, coefficients, intercept, thresholds } = model;

  let logOdds = intercept;
  const contributions: FloodFactor[] = [];

  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const raw = features[name] ?? 0;
    // A zero scale would mean a constant feature; treat it as contributing
    // nothing rather than dividing by zero.
    const standardized = scale[i] === 0 ? 0 : (raw - mean[i]) / scale[i];
    const contribution = coefficients[i] * standardized;
    logOdds += contribution;
    contributions.push({
      feature: name,
      label: (model.featureLabels as Record<string, string>)[name] ?? name,
      value: Math.round(raw * 100) / 100,
      contribution: Math.round(contribution * 10000) / 10000,
    });
  }

  const probability = sigmoid(logOdds);
  const level: FloodLevel =
    probability >= thresholds.high ? 'HIGH'
      : probability >= thresholds.moderate ? 'MODERATE'
        : 'SAFE';

  // Only upward pushes explain an elevated reading; a negative contribution is
  // the model arguing against risk, which is not what the UI is asking for.
  const factors = contributions
    .filter((c) => c.contribution > 0.01)
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, 3);

  return {
    level,
    probability: Math.round(probability * 10000) / 10000,
    factors,
    features: Object.fromEntries(
      Object.entries(features).map(([k, v]) => [k, Math.round(v * 100) / 100])
    ),
    modelVersion: model.modelVersion,
    asOf,
  };
}

/** Convenience: series in, assessment out. Null when the series is unusable. */
export function assessFromSeries(series: HourlySeries): FloodAssessment | null {
  const features = computeFeatures(series);
  if (!features) return null;

  const usableTimes = series.time.filter(
    (_, i) => series.precipitation[i] !== null && series.precipitation[i] !== undefined
  );
  const asOf = usableTimes[usableTimes.length - 1] ?? '';
  return predictFlood(features, asOf);
}

/** Metadata for the UI and the API response, without exposing the weights. */
export const MODEL_INFO = {
  version: model.modelVersion,
  kind: model.kind,
  trainedAt: model.trainedAt,
  trainYears: model.training.trainYears,
  testYears: model.training.testYears,
  labelDefinition: model.training.labelDefinition,
} as const;
