/**
 * A short name for the device behind a request's User-Agent, for an account's
 * own sign-in history (Phase D). The browser and the platform only: never the
 * raw string, and never an address (Vishnu's decision 6a: no IP column).
 *
 * Covers what auth_events actually records: the admin web on macOS, iPhone and
 * Windows; the guard app, which sends `NetraOps/<build> CFNetwork/… Darwin/…`
 * on iOS and `okhttp/<version>` on Android; and curl.
 */
export function deviceLabel(ua: string | null | undefined): string {
  if (!ua) return 'Unknown device';
  if (/^NetraOps\/\S+ CFNetwork\//.test(ua)) return 'NetraOps app on iPhone';
  if (/^okhttp\//i.test(ua)) return 'NetraOps app on Android';
  if (/^curl\//i.test(ua)) return 'curl';

  // iPhone and iPad user agents also say "like Mac OS X", so they come first.
  const os = /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) ? 'iPad'
      : /Android/.test(ua) ? 'Android'
        : /CrOS/.test(ua) ? 'ChromeOS'
          : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
            : /Windows/.test(ua) ? 'Windows'
              : /Linux/.test(ua) ? 'Linux'
                : null;
  // Edge and Opera also say "Chrome", and every iOS browser says "Safari", so the specific ones come first.
  const browser = /\bEdg(e|A|iOS)?\//.test(ua) ? 'Edge'
    : /\bOPR\/|\bOPT\//.test(ua) ? 'Opera'
      : /\bSamsungBrowser\//.test(ua) ? 'Samsung Internet'
        : /\b(Chrome|CriOS)\//.test(ua) ? 'Chrome'
          : /\b(Firefox|FxiOS)\//.test(ua) ? 'Firefox'
            : /\bVersion\/[\d.]+.*\bSafari\//.test(ua) ? 'Safari'
              : null;

  if (browser && os) return `${browser} on ${os}`;
  if (browser) return browser;
  if (os) return `A browser on ${os}`;
  return 'Unknown device';
}

/** The device's name inside a sentence: "from Chrome on macOS", "from the NetraOps app on iPhone", "from an unknown device". */
export function deviceInSentence(label: string): string {
  if (label.startsWith('NetraOps app')) return `the ${label}`;
  if (label === 'Unknown device') return 'an unknown device';
  if (label.startsWith('A browser')) return `a${label.slice(1)}`;
  return label;
}
