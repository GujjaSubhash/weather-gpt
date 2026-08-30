import { NextResponse } from 'next/server';

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

// In-memory cache keyed by rounded coordinates. Tomorrow.io's free tier allows
// ~25 calls/hour, and the client auto-refreshes every 10 min, so a short TTL
// keeps repeated views (and multiple users near the same spot) well under limits.
const cache = new Map<string, { at: number; data: Normalized }>();
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

async function getWeather(lat: string, lon: string): Promise<Normalized> {
  const cacheKey = `${parseFloat(lat).toFixed(3)},${parseFloat(lon).toFixed(3)}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached.data;

  let data: Normalized;
  try {
    data = await fetchTomorrow(lat, lon);
  } catch (err) {
    console.warn('Tomorrow.io failed, falling back to OpenWeatherMap:', safeErrorText(err));
    data = await fetchOpenWeather(lat, lon);
  }

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

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const q = searchParams.get('q');
    let lat = searchParams.get('lat');
    let lon = searchParams.get('lon');
    const lang = (searchParams.get('lang') || 'en').toLowerCase();

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
      lat: resolvedLat,
      lon: resolvedLon,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('Weather API Error:', safeErrorText(error));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
