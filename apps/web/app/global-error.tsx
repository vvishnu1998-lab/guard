'use client';

/**
 * Last-resort App Router error boundary.
 *
 * Without this file, React render errors in the App Router never reach
 * Sentry — the SDK emits a build-time warning saying exactly that. It only
 * renders when an error escapes every nested boundary, replacing the whole
 * document, so the markup is deliberately self-contained: no shared layout,
 * no portal chrome, no imports beyond Sentry itself.
 *
 * Deliberately does NOT use next/error. This monorepo already carries a
 * workaround for a React duplicate-instance crash when statically generating
 * error pages (see experimental.missingSuspenseWithCSRBailout in
 * next.config.js), and pulling in the Pages Router error component here would
 * re-enter that path for no benefit.
 */
import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily:
            'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
          background: '#0b0b0c',
          color: '#e8e8ea',
        }}
      >
        <main style={{ maxWidth: '32rem', padding: '2rem', textAlign: 'center' }}>
          <h1 style={{ fontSize: '1.25rem', fontWeight: 600, margin: '0 0 0.75rem' }}>
            Something went wrong
          </h1>
          <p style={{ margin: '0 0 1.5rem', lineHeight: 1.6, color: '#a1a1aa' }}>
            The error has been reported. Try again, and if it keeps happening,
            contact support.
          </p>
          <button
            type="button"
            onClick={() => reset()}
            style={{
              padding: '0.6rem 1.25rem',
              borderRadius: '0.5rem',
              border: '1px solid #3f3f46',
              background: '#18181b',
              color: '#e8e8ea',
              fontSize: '0.9rem',
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
