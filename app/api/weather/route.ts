import { NextResponse } from 'next/server';

const TRANSLATIONS = {
  en: {
    HIGH: {
      road: 'Avoid low-lying roads — waterlogging reported',
      action: 'Stay indoors until rainfall eases',
      wait: '45–60 min',
      route: 'Use ORR / elevated flyovers'
    },
    MODERATE: {
      road: 'Drive slowly — puddles on many roads',
      action: 'Prefer main roads, allow extra travel time',
      wait: '20–30 min',
      route: 'Stick to main roads and highways'
    },
    SAFE: {
      road: 'Roads are clear and moving normally',
      action: 'No special precautions needed',
      wait: 'No delay expected',
      route: 'All routes are open'
    },
    risk: {
      HIGH: 'high',
      MODERATE: 'moderate',
      SAFE: 'safe'
    }
  },
  hi: {
    HIGH: {
      road: 'निचले इलाकों की सड़कों से बचें — जलभराव',
      action: 'बारिश कम होने तक घर पर रहें',
      wait: '45–60 मिनट',
      route: 'ORR / ऊंचे फ्लाईओवर का उपयोग करें'
    },
    MODERATE: {
      road: 'धीमे चलें — कई सड़कों पर पानी',
      action: 'मुख्य सड़कों को प्राथमिकता दें',
      wait: '20–30 मिनट',
      route: 'मुख्य सड़कों पर रहें'
    },
    SAFE: {
      road: 'सड़कें सामान्य हैं',
      action: 'कोई विशेष सावधानी जरूरी नहीं',
      wait: 'कोई देरी नहीं',
      route: 'सभी मार्ग खुले हैं'
    },
    risk: {
      HIGH: 'high',
      MODERATE: 'moderate',
      SAFE: 'safe'
    }
  },
  te: {
    HIGH: {
      road: 'లోతట్టు ప్రాంత రోడ్లను ఎవాయిడ్ చేయండి — నీరు నిలిచింది',
      action: 'వర్షం తగ్గే వరకు ఇంట్లోనే ఉండండి',
      wait: '45–60 నిమిషాలు',
      route: 'ORR / ఎత్తైన ఫ్లైఓవర్లు వాడండి'
    },
    MODERATE: {
      road: 'నెమ్మదిగా డ్రైవ్ చేయండి — చాలా రోడ్లపై నీరు',
      action: 'ప్రధాన రోడ్లకు ప్రాధాన్యత ఇవ్వండి',
      wait: '20–30 నిమిషాలు',
      route: 'ప్రధాన రోడ్లపై ఉండండి'
    },
    SAFE: {
      road: 'రోడ్లు సాధారణంగా ఉన్నాయి',
      action: 'ప్రత్యేక జాగ్రత్తలు అవసరం లేదు',
      wait: 'ఆలస్యం లేదు',
      route: 'అన్ని మార్గాలు ఓపెన్'
    },
    risk: {
      HIGH: 'high',
      MODERATE: 'moderate',
      SAFE: 'safe'
    }
  }
};

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
};

// In-memory cache keyed by rounded coordinates. Tomorrow.io's free tier allows
// ~25 calls/hour, and the client auto-refreshes every 10 min, so a short TTL
// keeps repeated views (and multiple users near the same spot) well under limits.
const cache = new Map<string, { at: number; data: Normalized }>();
const CACHE_TTL = 4 * 60 * 1000;

function computeRisk(effectiveRain: number): 'HIGH' | 'MODERATE' | 'SAFE' {
  if (effectiveRain >= 7) return 'HIGH';
  if (effectiveRain >= 3) return 'MODERATE';
  return 'SAFE';
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
  };
}

// ── OpenWeatherMap: fallback if Tomorrow.io is unavailable / rate-limited ──
async function fetchOpenWeather(lat: string, lon: string): Promise<Normalized> {
  const apiKey = process.env.OPENWEATHER_API_KEY;
  if (!apiKey) throw new Error('OpenWeather key missing');

  const weatherUrl = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&units=metric&appid=${apiKey}`;
  const forecastUrl = `https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&units=metric&appid=${apiKey}`;
  const [weatherRes, forecastRes] = await Promise.all([fetch(weatherUrl), fetch(forecastUrl)]);
  if (!weatherRes.ok) throw new Error(`OpenWeather ${weatherRes.status}`);

  const weatherData = await weatherRes.json();
  const forecastData = forecastRes.ok ? await forecastRes.json() : { list: [] };

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
    console.warn('Tomorrow.io failed, falling back to OpenWeatherMap:', (err as Error).message);
    data = await fetchOpenWeather(lat, lon);
  }

  cache.set(cacheKey, { at: Date.now(), data });
  return data;
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
      return NextResponse.json({ error: 'OpenWeather API key is not configured' }, { status: 500 });
    }

    const queryText = q || (!lat && !lon ? 'Hyderabad, IN' : '');
    let areaName = queryText;

    if (queryText && (!lat || !lon)) {
      const geoUrl = `https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(queryText)}&limit=1&appid=${geoKey}`;
      const geoRes = await fetch(geoUrl);
      const geoData = await geoRes.json();
      if (!geoData || geoData.length === 0) {
        return NextResponse.json({ error: 'Location not found' }, { status: 404 });
      }
      lat = geoData[0].lat.toString();
      lon = geoData[0].lon.toString();
      areaName = geoData[0].state ? `${geoData[0].name}, ${geoData[0].state}` : geoData[0].name;
    } else if (lat && lon && !q) {
      const reverseGeoUrl = `https://api.openweathermap.org/geo/1.0/reverse?lat=${lat}&lon=${lon}&limit=1&appid=${geoKey}`;
      const reverseRes = await fetch(reverseGeoUrl);
      const reverseData = await reverseRes.json();
      areaName = reverseData && reverseData.length > 0
        ? (reverseData[0].state ? `${reverseData[0].name}, ${reverseData[0].state}` : reverseData[0].name)
        : 'Unknown Location';
    }

    if (!lat || !lon) {
      return NextResponse.json({ error: 'Could not resolve location' }, { status: 400 });
    }

    const w = await getWeather(lat, lon);

    // Localized road/action/wait/route copy, driven by the computed risk level.
    const tLang = ['hi', 'te'].includes(lang) ? lang : 'en';
    const t = TRANSLATIONS[tLang as keyof typeof TRANSLATIONS];
    const riskData = t[w.riskLevel];

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
      roadStatus: riskData.road,
      recommendedAction: riskData.action,
      estimatedWait: riskData.wait,
      safeRoute: riskData.route,
      updatedAt: new Date().toISOString(),
      forecast: w.forecast,
      source: w.source,
      lat: parseFloat(lat),
      lon: parseFloat(lon),
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('Weather API Error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
