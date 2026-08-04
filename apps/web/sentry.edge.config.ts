/**
 * Edge runtime Sentry init. Loaded by instrumentation.ts's register() hook.
 *
 * middleware.ts runs here — it verifies the portal JWTs — so this is the
 * runtime that reports auth-path failures.
 */
import * as Sentry from '@sentry/nextjs';
import { sharedOptions } from './sentry.shared';

Sentry.init(sharedOptions);
