/**
 * AccuWeather provider — the ONLY module in this codebase that knows
 * AccuWeather's wire format. Everything above it consumes the normalized
 * interfaces exported here, so a field rename upstream is a one-file change.
 *
 * Server-only. Never import this from a client component: it reads
 * `ACCUWEATHER_API_KEY` from `process.env`.
 *
 * ── OPTIONAL BY CONSTRUCTION ──
 * AccuWeather is a *second* source, never the primary one. With no key
 * configured every export returns `null` and nothing throws, so the product
 * behaves exactly as it did before this file existed. Callers must treat `null`
 * as "no second opinion available", not as an error.
 *
 * ── QUOTA IS THE BINDING CONSTRAINT ──
 * The tier in use allows roughly 250 calls per DAY for the whole key — about
 * ten an hour, shared across every user and every request. That is why:
 *   - a self-imposed daily ceiling (`ACCUWEATHER_DAILY_BUDGET`, default 180)
 *     sits under the real limit, and once spent we stop calling out entirely
 *     rather than collecting 429s;
 *   - the upstream `RateLimit-Remaining` header is read on every response and,
 *     below a floor of 25, we stop for the rest of the day;
 *   - location keys are cached for 30 days (a coordinate's key never moves, and
 *     re-looking it up would otherwise be the single largest quota consumer);
 *   - each optional sub-call is individually skippable via `opts`;
 *   - the caller (app/api/weather/route.ts) keeps the whole bundle in its
 *     4-minute response cache, so a cached read spends nothing.
 *
 * ── DELIBERATELY NOT IMPLEMENTED ──
 * `/currentconditions/v1/{key}/historical/24` is NOT used. `PrecipitationSummary`
 * on the current-conditions response already carries measured accumulation for
 * PastHour / Past3Hours / Past6Hours / Past12Hours / Past24Hours in a single
 * call; walking 24 hourly observations would cost far more quota for data we
 * already have. Do not add it without a concrete need the summary cannot meet.
 *
 * `/locations/v1/cities/search` (search by name) is also unused: the weather
 * route has already resolved coordinates through OpenWeatherMap geocoding by
 * the time it gets here, so a name lookup would just burn a second call.
 *
 * `/maps/v1/radar/**` and `/maps/v1/satellite/**` return 403 on this key — they
 * belong to the paid AccuWeather Maps product. There are no AccuWeather map
 * tiles available to this app; RainViewer remains the radar source.
 * `/indices/v1/**`, `/airquality/v2/**` and `/tropical/v1/**` return 404.
 *
 * ── LOG HYGIENE (this one bites) ──
 * AccuWeather error bodies ECHO the api key back inside a `Reference` field.
 * So: response bodies are never logged, never even read on a non-ok response,
 * and anything that does get logged passes through `redactSecrets()` — which
 * strips `apikey=`-style query params *and* any literal occurrence of the key
 * value. Same discipline as `redactSecrets()` in app/api/weather/route.ts.
 */

const HOST = 'https://dataservice.accuweather.com';

/** Headroom under the real ~250/day ceiling. Overridable for a paid tier. */
const DEFAULT_DAILY_BUDGET = 180;

/** Stop for the day when the provider says this few calls are left. */
const REMAINING_FLOOR = 25;

/** Per-sub-request ceiling, kept under the caller's ~4.5s overall abort. */
const SUB_REQUEST_TIMEOUT_MS = 4000;

/** A coordinate's location key is stable, so this can be very long. */
const LOCATION_KEY_TTL = 30 * 24 * 60 * 60 * 1000;

/** Bound on the location-key cache so a long-lived server cannot grow forever. */
const LOCATION_CACHE_MAX = 500;

// ── Public shape ───────────────────────────────────────────────────────────

/** Measured rainfall accumulation, millimetres. Not a forecast — observed. */
export interface AccuAccumulation {
  pastHour: number | null;
  past3h: number | null;
  past6h: number | null;
  past12h: number | null;
  past24h: number | null;
}

/** An official government warning as relayed by AccuWeather. */
export interface AccuAlert {
  source: string;
  description: string;
  severity: string | null;
  category: string | null;
  startsAt: string | null;
  endsAt: string | null;
  link: string | null;
}

export interface AccuObservation {
  source: 'AccuWeather';
  observedAt: string | null;
  temperature: number | null;
  humidity: number | null;
  pressure: number | null;
  visibilityKm: number | null;
  cloudCover: number | null;
  windKph: number | null;
  uvIndex: number | null;
  weatherText: string | null;
  hasPrecipitation: boolean | null;
  precip1hMm: number | null;
  accumulation: AccuAccumulation;
}

export interface AccuForecast {
  rainNextHourMm: number | null;
  /** Sum of the first 3 hourly `.Rain.Value`, mm. */
  rainNext3hMm: number | null;
  /** Sum of all 12 hourly `.Rain.Value`, mm. */
  rainNext12hMm: number | null;
  /** Max `PrecipitationProbability` over the first 2 hours, percent. */
  precipProbabilityPct: number | null;
  hourly: { at: string; rainMm: number | null; probabilityPct: number | null }[];
}

export interface AccuBundle {
  observation: AccuObservation | null;
  forecast: AccuForecast | null;
  /**
   * MinuteCast phrase only. The numeric `Intervals` array is EMPTY on this
   * tier, so there are no per-minute numbers to be had here — never build a
   * calculation on MinuteCast. The phrase is human-readable text and is only
   * ever passed through as text.
   */
  minuteCastPhrase: string | null;
  /**
   * `severity` is AccuWeather's own scale. 0 means the provider did not state
   * one (their scale starts at 1), it does not mean "no severity".
   */
  headline: { text: string; severity: number; category: string } | null;
  alerts: AccuAlert[];
  /**
   * Beyond the alert list because `alerts: []` is ambiguous on its own: an
   * empty array from a successful call means "no warnings in force", which is
   * a very different statement from "we could not ask". Callers surface this
   * as `alertsAvailable`.
   */
  alertsAvailable: boolean;
}

export interface AccuWeatherBudgetState {
  callsToday: number;
  budget: number;
  /** Last `RateLimit-Remaining` seen from the provider, if it sent one. */
  remainingReported: number | null;
  exhausted: boolean;
}

export interface FetchAccuWeatherOptions {
  includeMinuteCast?: boolean;
  includeHeadline?: boolean;
  includeAlerts?: boolean;
  signal?: AbortSignal;
}

// ── Credential ─────────────────────────────────────────────────────────────

/**
 * Read at call time, not module load, so the process can run with and without
 * the key without a restart (and so tests can flip it).
 *
 * The name is ALL CAPS on purpose. It was `AccuWeather_API_KEY`, which works on
 * Windows because its env lookups are case-insensitive, but Linux hosts — every
 * production deploy target — are case-SENSITIVE, so the mixed-case name would
 * have read as `undefined` in production and silently disabled this provider.
 */
function apiKey(): string | null {
  const raw = process.env.ACCUWEATHER_API_KEY;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// ── Log hygiene ────────────────────────────────────────────────────────────

const SECRET_QUERY_PARAM = /([?&](?:apikey|appid|api_key|key|token|access_token)=)[^&\s"'\\)]+/gi;

/**
 * Strips credentials from anything about to be logged. Two passes, because
 * AccuWeather leaks the key two ways: in URLs it echoes back, and bare inside
 * the `Reference` field of an error body.
 */
function redactSecrets(text: string): string {
  let out = text.replace(SECRET_QUERY_PARAM, '$1[redacted]');
  const key = apiKey();
  // Length guard: splitting on a very short or empty needle is meaningless and
  // `split('')` would shred the string.
  if (key && key.length >= 6) out = out.split(key).join('[redacted]');
  return out;
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

// ── Quota ledger ───────────────────────────────────────────────────────────

interface BudgetLedger {
  utcDate: string;
  callsToday: number;
  remainingReported: number | null;
  /** Hard stop for the remainder of the UTC day. */
  hardStop: boolean;
  /** One warning per day, so a spent quota cannot flood the log. */
  warned: boolean;
}

function utcDateKey(): string {
  return new Date().toISOString().slice(0, 10);
}

let ledger: BudgetLedger = {
  utcDate: utcDateKey(),
  callsToday: 0,
  remainingReported: null,
  hardStop: false,
  warned: false,
};

/** Quota resets on the UTC day boundary, so the ledger does too. */
function rollLedger(): void {
  const today = utcDateKey();
  if (ledger.utcDate !== today) {
    ledger = {
      utcDate: today,
      callsToday: 0,
      remainingReported: null,
      hardStop: false,
      warned: false,
    };
  }
}

function dailyBudget(): number {
  const raw = Number(process.env.ACCUWEATHER_DAILY_BUDGET);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return DEFAULT_DAILY_BUDGET;
}

function isExhausted(): boolean {
  return ledger.hardStop || ledger.callsToday >= dailyBudget();
}

/** One value-free warning per day. Never includes a key, URL or body. */
function warnOnce(message: string): void {
  if (ledger.warned) return;
  ledger.warned = true;
  console.warn(`AccuWeather: ${message} No further AccuWeather calls today.`);
}

function stopForToday(message: string): void {
  ledger.hardStop = true;
  warnOnce(message);
}

/**
 * Claims one call from today's budget. Synchronous and called before any
 * `await`, which is what makes sub-call priority deterministic: the promises in
 * `fetchAccuWeatherBundle` are created in value order, so if the ceiling is hit
 * mid-batch it is the least valuable sub-calls that get dropped.
 */
function reserveCall(): boolean {
  rollLedger();
  if (isExhausted()) return false;
  ledger.callsToday += 1;
  return true;
}

/**
 * `RateLimit-Remaining` is the provider's own count of what is left on the key
 * today — more authoritative than our local counter, which cannot see calls
 * made by another process or deploy sharing the key.
 */
function noteRateLimit(res: Response): void {
  const raw = res.headers.get('RateLimit-Remaining');
  if (raw === null) return;
  const remaining = Number.parseInt(raw, 10);
  if (!Number.isFinite(remaining)) return;
  ledger.remainingReported = remaining;
  if (remaining < REMAINING_FLOOR) {
    stopForToday(`provider reports fewer than ${REMAINING_FLOOR} calls remaining on the key.`);
  }
}

/** Value-free quota accounting for operators. Safe to log or serve. */
export function getAccuWeatherBudgetState(): AccuWeatherBudgetState {
  rollLedger();
  return {
    callsToday: ledger.callsToday,
    budget: dailyBudget(),
    remainingReported: ledger.remainingReported,
    exhausted: isExhausted(),
  };
}

/** Test/dev seam. Not used in request handling. */
export function resetAccuWeatherBudget(): void {
  ledger = {
    utcDate: utcDateKey(),
    callsToday: 0,
    remainingReported: null,
    hardStop: false,
    warned: false,
  };
}

// ── Transport ──────────────────────────────────────────────────────────────

/**
 * Combines the caller's abort signal with a local timeout, without depending on
 * `AbortSignal.any`. Callers must invoke `done()` to clear the timer and drop
 * the listener.
 */
function withTimeout(external: AbortSignal | undefined, ms: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('AccuWeather sub-request timed out')), ms);
  const onAbort = () => controller.abort();

  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', onAbort, { once: true });
  }

  return {
    signal: controller.signal,
    done(): void {
      clearTimeout(timer);
      if (external) external.removeEventListener('abort', onAbort);
    },
  };
}

type EndpointLabel = 'location' | 'current' | 'hourly' | 'minutecast' | 'headline' | 'alerts';

/**
 * Single exit point to AccuWeather. Returns parsed JSON, or `null` for every
 * failure mode — no key, no budget, network error, non-2xx, unparseable body.
 * Never throws, never logs a URL or a response body.
 */
async function accuGet(
  label: EndpointLabel,
  path: string,
  params: Record<string, string>,
  signal?: AbortSignal
): Promise<unknown> {
  const key = apiKey();
  if (!key) return null;
  // Budget claim happens here, before the first await, on purpose. See reserveCall().
  if (!reserveCall()) return null;

  const url = new URL(path, HOST);
  // URLSearchParams encodes the value, so a key containing reserved characters
  // cannot break out of the query string.
  url.searchParams.set('apikey', key);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  // Belt and braces: this must never be plain http, credential in query string.
  if (url.protocol !== 'https:') return null;

  const timeout = withTimeout(signal, SUB_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: timeout.signal,
      cache: 'no-store',
    });

    noteRateLimit(res);

    if (!res.ok) {
      // The body is deliberately not read. AccuWeather 401/403 bodies contain a
      // `Reference` field with the api key inside it.
      if (res.status === 401 || res.status === 403) {
        stopForToday(`credential was rejected (HTTP ${res.status}).`);
      } else if (res.status === 429) {
        stopForToday('provider returned a rate-limit response (HTTP 429).');
      }
      console.warn(`AccuWeather ${label} unavailable: HTTP ${res.status}`);
      return null;
    }

    return await res.json();
  } catch (err) {
    console.warn(`AccuWeather ${label} request failed: ${safeErrorText(err)}`);
    return null;
  } finally {
    timeout.done();
  }
}

// ── Defensive parsing helpers ──────────────────────────────────────────────
// Every AccuWeather field is treated as optional. A missing path yields null,
// never a throw and never a substituted number.

type Loose = Record<string, unknown> | undefined;

function obj(value: unknown): Loose {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** `{ Metric: { Value: n } }` — the metric arm of a dual-unit AccuWeather node. */
function metricValue(node: unknown): number | null {
  return num(obj(obj(node)?.Metric)?.Value);
}

/** `{ Value: n }` — already metric because the request carried `metric=true`. */
function plainValue(node: unknown): number | null {
  return num(obj(node)?.Value);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Sums the non-null entries. Returns null when every entry is null, because
 * "no data" and "zero millimetres" are different claims and only one of them
 * is true.
 */
function sumMm(values: (number | null)[]): number | null {
  const present = values.filter((v): v is number => v !== null);
  if (!present.length) return null;
  return round2(present.reduce((total, v) => total + v, 0));
}

function maxOf(values: (number | null)[]): number | null {
  const present = values.filter((v): v is number => v !== null);
  return present.length ? Math.max(...present) : null;
}

function isoFromEpochSeconds(value: unknown): string | null {
  const seconds = num(value);
  if (seconds === null || seconds <= 0) return null;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function isoFromString(value: unknown): string | null {
  const text = str(value);
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

// ── Location key cache ─────────────────────────────────────────────────────

const locationKeyCache = new Map<string, { key: string; at: number }>();

function coordCacheKey(lat: number, lon: number): string {
  return `${lat.toFixed(3)},${lon.toFixed(3)}`;
}

function pruneLocationCache(): void {
  if (locationKeyCache.size < LOCATION_CACHE_MAX) return;
  const now = Date.now();
  for (const [key, entry] of locationKeyCache) {
    if (now - entry.at >= LOCATION_KEY_TTL) locationKeyCache.delete(key);
  }
  // Still full of live entries? Drop the oldest insertions (Map preserves order).
  while (locationKeyCache.size >= LOCATION_CACHE_MAX) {
    const oldest = locationKeyCache.keys().next();
    if (oldest.done) break;
    locationKeyCache.delete(oldest.value);
  }
}

/**
 * Coordinates → AccuWeather location key, cached for 30 days. Every other
 * endpoint needs this key, so an uncached lookup makes a 2-call bundle a 3-call
 * bundle. Rounding to 3 decimals (~110 m) is the same granularity the weather
 * route's response cache uses.
 */
async function resolveLocationKey(lat: number, lon: number, signal?: AbortSignal): Promise<string | null> {
  const cacheKey = coordCacheKey(lat, lon);
  const hit = locationKeyCache.get(cacheKey);
  if (hit && Date.now() - hit.at < LOCATION_KEY_TTL) return hit.key;

  const body = await accuGet(
    'location',
    '/locations/v1/cities/geoposition/search',
    { q: `${lat},${lon}` },
    signal
  );

  const key = str(obj(body)?.Key);
  if (!key) return null;

  pruneLocationCache();
  locationKeyCache.set(cacheKey, { key, at: Date.now() });
  return key;
}

// ── Response parsers ───────────────────────────────────────────────────────

function parseObservation(body: unknown): AccuObservation | null {
  const row = Array.isArray(body) ? obj(body[0]) : undefined;
  if (!row) return null;

  // Measured accumulation. This is the highest-value field set AccuWeather
  // gives us: Tomorrow.io reports an *intensity* (mm/hr right now), which
  // cannot tell you how much water has already fallen. The provider also sends
  // Precipitation / Past9Hours / Past18Hours; they are not surfaced because
  // nothing consumes them yet.
  const summary = obj(row.PrecipitationSummary);

  return {
    source: 'AccuWeather',
    observedAt: isoFromEpochSeconds(row.EpochTime) ?? isoFromString(row.LocalObservationDateTime),
    temperature: metricValue(row.Temperature),
    humidity: num(row.RelativeHumidity),
    pressure: metricValue(row.Pressure),
    visibilityKm: metricValue(row.Visibility),
    cloudCover: num(row.CloudCover),
    windKph: metricValue(obj(row.Wind)?.Speed),
    uvIndex: num(row.UVIndex),
    weatherText: str(row.WeatherText),
    hasPrecipitation: bool(row.HasPrecipitation),
    precip1hMm: metricValue(row.Precip1hr),
    accumulation: {
      pastHour: metricValue(summary?.PastHour),
      past3h: metricValue(summary?.Past3Hours),
      past6h: metricValue(summary?.Past6Hours),
      past12h: metricValue(summary?.Past12Hours),
      past24h: metricValue(summary?.Past24Hours),
    },
  };
}

function parseForecast(body: unknown): AccuForecast | null {
  if (!Array.isArray(body) || body.length === 0) return null;

  // A row with no usable timestamp is dropped rather than guessed at: it cannot
  // be placed in a time window, so it cannot contribute to a windowed sum.
  const hourly = body
    .map((raw) => {
      const row = obj(raw);
      if (!row) return null;
      const at = isoFromEpochSeconds(row.EpochDateTime) ?? isoFromString(row.DateTime);
      if (!at) return null;
      return {
        at,
        rainMm: plainValue(row.Rain),
        probabilityPct: num(row.PrecipitationProbability),
      };
    })
    .filter((entry): entry is { at: string; rainMm: number | null; probabilityPct: number | null } => entry !== null);

  if (!hourly.length) return null;

  return {
    rainNextHourMm: hourly[0].rainMm,
    rainNext3hMm: sumMm(hourly.slice(0, 3).map((h) => h.rainMm)),
    rainNext12hMm: sumMm(hourly.map((h) => h.rainMm)),
    precipProbabilityPct: maxOf(hourly.slice(0, 2).map((h) => h.probabilityPct)),
    hourly,
  };
}

/**
 * MinuteCast, phrase only. `Intervals` carries no numbers on this tier, so
 * there is nothing to compute from and we do not pretend otherwise.
 */
function parseMinuteCastPhrase(body: unknown): string | null {
  return str(obj(obj(body)?.Summary)?.Phrase);
}

function parseHeadline(body: unknown): { text: string; severity: number; category: string } | null {
  const headline = obj(obj(body)?.Headline);
  const text = str(headline?.Text);
  if (!text) return null;
  return {
    text,
    // 0 = the provider did not state a severity. AccuWeather's own scale starts
    // at 1, so 0 cannot be mistaken for a real value.
    severity: num(headline?.Severity) ?? 0,
    category: str(headline?.Category) ?? 'unspecified',
  };
}

/**
 * Official government warnings relayed by AccuWeather. The live array is empty
 * for the area under test, so every field is read through several candidate
 * paths and an entry with no readable description is dropped rather than
 * rendered as a blank warning.
 */
function parseAlerts(body: unknown): AccuAlert[] {
  if (!Array.isArray(body)) return [];

  const alerts: AccuAlert[] = [];
  for (const raw of body) {
    const row = obj(raw);
    if (!row) continue;

    const area = Array.isArray(row.Area) ? obj(row.Area[0]) : undefined;
    const description = obj(row.Description);

    const text =
      str(description?.Localized) ??
      str(description?.English) ??
      str(row.Description) ??
      str(area?.Text) ??
      str(area?.Summary);
    // No description means nothing a user could act on. Drop it.
    if (!text) continue;

    const priority = num(row.Priority);

    alerts.push({
      source: str(row.Source) ?? 'Issuing authority not stated',
      description: text,
      severity: str(row.Level) ?? str(row.Severity) ?? (priority !== null ? String(priority) : null),
      category: str(row.Category) ?? str(row.Type) ?? str(row.Class),
      startsAt: isoFromEpochSeconds(area?.EpochStartTime) ?? isoFromString(area?.StartTime),
      endsAt: isoFromEpochSeconds(area?.EpochEndTime) ?? isoFromString(area?.EndTime),
      link: str(row.Link) ?? str(row.MobileLink),
    });
  }
  return alerts;
}

// ── Entry point ────────────────────────────────────────────────────────────

/**
 * One bundle of AccuWeather data for a coordinate, or `null` when AccuWeather
 * has nothing to offer (no key, budget spent, coordinate unresolvable, or every
 * sub-call failed). Never throws.
 *
 * Cost, with the location key already cached:
 *   current + hourly                        = 2 calls  (always)
 *   + alerts        (default ON)            = 1 call
 *   + minutecast    (default ON)            = 1 call
 *   + daily headline (default OFF)          = 1 call
 * Add 1 for a cold location key. Alerts default on because an official flood
 * warning is the single most valuable thing this provider can tell a flood app;
 * the daily headline defaults off because it is editorial text about the next
 * five days, which this product does not use.
 */
export async function fetchAccuWeatherBundle(
  lat: number,
  lon: number,
  opts?: FetchAccuWeatherOptions
): Promise<AccuBundle | null> {
  if (!apiKey()) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  rollLedger();
  // Nothing left today: return without touching the network at all.
  if (isExhausted()) return null;

  const includeMinuteCast = opts?.includeMinuteCast ?? true;
  const includeAlerts = opts?.includeAlerts ?? true;
  const includeHeadline = opts?.includeHeadline ?? false;
  const signal = opts?.signal;

  const locationKey = await resolveLocationKey(lat, lon, signal);
  if (!locationKey) return null;
  const lk = encodeURIComponent(locationKey);

  // Created in descending value order so the budget claim inside accuGet (which
  // runs synchronously at creation) drops the least useful calls first.
  const currentP = accuGet('current', `/currentconditions/v1/${lk}`, { details: 'true' }, signal);
  const hourlyP = accuGet(
    'hourly',
    `/forecasts/v1/hourly/12hour/${lk}`,
    { details: 'true', metric: 'true' },
    signal
  );
  const alertsP = includeAlerts
    ? accuGet('alerts', `/alerts/v1/${lk}`, { details: 'true' }, signal)
    : Promise.resolve(null);
  const minuteP = includeMinuteCast
    ? accuGet('minutecast', '/forecasts/v1/minute', { q: `${lat},${lon}` }, signal)
    : Promise.resolve(null);
  const headlineP = includeHeadline
    ? accuGet('headline', `/forecasts/v1/daily/5day/${lk}`, { details: 'true', metric: 'true' }, signal)
    : Promise.resolve(null);

  // allSettled: one failing sub-call must never cost us the others.
  const settled = await Promise.allSettled([currentP, hourlyP, alertsP, minuteP, headlineP]);
  const [currentBody, hourlyBody, alertsBody, minuteBody, headlineBody] = settled.map((outcome) =>
    outcome.status === 'fulfilled' ? outcome.value : null
  );

  const observation = parseObservation(currentBody);
  const forecast = parseForecast(hourlyBody);
  const minuteCastPhrase = parseMinuteCastPhrase(minuteBody);
  const headline = parseHeadline(headlineBody);
  // Available means we asked and got an array back. An empty array then means
  // "no warnings in force", which is a real answer.
  const alertsAvailable = includeAlerts && Array.isArray(alertsBody);
  const alerts = alertsAvailable ? parseAlerts(alertsBody) : [];

  const gotSomething =
    observation !== null ||
    forecast !== null ||
    minuteCastPhrase !== null ||
    headline !== null ||
    alertsAvailable;
  if (!gotSomething) return null;

  return { observation, forecast, minuteCastPhrase, headline, alerts, alertsAvailable };
}
