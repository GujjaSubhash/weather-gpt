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
  NEXT_PUBLIC_FIREBASE_API_KEY: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  NEXT_PUBLIC_FIREBASE_APP_ID: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
});

export type PublicEnv = typeof PUBLIC_ENV;

/** Names covered by this module, used by the schema-agreement test. */
export const PUBLIC_ENV_NAMES = Object.freeze(Object.keys(PUBLIC_ENV));
