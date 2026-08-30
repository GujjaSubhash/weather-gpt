/**
 * Next.js only loads `instrumentation.ts` from the project root (or `src/`),
 * not from inside `app/`. The implementation lives at `app/instrumentation.ts`
 * per the design's module layout; this file is the root entry point that makes
 * the framework actually call it.
 */
export { register } from './app/instrumentation';
