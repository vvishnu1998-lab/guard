/**
 * Node runtime Sentry init. Loaded by instrumentation.ts's register() hook.
 */
import * as Sentry from '@sentry/nextjs';
import { sharedOptions } from './sentry.shared';

Sentry.init(sharedOptions);
