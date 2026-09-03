import { NextResponse } from 'next/server';
import { fetchAccuWeatherBundle, type AccuBundle } from '@/lib/providers/accuweather';

/**
 * Localized copy for what this route can actually substantiate.
 *
 * The previous `road` / `action` / `wait` / `route` string sets were deleted:
 * they asserted road condition, drainage state, traffic delay and named
 * infrastructure, all selected purely by a rainfall threshold. WeatherGPT
 * measures none of those, so it no longer claims them (Requirement 10).
 *
 * `rainfallGuidance` is the honest replacement. It speaks only about rainfall
 * and generic caution — never road state, traffic, waterlogging, closures,
 * wait times, or named roads/flyovers. `risk` keeps the existing HIGH /
 * MODERATE / SAFE mapping, and the en/hi/te mechanism is unchanged.
 */
const TRANSLATIONS = {
  en: {
    rainfallGuidance: {
      HIGH: 'Heavy rainfall in this area. Flooding is possible in low-lying spots.',
      MODERATE: 'Moderate rainfall in this area. Surface water is possible.',
      SAFE: 'No significant rainfall in this area right now.'
    },
    risk: {
      HIGH: 'high',
      MODERATE: 'moderate',
      SAFE: 'safe'
    }
  },
  hi: {
    rainfallGuidance: {
      HIGH: 'इस क्षेत्र में भारी वर्षा हो रही है। निचले इलाकों में पानी भरने की संभावना है।',
      MODERATE: 'इस क्षेत्र में मध्यम वर्षा हो रही है। सतह पर पानी जमा हो सकता है।',
      SAFE: 'इस समय इस क्षेत्र में कोई महत्वपूर्ण वर्षा नहीं है।'
    },
    risk: {
      HIGH: 'high',
      MODERATE: 'moderate',
      SAFE: 'safe'
    }
  },
  te: {
    rainfallGuidance: {
      HIGH: 'ఈ ప్రాంతంలో భారీ వర్షం. లోతట్టు ప్రాంతాల్లో నీరు నిలిచే అవకాశం ఉంది.',
      MODERATE: 'ఈ ప్రాంతంలో మధ్యస్థ వర్షం. ఉపరితలంపై నీరు నిలిచే అవకాశం ఉంది.',
      SAFE: 'ప్రస్తుతం ఈ ప్రాంతంలో గణనీయమైన వర్షం లేదు.'
    },
    risk: {
      HIGH: 'high',
      MODERATE: 'moderate',
      SAFE: 'safe'
    }
  }
};

/**
 * Supported_Area — the Hyderabad metro window this product's flood framing was
 * built for. Weather is returned for any coordinate on earth; only the local
 * flood framing is gated, so London does not receive Hyderabad flood copy.
 */
const HYDERABAD_METRO = { south: 17.2, west: 78.2, north: 17.6, east: 78.7 } as const;

function inSupportedArea(lat: number, lon: number): boolean {
  return (
    Number.isFinite(lat) && Number.isFinite(lon) &&
    lat >= HYDERABAD_METRO.south && lat <= HYDERABAD_METRO.north &&
    lon >= HYDERABAD_METRO.west && lon <= HYDERABAD_METRO.east
  );
}

/**
 * What this endpoint does not measure. Stated explicitly so the client can
 * render "not available" instead of the client inventing a value, and so a
 * future data source has one obvious place to land.
 */
const DATA_AVAILABILITY = {
  roadConditions: 'unavailable',
  trafficConditions: 'unavailable',
  drainageStatus: 'unavailable'
} as const;

// Tomorrow.io weatherCode → human-readable condition
const WEATHER_CODES: Record<number, string> = {
  1000: 'Clear sky', 1100: 'Mostly clear', 1101: 'Partly cloudy', 1102: 'Mostly cloudy',
  1001: 'Cloudy', 2000: 'Fog', 2100: 'Light fog', 4000: 'Drizzle', 4001: 'Rain',
  4200: 'Light rain', 4201: 'Heavy rain', 5000: 'Snow', 5001: 'Flurries',
  5100: 'Light snow', 5101: 'Heavy snow', 6000: 'Freezing drizzle', 6001: 'Freezing rain',
  6200: 'Light freezing rain', 6201: 'Heavy freezing rain', 7000: 'Ice pellets',
  7101: 'Heavy ice pellets', 7102: 'Light ice pellets', 8000: 'Thunderstorm',
};

type Normalized = {
  temperature: number; feelsLike: number; condition: string; rain: number;
  wind: number; humidity: number; visibility: number; pressure: number;
  cloud: number; rainChance: number;
  forecast: { label: string; value: number }[];
  riskLevel: 'HIGH' | 'MODERATE' | 'SAFE';
  source: string;
  /**
   * The provider's own observation timestamp (ISO 8601), not render time.
   * `updatedAt` in the response is populated from this, so a cached or slightly
   * stale reading is visible as such instead of always looking brand new.
   */
  observedAt: string;
};

/**
 * An official weather warning, shaped for the client (AlertSection) and the
 * chat route. Sourced only from AccuWeather's /alerts endpoint. AccuWeather's
 * nullable fields become `undefined` so this stays a clean optional shape.
 */
type OfficialAlert = {
  source: string;
  description: string;
  severity?: string;
  category?: string;
  startsAt?: string;
  endsAt?: string;
  link?: string;
};

/**
 * The normalized primary reading plus whatever AccuWeather added: measured
 * rainfall already merged into `rain`/`riskLevel`, and official alerts carried
 * alongside. `alertsAvailable` distinguishes "asked, none in force" (true, [])
 * from "could not ask" (false, []) — the client renders those two states
 * differently.
 */
type Enriched = Normalized & {
  officialAlerts: OfficialAlert[];
  alertsAvailable: boolean;
};

// In-memory cache keyed by rounded coordinates. Tomorrow.io's free tier allows
// ~25 calls/hour, so a short TTL keeps repeated views (and multiple users near
// the same spot) well under limits without serving stale readings.
const cache = new Map<string, { at: number; data: Enriched }>();
const CACHE_TTL = 4 * 60 * 1000;

// ── Log hygiene ──
// Upstream URLs carry the credential in the query string (`apikey=`, `appid=`).
// A thrown fetch/URL error can quote the URL it was given, so every error we log
// goes through here first: the credential value never reaches a log line.
const SECRET_QUERY_PARAM = /([?&](?:apikey|appid|api_key|key|token|access_token)=)[^&\s"'\\)]+/gi;

function redactSecrets(text: string): string {
  return text.replace(SECRET_QUERY_PARAM, '$1[redacted]');
}

/** Name + message (and one cause level) only — no stack, no request object. */
function safeErrorText(err: unknown): string {
  const parts: string[] = [];
  if (err instanceof Error) {
    parts.push(`${err.name}: ${err.message}`);
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof Error) parts.push(`cause ${cause.name}: ${cause.message}`);
    else if (typeof cause === 'string') parts.push(`cause ${cause}`);
  } else {
    parts.push(String(err));
  }
  return redactSecrets(parts.join(' | '));
}

function computeRisk(effectiveRain: number): 'HIGH' | 'MODERATE' | 'SAFE' {
  if (effectiveRain >= 7) return 'HIGH';
  if (effectiveRain >= 3) return 'MODERATE';
  return 'SAFE';
}

/** Largest non-null value, or null when every entry is null. */
function maxNonNull(values: (number | null)[]): number | null {
  const present = values.filter((v): v is number => v !== null);
  return present.length ? Math.max(...present) : null;
}

/** null → undefined, so AccuWeather's nullable fields fit the optional shape. */
function orUndef(value: string | null): string | undefined {
  return value === null ? undefined : value;
}

/**
 * Fold an AccuWeather bundle into the primary reading. Two things move:
 *
 *  1. Rainfall. Tomorrow.io reports an intensity (mm/hr right now); AccuWeather
 *     reports MEASURED accumulation over the past hour (PrecipitationSummary +
 *     Precip1hr, mm). Per spec, when AccuWeather has seen more water than the
 *     primary intensity we surface the larger number and recompute risk from
 *     it. Comparing an accumulation against a rate is a deliberate,
 *     flood-cautious overstatement — it can only raise rain/risk, never lower
 *     it — not an accident.
 *  2. Official alerts pass straight through, mapped to OfficialAlert.
 *
 * AccuWeather being absent (`null`) leaves the reading exactly as the primary
 * source produced it, with no alerts and `alertsAvailable: false`.
 */
function mergeAccu(base: Normalized, accu: AccuBundle | null): Enriched {
  if (!accu) {
    return { ...base, officialAlerts: [], alertsAvailable: false };
  }

  const officialAlerts: OfficialAlert[] = accu.alerts.map((a) => ({
    source: a.source,
    description: a.description,
    severity: orUndef(a.severity),
    category: orUndef(a.category),
    startsAt: orUndef(a.startsAt),
    endsAt: orUndef(a.endsAt),
    link: orUndef(a.link),
  }));

  const obs = accu.observation;
  // Measured mm over the past hour, from whichever measured field is present.
  const accuRain = obs ? maxNonNull([obs.accumulation.pastHour, obs.precip1hMm]) : null;

  // No larger measured rain → keep every number as-is, just attach alerts.
  if (accuRain === null || accuRain <= base.rain) {
    return { ...base, officialAlerts, alertsAvailable: accu.alertsAvailable };
  }

  // AccuWeather has measured more rain than the primary intensity. Raise the
  // shown rain and recompute risk against the primary's effective rain (its
  // current reading + its 90-min forecast peak) versus this measurement.
  const baseEffective = Math.max(base.rain, ...base.forecast.map((f) => f.value));
  const effectiveRain = Math.max(baseEffective, accuRain);

  return {
    ...base,
    rain: parseFloat(accuRain.toFixed(1)),
    riskLevel: computeRisk(effectiveRain),
    source: `${base.source} + AccuWeather`,
    officialAlerts,
    alertsAvailable: accu.alertsAvailable,
  };
}

/**
 * Provider observation time as ISO 8601. Falls back to now only when the
 * provider omitted a usable timestamp, which keeps the field a valid date
 * without silently pretending an unknown age is zero elsewhere in the shape.
 */
function observedAtIso(ms: number | undefined | null): string {
  return Number.isFinite(ms as number) ? new Date(ms as number).toISOString() : new Date().toISOString();
}

// ── Tomorrow.io: current conditions + real minute-level nowcast ──
async function fetchTomorrow(lat: string, lon: string): Promise<Normalized> {
  const key = process.env.TOMORROW_API_KEY;
  if (!key) throw new Error('Tomorrow.io key missing');

  const url = `https://api.tomorrow.io/v4/weather/forecast?location=${lat},${lon}&timesteps=1m,1h&units=metric&apikey=${key}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Tomorrow.io ${res.status}`);

  const data = await res.json();
  const minutely: any[] = data?.timelines?.minutely ?? [];
  const hourly: any[] = data?.timelines?.hourly ?? [];
  if (!minutely.length) throw new Error('Tomorrow.io returned no minutely data');

  const now = Date.now();
  const cur = minutely[0].values; // minutely[0] ≈ current conditions

  // Merge minutely (0–60 min, minute precision) + hourly (beyond) into one
  // precip timeline expressed in minutes-from-now, then interpolate.
  const pts: { t: number; rain: number; pop: number }[] = [];
  for (const m of minutely) {
    pts.push({
      t: (Date.parse(m.time) - now) / 60000,
      rain: m.values.rainIntensity ?? 0,
      pop: m.values.precipitationProbability ?? 0,
    });
  }
  for (const h of hourly) {
    const t = (Date.parse(h.time) - now) / 60000;
    if (t > 55 && t < 200) {
      pts.push({
        t,
        rain: h.values.rainIntensity ?? 0,
        pop: h.values.precipitationProbability ?? 0,
      });
    }
  }
  pts.sort((a, b) => a.t - b.t);

  const rainAt = (target: number): number => {
    if (!pts.length) return cur.rainIntensity ?? 0;
    if (target <= pts[0].t) return pts[0].rain;
    for (let i = 1; i < pts.length; i++) {
      if (pts[i].t >= target) {
        const a = pts[i - 1], b = pts[i];
        const f = (target - a.t) / ((b.t - a.t) || 1);
        return a.rain + (b.rain - a.rain) * f;
      }
    }
    return pts[pts.length - 1].rain;
  };

  const forecast = [
    { label: '+30 min', value: Math.max(0, parseFloat(rainAt(30).toFixed(2))) },
    { label: '+60 min', value: Math.max(0, parseFloat(rainAt(60).toFixed(2))) },
    { label: '+90 min', value: Math.max(0, parseFloat(rainAt(90).toFixed(2))) },
  ];

  const popsInRange = pts.filter((p) => p.t <= 90).map((p) => p.pop);
  const rainChance = Math.min(100, Math.round(popsInRange.length ? Math.max(...popsInRange) : 0));

  const currentRain = cur.rainIntensity ?? 0;
  const effectiveRain = Math.max(currentRain, ...forecast.map((f) => f.value));

  return {
    temperature: Math.round(cur.temperature ?? 0),
    feelsLike: Math.round(cur.temperatureApparent ?? cur.temperature ?? 0),
    condition: WEATHER_CODES[cur.weatherCode] ?? '',
    rain: parseFloat(currentRain.toFixed(1)),
    wind: parseFloat(((cur.windSpeed ?? 0) * 3.6).toFixed(1)),
    humidity: Math.round(cur.humidity ?? 0),
    visibility: Math.round(cur.visibility ?? 0),
    pressure: Math.round(cur.pressureSeaLevel ?? cur.pressureSurfaceLevel ?? 0),
    cloud: Math.round(cur.cloudCover ?? 0),
    rainChance,
    forecast,
    riskLevel: computeRisk(effectiveRain),
    source: 'Tomorrow.io',
    // minutely[0] is the current-conditions bucket, so its `time` is the
    // provider's observation instant.
    observedAt: observedAtIso(Date.parse(minutely[0].time)),
  };
}

// ── OpenWeatherMap: fallback if Tomorrow.io is unavailable / rate-limited ──
async function fetchOpenWeather(lat: string, lon: string): Promise<Normalized> {
  const apiKey = process.env.OPENWEATHER_API_KEY;
  if (!apiKey) throw new Error('OpenWeather key missing');

  const weatherUrl = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&units=metric&appid=${apiKey}`;
  const forecastUrl = `https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&units=metric&appid=${apiKey}`;
  // allSettled, not all: the code below already tolerates a missing forecast,
  // so a thrown forecast fetch must not take the whole fallback down with it.
  // A rejected or non-ok forecast simply degrades to an empty bucket list.
  const [weatherSettled, forecastSettled] = await Promise.allSettled([
    fetch(weatherUrl),
    fetch(forecastUrl),
  ]);

  if (weatherSettled.status === 'rejected') throw weatherSettled.reason;
  const weatherRes = weatherSettled.value;
  if (!weatherRes.ok) throw new Error(`OpenWeather ${weatherRes.status}`);

  const weatherData = await weatherRes.json();

  let forecastData: { list?: any[] } = { list: [] };
  if (forecastSettled.status === 'fulfilled' && forecastSettled.value.ok) {
    try {
      forecastData = await forecastSettled.value.json();
    } catch (err) {
      console.warn('OpenWeather forecast body unreadable, continuing without it:', safeErrorText(err));
      forecastData = { list: [] };
    }
  } else if (forecastSettled.status === 'rejected') {
    console.warn('OpenWeather forecast unavailable, continuing without it:', safeErrorText(forecastSettled.reason));
  }

  let rainRate = 0;
  if (weatherData.rain) {
    if (weatherData.rain['1h'] !== undefined) rainRate = weatherData.rain['1h'];
    else if (weatherData.rain['3h'] !== undefined) rainRate = weatherData.rain['3h'] / 3;
  }

  // OpenWeather forecast is 3-hourly; interpolate toward the next bucket.
  const baseRain = rainRate;
  let nextRain = rainRate;
  let forecastMinutesAway = 180;
  if (forecastData.list && forecastData.list.length > 0) {
    const nextForecast = forecastData.list[0];
    forecastMinutesAway = Math.max(1, Math.round((nextForecast.dt * 1000 - Date.now()) / 60000));
    nextRain = nextForecast.rain && nextForecast.rain['3h'] !== undefined ? nextForecast.rain['3h'] / 3 : 0;
  }
  const ratePerMin = (nextRain - baseRain) / forecastMinutesAway;
  const rainAt = (mins: number) => {
    if (mins <= 0) return baseRain;
    if (mins >= forecastMinutesAway) return nextRain;
    return baseRain + ratePerMin * mins;
  };

  const forecast = [
    { label: '+30 min', value: Math.max(0, parseFloat(rainAt(30).toFixed(2))) },
    { label: '+60 min', value: Math.max(0, parseFloat(rainAt(60).toFixed(2))) },
    { label: '+90 min', value: Math.max(0, parseFloat(rainAt(90).toFixed(2))) },
  ];

  let rainChance = 0;
  if (forecastData.list && forecastData.list.length > 0) {
    const inRange = forecastData.list.filter((entry: any) => (entry.dt * 1000 - Date.now()) / 60000 <= 90);
    const buckets = inRange.length ? inRange : [forecastData.list[0]];
    rainChance = Math.min(100, Math.round(Math.max(...buckets.map((entry: any) => entry.pop || 0)) * 100));
  }

  const effectiveRain = Math.max(rainRate, ...forecast.map((f) => f.value));

  return {
    temperature: Math.round(weatherData.main?.temp || 0),
    feelsLike: Math.round(weatherData.main?.feels_like || 0),
    condition: weatherData.weather?.[0]?.description || '',
    rain: parseFloat(rainRate.toFixed(1)),
    wind: parseFloat(((weatherData.wind?.speed || 0) * 3.6).toFixed(1)),
    humidity: weatherData.main?.humidity || 0,
    visibility: Math.round((weatherData.visibility || 0) / 1000),
    pressure: weatherData.main?.pressure || 0,
    cloud: weatherData.clouds?.all || 0,
    rainChance,
    forecast,
    riskLevel: computeRisk(effectiveRain),
    source: 'OpenWeatherMap',
    // OWM reports its observation instant in `dt` (unix seconds).
    observedAt: observedAtIso(typeof weatherData.dt === 'number' ? weatherData.dt * 1000 : null),
  };
}

async function getWeather(lat: string, lon: string): Promise<Enriched> {
  const cacheKey = `${parseFloat(lat).toFixed(3)},${parseFloat(lon).toFixed(3)}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached.data;

  // AccuWeather runs ALONGSIDE the primary source, not after it. It never
  // throws (returns null on any failure — no key, spent quota, network error),
  // so it needs no try/catch and can never break the primary weather flow. The
  // merged bundle is what gets cached, so a cache hit within the TTL spends no
  // AccuWeather quota.
  const accuPromise = fetchAccuWeatherBundle(parseFloat(lat), parseFloat(lon));

  let base: Normalized;
  try {
    base = await fetchTomorrow(lat, lon);
  } catch (err) {
    console.warn('Tomorrow.io failed, falling back to OpenWeatherMap:', safeErrorText(err));
    base = await fetchOpenWeather(lat, lon);
  }

  const accu = await accuPromise;
  const data = mergeAccu(base, accu);

  cache.set(cacheKey, { at: Date.now(), data });
  return data;
}

// ── Geocoding (OpenWeatherMap, forward + reverse) ──

function placeLabel(entry: { name?: string; state?: string }): string {
  if (!entry?.name) return '';
  return entry.state ? `${entry.name}, ${entry.state}` : entry.name;
}

/** Coordinate pair label — the last-resort display name, never a guess. */
function coordLabel(lat: number, lon: number): string {
  return `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
}

async function forwardGeocode(
  queryText: string,
  geoKey: string
): Promise<{ lat: number; lon: number; name: string } | null> {
  const url = `https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(queryText)}&limit=1&appid=${geoKey}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) return null;
  const hit = data[0];
  if (!Number.isFinite(hit?.lat) || !Number.isFinite(hit?.lon)) return null;
  return { lat: hit.lat, lon: hit.lon, name: placeLabel(hit) || queryText };
}

/** Always returns a usable label: the reverse-geocoded place, else the coords. */
async function reverseGeocode(lat: number, lon: number, geoKey: string): Promise<string> {
  try {
    const url = `https://api.openweathermap.org/geo/1.0/reverse?lat=${lat}&lon=${lon}&limit=1&appid=${geoKey}`;
    const res = await fetch(url);
    if (!res.ok) return coordLabel(lat, lon);
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) return coordLabel(lat, lon);
    return placeLabel(data[0]) || coordLabel(lat, lon);
  } catch (err) {
    console.warn('Reverse geocode failed, using coordinate label:', safeErrorText(err));
    return coordLabel(lat, lon);
  }
}

// ── Demo mode (presentation only) ──
/**
 * Hand-written SCENARIOS FOR LIVE DEMONSTRATION, served only when `?demo=<id>`
 * names one of them. Nothing here is a measurement, and the response says so in
 * three places: `source: 'Demo Mode (Simulated)'`, `provenance.kind: 'demo'`,
 * and `simulated: true` — the client renders a SIMULATED badge from that last
 * flag, so a fabricated reading cannot be mistaken for a real one on screen.
 *
 * This branch returns before any key check, geocode, cache lookup or provider
 * call, so a demo works with no API keys configured and spends no upstream
 * quota — which is the point: the scenarios must not depend on the weather, or
 * on a rate limit, on the day. An unrecognised `demo` value is ignored and the
 * real path runs untouched.
 *
 * The rainfall figures are consistent with computeRisk()'s real thresholds
 * (>=7 HIGH, >=3 MODERATE), so each scenario reaches its risk level through the
 * genuine mapping rather than asserting a level the numbers would not produce.
 * Coordinates are the real ones for each named locality, all inside
 * HYDERABAD_METRO, so the map centres where the label says it does.
 */
const DEMO_SOURCE = 'Demo Mode (Simulated)';

const DEMO_IDS = ['heavy_rain', 'moderate_rain', 'clear'] as const;
type DemoId = (typeof DEMO_IDS)[number];

/** Narrowing guard — an own-property check, so no inherited key can match. */
function isDemoId(value: string | null): value is DemoId {
  return value !== null && (DEMO_IDS as readonly string[]).includes(value);
}

type DemoScenario = {
  area: string;
  lat: number;
  lon: number;
  temperature: number;
  feelsLike: number;
  condition: string;
  rain: number;
  wind: number;
  humidity: number;
  visibility: number;
  pressure: number;
  cloud: number;
  rainChance: number;
  riskLevel: 'HIGH' | 'MODERATE' | 'SAFE';
  forecast: { label: string; value: number }[];
  /**
   * `validForMinutes` is relative to request time, so a demo warning's validity
   * window always reads as current. No `link` field exists by design: a citation
   * URL would be a claim about a real authority's published page.
   */
  alerts: { source: string; description: string; severity: string; validForMinutes: number }[];
};

const DEMO_SCENARIOS: Record<DemoId, DemoScenario> = {
  // Peak-monsoon cloudburst. 18.5 mm/hr is extreme; rainfall peaks at +30 min
  // and eases across the window, so the forecast trend reads as "easing".
  heavy_rain: {
    area: 'Meerpet, Hyderabad',
    lat: 17.3162,
    lon: 78.5386,
    temperature: 24,
    feelsLike: 28,
    condition: 'Heavy thunderstorm',
    rain: 18.5,
    wind: 45,
    humidity: 95,
    visibility: 1,
    pressure: 998,
    cloud: 100,
    rainChance: 100,
    riskLevel: 'HIGH',
    forecast: [
      { label: '+30 min', value: 22.1 },
      { label: '+60 min', value: 15.3 },
      { label: '+90 min', value: 8.7 },
    ],
    alerts: [
      {
        source: 'India Meteorological Department',
        description:
          'Red Alert — Extremely heavy rainfall warning issued by IMD for Hyderabad district. Avoid travel. Stay indoors. Low-lying areas at risk of flooding.',
        severity: 'Red',
        validForMinutes: 360,
      },
    ],
  },
  // Ordinary monsoon shower, decaying steadily. No warning in force.
  moderate_rain: {
    area: 'Kukatpally, Hyderabad',
    lat: 17.4849,
    lon: 78.4138,
    temperature: 26,
    feelsLike: 29,
    condition: 'Moderate rain',
    rain: 5.2,
    wind: 22,
    humidity: 82,
    visibility: 5,
    pressure: 1005,
    cloud: 90,
    rainChance: 80,
    riskLevel: 'MODERATE',
    forecast: [
      { label: '+30 min', value: 4.8 },
      { label: '+60 min', value: 3.1 },
      { label: '+90 min', value: 1.5 },
    ],
    alerts: [],
  },
  // Dry post-monsoon afternoon — the baseline the other two are read against.
  clear: {
    area: 'Banjara Hills, Hyderabad',
    lat: 17.4156,
    lon: 78.4347,
    temperature: 33,
    feelsLike: 36,
    condition: 'Partly cloudy',
    rain: 0,
    wind: 12,
    humidity: 55,
    visibility: 10,
    pressure: 1012,
    cloud: 30,
    rainChance: 10,
    riskLevel: 'SAFE',
    forecast: [
      { label: '+30 min', value: 0 },
      { label: '+60 min', value: 0 },
      { label: '+90 min', value: 0 },
    ],
    alerts: [],
  },
};

/**
 * Assemble a scenario into the exact shape the real path returns, so the client
 * needs no demo-specific rendering. Localized guidance goes through the same
 * TRANSLATIONS table, which means a demo also demonstrates hi/te correctly.
 */
function demoResponse(scenario: DemoScenario, lang: string) {
  const tLang = ['hi', 'te'].includes(lang) ? lang : 'en';
  const t = TRANSLATIONS[tLang as keyof typeof TRANSLATIONS];

  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  const officialAlerts: OfficialAlert[] = scenario.alerts.map((a) => ({
    source: a.source,
    description: a.description,
    severity: a.severity,
    startsAt: nowIso,
    endsAt: new Date(now + a.validForMinutes * 60_000).toISOString(),
  }));

  return {
    area: scenario.area,
    temperature: scenario.temperature,
    feelsLike: scenario.feelsLike,
    condition: scenario.condition,
    rain: scenario.rain,
    wind: scenario.wind,
    humidity: scenario.humidity,
    visibility: scenario.visibility,
    pressure: scenario.pressure,
    cloud: scenario.cloud,
    rainChance: scenario.rainChance,
    risk: t.risk[scenario.riskLevel],
    rainfallGuidance: t.rainfallGuidance[scenario.riskLevel],
    dataAvailability: DATA_AVAILABILITY,
    inSupportedArea: inSupportedArea(scenario.lat, scenario.lon),
    updatedAt: nowIso,
    provenance: {
      source: DEMO_SOURCE,
      observedAt: nowIso,
      // Not 'realtime'. Leaving that value in place would be a lie in the one
      // field whose whole job is to describe where a reading came from.
      kind: 'demo' as const,
    },
    forecast: scenario.forecast,
    source: DEMO_SOURCE,
    officialAlerts,
    // A scenario states its own warnings in full, so "asked, and this is the
    // answer" is true: an empty list means none in force, not "could not ask".
    alertsAvailable: true,
    /** The client's render flag for the SIMULATED badge. Absent on real readings. */
    simulated: true as const,
    lat: scenario.lat,
    lon: scenario.lon,
  };
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const q = searchParams.get('q');
    let lat = searchParams.get('lat');
    let lon = searchParams.get('lon');
    const lang = (searchParams.get('lang') || 'en').toLowerCase();

    // Demo mode, before anything else — see DEMO_SCENARIOS. Deliberately ahead
    // of the key check below so a presentation cannot be broken by a missing key
    // or a spent quota. Any other `demo` value (including `demo=true`, which is
    // only the client's bar-reveal flag) falls through to the real path.
    const demoId = searchParams.get('demo');
    if (isDemoId(demoId)) {
      return NextResponse.json(demoResponse(DEMO_SCENARIOS[demoId], lang));
    }

    // Geocoding stays on OpenWeatherMap (forward + reverse).
    const geoKey = process.env.OPENWEATHER_API_KEY;
    if (!geoKey) {
      return NextResponse.json(
        { error: { code: 'UNCONFIGURED', message: 'Weather service is not configured' } },
        { status: 503 }
      );
    }

    // ── Location precedence: COORDINATES WIN ──
    // Previously, supplying `q` *and* `lat`/`lon` together matched neither
    // geocode branch (`queryText && (!lat || !lon)` was false, and
    // `lat && lon && !q` was false too), so `areaName` silently fell through as
    // the raw query string — an unverified label attached to real coordinates.
    // The rule is now explicit: if lat/lon both parse as finite numbers they
    // position the request and `q` is ignored, with the display name coming
    // from reverse geocoding those coordinates. `q` is used only when
    // coordinates are absent or unparseable. areaName is always resolved.
    // `Number('')` is 0, so require a non-empty string before parsing.
    const latNum = lat?.trim() ? Number(lat) : NaN;
    const lonNum = lon?.trim() ? Number(lon) : NaN;
    const hasCoords = Number.isFinite(latNum) && Number.isFinite(lonNum);

    let areaName = '';

    if (hasCoords) {
      lat = String(latNum);
      lon = String(lonNum);
      areaName = await reverseGeocode(latNum, lonNum, geoKey);
    } else {
      const queryText = q?.trim() || 'Hyderabad, IN';
      const geocoded = await forwardGeocode(queryText, geoKey);
      if (!geocoded) {
        return NextResponse.json({ error: 'Location not found' }, { status: 404 });
      }
      lat = String(geocoded.lat);
      lon = String(geocoded.lon);
      areaName = geocoded.name;
    }

    if (!lat || !lon || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) {
      return NextResponse.json({ error: 'Could not resolve location' }, { status: 400 });
    }

    const w = await getWeather(lat, lon);

    // Localized rainfall guidance, driven by the computed risk level. No road,
    // traffic, drainage, wait-time or named-infrastructure claim is made here.
    const tLang = ['hi', 'te'].includes(lang) ? lang : 'en';
    const t = TRANSLATIONS[tLang as keyof typeof TRANSLATIONS];

    const resolvedLat = parseFloat(lat);
    const resolvedLon = parseFloat(lon);

    const response = {
      area: areaName,
      temperature: w.temperature,
      feelsLike: w.feelsLike,
      condition: w.condition,
      rain: w.rain,
      wind: w.wind,
      humidity: w.humidity,
      visibility: w.visibility,
      pressure: w.pressure,
      cloud: w.cloud,
      rainChance: w.rainChance,
      risk: t.risk[w.riskLevel],
      rainfallGuidance: t.rainfallGuidance[w.riskLevel],
      dataAvailability: DATA_AVAILABILITY,
      inSupportedArea: inSupportedArea(resolvedLat, resolvedLon),
      // Provider observation time, not request time.
      updatedAt: w.observedAt,
      provenance: {
        source: w.source,
        observedAt: w.observedAt,
        kind: 'realtime' as const,
      },
      forecast: w.forecast,
      source: w.source,
      officialAlerts: w.officialAlerts,
      alertsAvailable: w.alertsAvailable,
      lat: resolvedLat,
      lon: resolvedLon,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('Weather API Error:', safeErrorText(error));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
