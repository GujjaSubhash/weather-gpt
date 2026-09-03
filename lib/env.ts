/**
 * Env_Validator — schema-driven environment validation (Requirement 8).
 *
 * Server-only module. Never import this from a client component: it reads
 * server credentials through `process.env` and must not be bundled for the
 * browser. Public variables are read from `lib/env.public.ts` instead.
 *
 * Value hygiene: no function in this file returns, logs, or embeds an
 * environment variable *value*. `EnvValidationError` has no field capable of
 * holding one, and every message is built from names and scopes only
 * (Requirement 8.5).
 */

export type EnvScope = 'server' | 'public';

export type EnvGuard = 'weather' | 'chat' | 'routing' | 'reports' | 'store';

export interface EnvVarSpec {
  name: string;
  scope: EnvScope;
  purpose: string;
  /**
   * `always`     — must be present in every mode.
   * `production` — must be present when NODE_ENV is production.
   * `optional`   — never required. Present and absent are both valid states,
   *                in every mode. Used for a credential that enables an extra
   *                capability but whose absence must leave the product working
   *                exactly as it does without it. An `optional` spec is still
   *                declared here so `scope: 'server'` misclassification is
   *                caught and so the bundle scanner picks the name up.
   */
  requiredIn: 'always' | 'production' | 'optional';
  /** Feature that degrades when absent, used to build the startup summary. */
  guards?: EnvGuard;
}

/**
 * Exactly the variables WeatherGPT reads today.
 *
 * `ORS_API_KEY` (routing) and `UPSTASH_REDIS_REST_URL` /
 * `UPSTASH_REDIS_REST_TOKEN` (store) are deliberately absent: the routing
 * proxy and the Shared_Store arrive in later phases, and declaring them now
 * would fail a deploy for infrastructure that no code yet uses. They are added
 * to this schema by the tasks that introduce them.
 */
export const ENV_SCHEMA: readonly EnvVarSpec[] = [
  { name: 'OPENWEATHER_API_KEY', scope: 'server', requiredIn: 'always', guards: 'weather', purpose: 'OWM weather + geocoding fallback' },
  { name: 'TOMORROW_API_KEY', scope: 'server', requiredIn: 'always', guards: 'weather', purpose: 'Primary realtime + nowcast provider' },
  // Optional second source. Absent is a supported configuration: the weather
  // route then serves exactly what it served before AccuWeather existed.
  { name: 'ACCUWEATHER_API_KEY', scope: 'server', requiredIn: 'optional', guards: 'weather', purpose: 'AccuWeather: measured rainfall accumulation, official alerts, cross-check' },
  { name: 'GEMINI_API_KEY', scope: 'server', requiredIn: 'always', guards: 'chat', purpose: 'Chat model' },
  { name: 'YOU_API_KEY', scope: 'server', requiredIn: 'always', guards: 'chat', purpose: 'Web search grounding for chat' },
  // Public: read client-side by the Leaflet map (lib/env.public.ts). Optional by
  // construction — the map renders without it (with CARTO's watermark), so its
  // absence must never fail startup, which is why it is not `always`.
  { name: 'NEXT_PUBLIC_CARTO_BASEMAP_KEY', scope: 'public', requiredIn: 'optional', purpose: 'CARTO basemap tiles for the live map' },
] as const;

const PUBLIC_PREFIX = 'NEXT_PUBLIC_';

/** A missing variable, identified by name and scope. Never carries a value. */
export interface MissingEnvVar {
  readonly name: string;
  readonly scope: EnvScope;
}

function buildMessage(missing: readonly MissingEnvVar[], misclassified: readonly string[]): string {
  const parts: string[] = [];
  if (misclassified.length) {
    parts.push(
      `Misclassified server-only variable(s) carrying the ${PUBLIC_PREFIX} prefix: ${misclassified.join(', ')}`
    );
  }
  if (missing.length) {
    parts.push(
      `Missing or empty environment variable(s): ${missing
        .map((m) => `${m.name} (${m.scope === 'server' ? 'server-only' : 'public'})`)
        .join(', ')}`
    );
  }
  return parts.length ? `Environment validation failed. ${parts.join('. ')}.` : 'Environment validation failed.';
}

/**
 * Carries only names and scopes. There is intentionally no field on this type
 * that could hold an environment variable value.
 */
export class EnvValidationError extends Error {
  readonly missing: readonly MissingEnvVar[];
  readonly misclassified: readonly string[];

  constructor(missing: readonly MissingEnvVar[], misclassified: readonly string[]) {
    super(buildMessage(missing, misclassified));
    this.name = 'EnvValidationError';
    // Copy through the narrow shape so nothing else can ride along.
    this.missing = missing.map((m) => ({ name: m.name, scope: m.scope }));
    this.misclassified = misclassified.map((n) => n);
  }
}

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * True when the spec must be present in the mode the process is running in.
 * `optional` is never required, so it can never contribute a missing entry to
 * `validateServerEnv()`, `assertRouteEnv()` or `summarizeEnv()` — which is what
 * keeps an absent optional credential from failing startup or a request.
 */
function isRequiredNow(spec: EnvVarSpec): boolean {
  if (spec.requiredIn === 'optional') return false;
  return spec.requiredIn === 'always' || isProduction();
}

/** Presence only — the value never leaves this function. */
function isPresent(name: string): boolean {
  const raw = process.env[name];
  return typeof raw === 'string' && raw.trim().length > 0;
}

function collectMisclassified(): string[] {
  return ENV_SCHEMA.filter((s) => s.scope === 'server' && s.name.startsWith(PUBLIC_PREFIX)).map((s) => s.name);
}

function collectMissing(specs: readonly EnvVarSpec[]): MissingEnvVar[] {
  return specs
    .filter((s) => isRequiredNow(s) && !isPresent(s.name))
    .map((s) => ({ name: s.name, scope: s.scope }));
}

/**
 * Requirement 8.2/8.3/8.4. Throws `EnvValidationError` when a variable
 * required in the current mode is absent or empty, or when a `scope: 'server'`
 * spec is declared with the `NEXT_PUBLIC_` prefix — the check that makes the
 * client-bundle leak class impossible to reintroduce silently.
 */
export function validateServerEnv(): void {
  const misclassified = collectMisclassified();
  const missing = collectMissing(ENV_SCHEMA);
  if (misclassified.length || missing.length) {
    throw new EnvValidationError(missing, misclassified);
  }
}

const routeGuardCache = new Map<EnvGuard, MissingEnvVar[]>();

function missingForGuard(guard: EnvGuard): MissingEnvVar[] {
  const cached = routeGuardCache.get(guard);
  if (cached) return cached;
  const missing = collectMissing(ENV_SCHEMA.filter((s) => s.guards === guard));
  routeGuardCache.set(guard, missing);
  return missing;
}

/**
 * Memoized per-guard check for route modules. A route calls this at the top of
 * its handler and maps the thrown `EnvValidationError` to a typed 503, so a
 * missing credential surfaces as a configuration response rather than an
 * exception raised part-way through request handling.
 */
export function assertRouteEnv(guards: string[]): void {
  const misclassified = collectMisclassified();
  const missing: MissingEnvVar[] = [];
  for (const guard of guards) {
    for (const m of missingForGuard(guard as EnvGuard)) {
      if (!missing.some((existing) => existing.name === m.name)) missing.push(m);
    }
  }
  if (misclassified.length || missing.length) {
    throw new EnvValidationError(missing, misclassified);
  }
}

/** Test/dev seam: drop the memoized guard results after mutating the env. */
export function resetRouteEnvCache(): void {
  routeGuardCache.clear();
}

/**
 * Value-free status line for startup logging, e.g. `weather=ok chat=ok reports=ok`.
 * A guard is `ok` when every variable it guards that is required in the current
 * mode is present, `partial` when some are, `absent` when none are.
 *
 * `requiredIn: 'optional'` specs are filtered out by `isRequiredNow`, so an
 * absent optional credential neither throws here nor downgrades its guard to
 * `partial`: `weather` stays `ok` with or without ACCUWEATHER_API_KEY.
 */
export function summarizeEnv(): string {
  const order: EnvGuard[] = [];
  for (const spec of ENV_SCHEMA) {
    if (spec.guards && !order.includes(spec.guards)) order.push(spec.guards);
  }

  return order
    .map((guard) => {
      const specs = ENV_SCHEMA.filter((s) => s.guards === guard && isRequiredNow(s));
      if (specs.length === 0) return `${guard}=n/a`;
      const present = specs.filter((s) => isPresent(s.name)).length;
      const status = present === specs.length ? 'ok' : present === 0 ? 'absent' : 'partial';
      return `${guard}=${status}`;
    })
    .join(' ');
}
