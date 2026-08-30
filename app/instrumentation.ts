/**
 * Startup environment validation (Requirement 8.2).
 *
 * `register()` is invoked once per server process, before any request is
 * handled, via the root `instrumentation.ts` re-export that Next.js loads.
 * A misconfigured deployment therefore fails at cold start with the offending
 * variable *names* in the log — never their values.
 */
import { EnvValidationError, summarizeEnv, validateServerEnv } from '@/lib/env';

export function register(): void {
  try {
    validateServerEnv();
  } catch (err) {
    if (err instanceof EnvValidationError) {
      // Message is built from names and scopes only.
      console.error(`[env] ${err.message}`);
    }
    throw err;
  }

  console.log(`[env] ${summarizeEnv()}`);
}
