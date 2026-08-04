/**
 * Browser-side Sentry init.
 *
 * File name: @sentry/nextjs 10.x resolves the client config from
 * `instrumentation-client.ts` (falling back to the older
 * `sentry.client.config.ts`). Next.js 14 has no native knowledge of
 * `instrumentation-client` — that landed in Next 15.3 — but it does not need
 * any: the SDK's own webpack plugin injects this module into the client
 * bundle, which is why the docs say the file can be used "for all Next.js
 * versions". Verified against the installed SDK's config/webpack.js.
 */
import * as Sentry from '@sentry/nextjs';
import { sharedOptions } from './sentry.shared';

Sentry.init(sharedOptions);

/**
 * Instruments client-side router navigations. Consumed by Next.js 15.3+;
 * inert on 14.x, kept so the upgrade needs no change here.
 */
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
