/**
 * Open-Meteo provider — recent rainfall history for the flood model.
 *
 * Server-only by convention (it is called from app/api/weather/route.ts), but
 * unlike every other provider here it needs NO credential: Open-Meteo's free
 * tier is keyless. There is consequently nothing in this file to redact, and no
 * entry in .env.local to add.
 *
 * ── WHY THIS EXISTS ──
 * The flood model in lib/flood-risk.ts is trained on rainfall ACCUMULATION and
 * on how saturated the ground already is — 24-hour, 72-hour and 7-day totals,
 * plus a 30-day antecedent index. None of the existing providers offer that:
 * Tomorrow.io and OpenWeatherMap report current intensity and a short forecast,
 * and AccuWeather reports at most the past 24 hours (and is quota-starved).
 * Without a history feed the model's heaviest feature would always read zero,
 * which is not a degraded prediction — it is a confidently wrong one.
 *
 * ── OPTIONAL BY CONSTRUCTION ──
 * Every export returns `null` on any failure. The caller treats that as "no
 * model reading available" and falls back to the threshold rule, so this file
 * being unreachable leaves the product exactly as it was before it existed.
 *
 * ── QUOTA ──
 * The free tier allows roughly 10,000 calls/day, which is far beyond anything
 * this app will do, but the response is still cached: the features only move
 * once an hour, so re-fetching per request would be waste rather than freshness.
 */

import { REQUIRED_HISTORY_DAYS, type HourlySeries } from '@/lib/flood-risk';

const ENDPOINT = 'https://api.open-meteo.com/v1/forecast';

/**
 * The model was trained on calendar days in Asia/Kolkata, and its antecedent
 * index aggregates by local day — so the day boundary has to match or the
 * feature shifts. This is hardcoded rather than `timezone=auto` because the
 * caller only runs the model inside the Hyderabad metro box, where IST is
 * always the right answer.
 */
const TIMEZONE = 'Asia/Kolkata';

/** Features move hourly, so anything fresher than this is wasted work. */
const CACHE_TTL = 15 * 60 * 1000;

/** Upstream is not this app's to hang on; fail to the fallback instead. */
const TIMEOUT_MS = 6000;

const cache = new Map<string, { at: number; series: HourlySeries }>();

/** Name + message only, no stack and no request object — matches the route. */
function safeErrorText(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

/**
 * Local wall-clock "now" at the given UTC offset, as the same
 * `YYYY-MM-DDTHH:mm` shape Open-Meteo returns. ISO strings of identical shape
 * compare correctly with `<=`, so this avoids parsing every timestamp.
 */
function localNowStamp(utcOffsetSeconds: number): string {
  const shifted = new Date(Date.now() + utcOffsetSeconds * 1000);
  return shifted.toISOString().slice(0, 16);
}

/**
 * Hourly rainfall for the trailing ~31 days at a coordinate, trimmed to hours
 * that have actually happened.
 *
 * The request asks for one forecast day as well, because Open-Meteo fills the
 * current partial day from the forecast model — without it the series can end
 * several hours in the past. Those future hours are then cut: the model must
 * describe what HAS fallen, and letting a forecast into the feature window
 * would quietly turn a nowcast into a prediction of a prediction.
 */
export async function fetchRainHistory(
  lat: number,
  lon: number
): Promise<HourlySeries | null> {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached.series;

  const url = new URL(ENDPOINT);
  url.searchParams.set('latitude', lat.toFixed(4));
  url.searchParams.set('longitude', lon.toFixed(4));
  url.searchParams.set('hourly', 'precipitation');
  url.searchParams.set('past_days', String(REQUIRED_HISTORY_DAYS));
  url.searchParams.set('forecast_days', '1');
  url.searchParams.set('timezone', TIMEZONE);

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      // Next's fetch cache would hold this past the point the features move.
      cache: 'no-store',
    });
    if (!res.ok) {
      console.warn(`Open-Meteo history ${res.status}, falling back to threshold rule`);
      return null;
    }

    const body = await res.json();
    const times: unknown = body?.hourly?.time;
    const values: unknown = body?.hourly?.precipitation;
    const offset: unknown = body?.utc_offset_seconds;

    if (!Array.isArray(times) || !Array.isArray(values) || times.length !== values.length) {
      console.warn('Open-Meteo history: unexpected shape, falling back to threshold rule');
      return null;
    }

    const cutoff = localNowStamp(typeof offset === 'number' ? offset : 0);
    const time: string[] = [];
    const precipitation: (number | null)[] = [];

    for (let i = 0; i < times.length; i++) {
      const stamp = times[i];
      if (typeof stamp !== 'string' || stamp > cutoff) continue;
      const value = values[i];
      time.push(stamp);
      precipitation.push(typeof value === 'number' && Number.isFinite(value) ? value : null);
    }

    if (!time.length) return null;

    const series: HourlySeries = { time, precipitation };
    cache.set(key, { at: Date.now(), series });
    return series;
  } catch (err) {
    console.warn('Open-Meteo history unavailable:', safeErrorText(err));
    return null;
  }
}
