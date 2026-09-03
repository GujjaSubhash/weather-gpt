/**
 * Public environment variables, safe to reach the browser.
 *
 * Next.js inlines `NEXT_PUBLIC_*` only for *literal* member access, so a
 * schema-driven `process.env[name]` lookup resolves to `undefined` in the
 * client bundle. Every public variable therefore gets one explicit literal
 * read here, and this frozen object is the single client-side source.
 *
 * Keep this file in exact agreement with the `scope: 'public'` entries of
 * `ENV_SCHEMA` in `lib/env.ts`.
 */

export const PUBLIC_ENV = Object.freeze({
  // CARTO basemap key for the Leaflet map. Optional: without it the map still
  // renders, only with CARTO's watermarked tiles.
  NEXT_PUBLIC_CARTO_BASEMAP_KEY: process.env.NEXT_PUBLIC_CARTO_BASEMAP_KEY,
});

export type PublicEnv = typeof PUBLIC_ENV;

/** Names covered by this module, used by the schema-agreement test. */
export const PUBLIC_ENV_NAMES = Object.freeze(Object.keys(PUBLIC_ENV));
