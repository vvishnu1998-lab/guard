'use client';

import { useEffect } from 'react';
import { appStoreHref, detectPlatform, normalizeSrc, playHref } from '../../lib/storeLinks';

// Progressive enhancement for /app. The page is complete without this: the
// HTML already carries both badges with a fixed page-level tag. After load
// this does exactly two things and nothing else:
//
//   1. re-tags the two store hrefs from ?src= (collapsed through the closed
//      registry, so an unknown value becomes 'other' and is never echoed);
//   2. marks the container with the visitor's platform so CSS can hide the
//      OTHER store's badge on a confident phone.
//
// There is deliberately NO navigation here: no redirect, no auto-open, no
// timer. A visitor always taps the badge themselves (owner decision
// 2026-10-13: static page only; a redirect is a later, separate decision).
export default function AppLinksEnhancer() {
  useEffect(() => {
    const root = document.getElementById('store-links');
    if (!root) return;

    const tag = normalizeSrc(new URLSearchParams(window.location.search).get('src'));
    root.querySelectorAll<HTMLAnchorElement>('a[data-store]').forEach((a) => {
      a.href = a.dataset.store === 'apple' ? appStoreHref(tag) : playHref(tag);
    });

    root.dataset.platform = detectPlatform(navigator.userAgent);
  }, []);

  return null;
}
