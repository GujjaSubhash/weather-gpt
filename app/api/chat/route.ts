import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenerativeAI, type Content } from '@google/generative-ai';

/**
 * The RAIN RULES block is not stylistic. A user asked whether it would rain,
 * was told no, and it rained shortly after — because the model was reading a
 * 90-minute nowcast of zeros as an answer about the whole day. The rules below
 * make the horizon binding and hand the model a precomputed verdict it is not
 * allowed to overrule, so the same failure cannot recur through phrasing.
 */
const systemInstruction = `You are WeatherGPT — a friendly, knowledgeable weather companion for people in Hyderabad, India. You speak like a helpful friend who happens to be a weather expert, not like a robot or a formal assistant. Be warm, natural, and conversational. Use simple language. Give practical advice people can actually act on. You have access to live weather data including temperature, rainfall, humidity, wind, flood risk, a 90-minute nowcast, an hourly rain outlook, and official weather alerts. Use this data naturally in conversation — do not just dump numbers, explain what they mean for the person's day.

RAIN RULES — these override your own judgement and your instinct to sound reassuring:
1. The weather context contains a line beginning "RAIN OUTLOOK". It states the horizon in hours and ends with a VERDICT. Follow that verdict exactly. Never contradict it, soften it, or talk the user out of it.
2. Rainfall in mm/hr is what is falling RIGHT NOW. It is not a forecast. 0mm/hr means it is not raining this minute — it never means it will not rain later. Never answer "will it rain?" from the mm/hr figure.
3. Never say it will not rain over a period longer than the stated horizon. If someone asks about "today", "this evening", "tonight" or "tomorrow" and the horizon is shorter than that, answer for the hours you can see and say plainly that you cannot see further. For example: "No rain in the next 12 hours — but I can't see past that."
4. When rain is likely or possible, say when, using the hourly rain chances.
5. If asked whether to carry an umbrella and rain is possible at any point in the horizon, say yes and give the timing. Err toward the umbrella — being wrong about rain that does not arrive costs someone nothing; being wrong the other way soaks them.
6. You have NO data on roads, traffic, waterlogging, drainage, or how long any journey takes. Never describe road or traffic conditions, not even in passing and not even as an aside like "watch out for wet roads" — the app measures none of it. Talk about rain, wind, temperature and personal precautions only.

You cover: current weather, temperature and how it feels, rainfall and flood risk, weather alerts, travel safety, what to wear, whether to carry an umbrella, short-term forecasts, and general climate questions about Hyderabad. When you do not have data say so honestly — never make things up. Reply in whatever language the user writes in — English, Hindi, or Telugu. Keep replies concise and human. No bullet points unless they genuinely help. No corporate speak. No As an AI language model. Just talk to them like a knowledgeable friend.`;

/** Longest question accepted. Beyond this the request is rejected, not truncated. */
const MESSAGE_MAX = 2000;
/** Conversation turns forwarded to the model, newest last. */
const HISTORY_MAX = 10;
/** Ceiling on the model call before the client gets a 504 instead of hanging.
 *  Kept under Vercel's 30s function limit while leaving headroom for a slow model. */
const MODEL_TIMEOUT_MS = 28_000;
/** Ceiling on the (optional) grounding search. */
const SEARCH_TIMEOUT_MS = 6_000;

type YouWebResult = {
  url?: string;
  title?: string;
  description?: string;
  snippets?: string[];
};

// ── Log hygiene ──
// The upstream SDK/fetch can quote a URL or header bag in its error text. Nothing
// derived from an exception reaches a log line or a response body without passing
// through here first, so a credential can never ride along.
const SECRET_QUERY_PARAM = /([?&](?:apikey|appid|api_key|key|token|access_token)=)[^&\s"'\\)]+/gi;

function redactSecrets(text: string): string {
  return text.replace(SECRET_QUERY_PARAM, '$1[redacted]');
}

/** Name + message only — no stack, no request object, no headers. */
function safeErrorText(err: unknown): string {
  if (err instanceof Error) return redactSecrets(`${err.name}: ${err.message}`);
  return redactSecrets(String(err));
}

/** Error envelope shared with /api/weather: a machine code plus safe prose. */
function errorResponse(
  status: number,
  code: string,
  message: string,
  field?: string
) {
  return NextResponse.json(
    { error: { code, message, ...(field ? { field } : {}) } },
    { status }
  );
}

// you.com Search API — current endpoint is POST/GET https://ydc-index.io/v1/search
// (the old https://api.ydc-index.io/search now returns 403). Response shape is
// { results: { web: [{ url, title, description, snippets }] } }.
//
// Grounding is strictly best-effort: a missing key, a non-ok response, a timeout
// or a parse failure all degrade to an ungrounded answer. None of them is an
// error status for this route, because the model can still answer usefully from
// the weather data alone. The caller learns which happened from `grounded`.
async function searchYouCom(query: string): Promise<string> {
  const apiKey = process.env.YOU_API_KEY;
  if (!apiKey) return '';

  // Don't let a slow search stall the whole chat response.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);

  try {
    const res = await fetch(
      `https://ydc-index.io/v1/search?query=${encodeURIComponent(query)}`,
      {
        headers: {
          'X-API-Key': apiKey,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      }
    );

    if (!res.ok) return '';

    const data = await res.json();
    const web: YouWebResult[] = data?.results?.web ?? [];

    return web
      .slice(0, 5)
      .map((hit) => {
        const title = hit.title || '';
        const detail = hit.description || hit.snippets?.[0] || '';
        const source = hit.url ? ` (${hit.url})` : '';
        return title || detail ? `- ${title}: ${detail}${source}` : '';
      })
      .filter(Boolean)
      .join('\n');
  } catch (err) {
    console.warn('you.com search unavailable, answering ungrounded:', safeErrorText(err));
    return '';
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * When to spend a web search. Only news / alerts / road-condition /
 * current-event questions get grounded against you.com; ordinary "how's the
 * weather", "will it rain", "should I carry an umbrella" questions are answered
 * from the live weather data alone. Triggers cover English, Hindi and Telugu,
 * and deliberately exclude bare "today" / "now" so a routine forecast question
 * does not burn a search call.
 */
const SEARCH_TRIGGERS = [
  // news / current events
  'news', 'latest', 'update', 'happening', 'current situation',
  // alerts / warnings
  'alert', 'warning', 'advisory',
  // roads / travel disruption
  'road', 'traffic', 'route', 'closure', 'closed', 'blocked', 'diversion',
  // flooding as an unfolding event
  'flood', 'waterlog', 'inundat',
  // Hindi
  'समाचार', 'खबर', 'चेतावनी', 'अलर्ट', 'सड़क', 'रास्ता', 'ट्रैफिक', 'यातायात', 'बाढ़', 'जलभराव',
  // Telugu
  'వార్త', 'వార్తలు', 'హెచ్చరిక', 'రోడ్డు', 'రహదారి', 'ట్రాఫిక్', 'వరద', 'వరదలు',
];

function needsWebSearch(message: string): boolean {
  const m = message.toLowerCase();
  return SEARCH_TRIGGERS.some((kw) => m.includes(kw));
}

/** The full weather context the client sends, typed loosely. */
type WeatherContext = {
  area?: string;
  temperature?: number;
  feelsLike?: number;
  condition?: string;
  rain?: number;
  wind?: number;
  humidity?: number;
  rainChance?: number;
  risk?: string;
  forecast?: { label?: string; value?: number }[];
  /** Rain expectation past the 90-minute nowcast, from /api/weather. */
  outlook?: {
    horizonHours?: number;
    peakChance?: number;
    peakIntensity?: number;
    rainStartsInHours?: number | null;
    hours?: { inHours?: number; chance?: number; mm?: number }[];
  } | null;
  updatedAt?: string;
  source?: string;
  alerts?: { source?: string; description?: string; severity?: string }[];
};

/**
 * Turn the outlook into an unambiguous verdict sentence.
 *
 * Written out server-side on purpose. Handing the model `rainfall 0mm/hr` next
 * to `rain chance 70%` and leaving it to weigh them produced exactly the wrong
 * answer in practice: four fields reading zero outvoted the one field that
 * actually answers "will it rain", and a user was told no shortly before it
 * rained. The verdict is computed here so there is nothing to misweigh, and the
 * horizon is always named so a "no" can never be read as covering the day.
 */
function buildRainVerdict(weather: WeatherContext): string {
  const outlook = weather.outlook;
  const horizon = typeof outlook?.horizonHours === 'number' ? outlook.horizonHours : 0;

  if (!outlook || horizon <= 0) {
    // No outlook: the 90-minute nowcast is genuinely all there is. Say so
    // rather than letting a short window stand in for the day.
    const chance = typeof weather.rainChance === 'number' ? weather.rainChance : null;
    return chance === null
      ? 'RAIN OUTLOOK: unavailable. You do not know whether it will rain. Say so.'
      : `RAIN OUTLOOK: ${chance}% chance within the next 90 MINUTES ONLY. ` +
          'You have no data beyond 90 minutes — do not answer for "today", "this evening" or "later".';
  }

  const peak = typeof outlook.peakChance === 'number' ? outlook.peakChance : 0;
  const startsIn = outlook.rainStartsInHours;
  const intensity = typeof outlook.peakIntensity === 'number' ? outlook.peakIntensity : 0;

  const head = `RAIN OUTLOOK (next ${horizon} hours): peak chance ${peak}%`;
  const detail =
    typeof startsIn === 'number'
      ? `, rain becoming likely in about ${startsIn} hour${startsIn === 1 ? '' : 's'}` +
        (intensity > 0 ? `, peaking near ${intensity}mm/hr` : '')
      : ', no hour in that window reaches a likely-rain threshold';

  const ruling =
    peak >= 60
      ? ' VERDICT: rain is LIKELY — say yes, and give the timing.'
      : peak >= 30
        ? ' VERDICT: rain is POSSIBLE — say it could rain and give the timing. Do NOT say no.'
        : ' VERDICT: rain is unlikely in this window. You may say that, but only for ' +
          `the next ${horizon} hours — never for longer.`;

  return head + detail + '.' + ruling;
}

/**
 * Formats live weather into one natural-language line for the model. When the
 * client had nothing to send (null / empty reading), returns the honest
 * "unavailable" line rather than a fake 0mm/safe default the model would then
 * present as real — the system prompt tells it to say so plainly.
 */
function buildWeatherContext(weather: WeatherContext | null | undefined): string {
  if (!weather || typeof weather !== 'object') return 'Weather data currently unavailable.';

  const hasReading =
    typeof weather.temperature === 'number' ||
    (typeof weather.condition === 'string' && weather.condition.trim().length > 0);
  if (!hasReading) return 'Weather data currently unavailable.';

  const n = (v: number | undefined): string => (typeof v === 'number' ? String(v) : '—');

  const forecast =
    Array.isArray(weather.forecast) && weather.forecast.length
      ? weather.forecast
          .map((f) => `${f.label ?? ''} ${typeof f.value === 'number' ? f.value : 0}mm`.trim())
          .join(', ')
      : 'not available';

  const alerts =
    Array.isArray(weather.alerts) && weather.alerts.length
      ? weather.alerts.map((a) => a.description || a.source || 'unspecified alert').join(' | ')
      : 'none active';

  // Hour-by-hour, so the assistant can answer "when?" and not just "whether".
  const hourly =
    Array.isArray(weather.outlook?.hours) && weather.outlook.hours.length
      ? weather.outlook.hours
          .map((h) => `+${h.inHours ?? 0}h ${h.chance ?? 0}%`)
          .join(', ')
      : 'not available';

  return (
    `Current conditions in ${weather.area || 'Hyderabad'}: ${n(weather.temperature)}°C ` +
    `feels like ${n(weather.feelsLike)}°C, ${weather.condition || 'conditions unavailable'}, ` +
    `rainfall ${n(weather.rain)}mm/hr, wind ${n(weather.wind)}km/h, humidity ${n(weather.humidity)}%, ` +
    `flood risk: ${weather.risk || 'unknown'}. ` +
    // The nowcast is explicitly labelled as a 90-minute window rather than left
    // to look like a general forecast.
    `Next 90 minutes (nowcast): ${forecast}, ${n(weather.rainChance)}% chance. ` +
    `${buildRainVerdict(weather)} ` +
    `Hourly rain chance: ${hourly}. ` +
    `Alerts: ${alerts}. ` +
    `Data from ${weather.source || 'unknown source'} at ${weather.updatedAt || 'unknown time'}.`
  );
}

/**
 * Normalizes the client's transcript into Gemini `Content[]`.
 *
 * The UI stores turns as `{ role: 'user' | 'bot', text }`, so 'bot' (and any
 * other non-user label) maps to Gemini's 'model'. Two structural rules are
 * enforced because the SDK rejects violations at send time:
 *   1. history must start with a user turn — leading model turns (the seeded
 *      greeting bubble) are dropped;
 *   2. empty turns carry no signal and are dropped.
 * Only the newest HISTORY_MAX turns survive, so a long session cannot grow the
 * prompt without bound.
 */
function normalizeHistory(raw: unknown): Content[] {
  if (!Array.isArray(raw)) return [];

  const turns: Content[] = [];
  for (const entry of raw.slice(-HISTORY_MAX)) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as { role?: unknown; text?: unknown; content?: unknown };
    const text =
      typeof candidate.text === 'string'
        ? candidate.text
        : typeof candidate.content === 'string'
          ? candidate.content
          : '';
    if (!text.trim()) continue;
    const role = candidate.role === 'user' ? 'user' : 'model';
    turns.push({ role, parts: [{ text }] });
  }

  while (turns.length && turns[0].role !== 'user') turns.shift();
  return turns;
}

export async function POST(req: NextRequest) {
  // ── Request validation (400) ──
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, 'VALIDATION_FAILED', 'Request body must be JSON.', 'body');
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return errorResponse(400, 'VALIDATION_FAILED', 'Request body must be a JSON object.', 'body');
  }

  const { message, weather, language, history } = body as {
    message?: unknown;
    weather?: WeatherContext | null;
    language?: unknown;
    history?: unknown;
  };

  if (typeof message !== 'string' || message.trim().length === 0) {
    return errorResponse(400, 'VALIDATION_FAILED', 'A non-empty "message" is required.', 'message');
  }
  if (message.length > MESSAGE_MAX) {
    return errorResponse(
      400,
      'VALIDATION_FAILED',
      `"message" must be ${MESSAGE_MAX} characters or fewer.`,
      'message'
    );
  }

  const userMessage = message.trim();

  // ── Configuration (503) ──
  // Distinct from an upstream failure: nothing is wrong with the model, the
  // deployment simply has no credential, and no retry will change that.
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return errorResponse(503, 'UNCONFIGURED', 'Chat service is not configured.');
  }

  // Web search is now gated: we only spend a you.com call when the question is
  // actually about news, alerts, road conditions, or current events. A plain
  // "how's the weather / should I carry an umbrella" is answered from the live
  // data alone. The query is the user's real question (plus the area for geo
  // relevance), not a hardcoded flood template.
  const wantsSearch = needsWebSearch(userMessage);
  const searchQuery = `${userMessage} ${weather?.area || 'Hyderabad'}`;
  const webResults = wantsSearch ? await searchYouCom(searchQuery) : '';
  const grounded = webResults.length > 0;

  // Full live-weather context, formatted for natural use — or the honest
  // "unavailable" line when the client had no reading to send.
  const weatherContext = buildWeatherContext(weather);

  const prompt = `${weatherContext}${
    webResults ? `\n\nRecent web context (you.com):\n${webResults}` : ''
  }\n\nUser question (${typeof language === 'string' && language ? language : 'English'}): ${userMessage}`;

  // ── Model call (200 / 502 / 504) ──
  // `timedOut` is the only way to tell our own deadline apart from an upstream
  // abort, and it decides 504 vs 502.
  const controller = new AbortController();
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, MODEL_TIMEOUT_MS);

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      // gemini-3.5-flash: stable and consistently ~3s. The -lite variant it
      // replaced was intermittently taking 20-40s and blowing MODEL_TIMEOUT_MS,
      // which surfaced to users as "the assistant took too long".
      model: 'gemini-3.5-flash',
      systemInstruction: systemInstruction,
    });

    // Prior turns are replayed as chat history so follow-ups ("and tomorrow?",
    // "what about Kukatpally?") resolve against what was already said.
    const chat = model.startChat({ history: normalizeHistory(history) });
    const result = await chat.sendMessage(prompt, {
      signal: controller.signal,
      timeout: MODEL_TIMEOUT_MS,
    });
    const text = result.response.text();

    if (!text || !text.trim()) {
      return errorResponse(502, 'UPSTREAM_FAILED', 'The assistant returned an empty answer.');
    }

    return NextResponse.json({ reply: text, grounded }, { status: 200 });
  } catch (error) {
    console.error('Chat API Error:', safeErrorText(error));
    if (timedOut) {
      return errorResponse(504, 'UPSTREAM_TIMEOUT', 'The assistant took too long to respond.');
    }
    return errorResponse(502, 'UPSTREAM_FAILED', 'The assistant is unavailable right now.');
  } finally {
    clearTimeout(deadline);
  }
}
