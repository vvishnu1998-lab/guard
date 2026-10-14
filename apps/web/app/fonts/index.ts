/**
 * The web fonts, self-hosted (N198), so a build never has to reach Google Fonts.
 * On 2026-10-13 a preview build failed because next/font/google's loader crashed
 * while downloading them.
 *
 * Inter, Barlow Condensed and DM Sans are the files next/font/google served,
 * byte for byte (reference.json holds each file's sha256). They are cut into the
 * same subsets, with the same unicode-range on every face, the same weights and
 * font-display, and the same four latin files preloaded. next/font/local cannot
 * give one family a unicode-range per file, so each subset is its own call and
 * family, and each CSS variable lists them latin first. Google declared latin
 * last, and the last face declared wins a character two faces share. Each stack
 * ends with the font's metric-matched Arial fallback, defined in globals.css
 * with next/font/google's own overrides.
 *
 * Every option is a literal because next/font requires literals.
 * scripts/check-fonts.ts holds this file to reference.json and globals.css.
 * Licences: the OFL.txt beside each font.
 */
import localFont from 'next/font/local';

const interLatin = localFont({
  src: [
    { path: './inter/latin.woff2', weight: '400', style: 'normal' },
    { path: './inter/latin.woff2', weight: '500', style: 'normal' },
    { path: './inter/latin.woff2', weight: '600', style: 'normal' },
    { path: './inter/latin.woff2', weight: '700', style: 'normal' },
    { path: './inter/latin.woff2', weight: '800', style: 'normal' },
    { path: './inter/latin.woff2', weight: '900', style: 'normal' },
  ],
  display: 'swap',
  preload: true,
  adjustFontFallback: false,
  declarations: [{ prop: 'unicode-range', value: 'u+00??,u+0131,u+0152-0153,u+02bb-02bc,u+02c6,u+02da,u+02dc,u+0304,u+0308,u+0329,u+2000-206f,u+20ac,u+2122,u+2191,u+2193,u+2212,u+2215,u+feff,u+fffd' }],
});

const interLatinExt = localFont({
  src: [
    { path: './inter/latin-ext.woff2', weight: '400', style: 'normal' },
    { path: './inter/latin-ext.woff2', weight: '500', style: 'normal' },
    { path: './inter/latin-ext.woff2', weight: '600', style: 'normal' },
    { path: './inter/latin-ext.woff2', weight: '700', style: 'normal' },
    { path: './inter/latin-ext.woff2', weight: '800', style: 'normal' },
    { path: './inter/latin-ext.woff2', weight: '900', style: 'normal' },
  ],
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
  declarations: [{ prop: 'unicode-range', value: 'u+0100-02ba,u+02bd-02c5,u+02c7-02cc,u+02ce-02d7,u+02dd-02ff,u+0304,u+0308,u+0329,u+1d00-1dbf,u+1e00-1e9f,u+1ef2-1eff,u+2020,u+20a0-20ab,u+20ad-20c4,u+2113,u+2c60-2c7f,u+a720-a7ff' }],
});

const interVietnamese = localFont({
  src: [
    { path: './inter/vietnamese.woff2', weight: '400', style: 'normal' },
    { path: './inter/vietnamese.woff2', weight: '500', style: 'normal' },
    { path: './inter/vietnamese.woff2', weight: '600', style: 'normal' },
    { path: './inter/vietnamese.woff2', weight: '700', style: 'normal' },
    { path: './inter/vietnamese.woff2', weight: '800', style: 'normal' },
    { path: './inter/vietnamese.woff2', weight: '900', style: 'normal' },
  ],
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
  declarations: [{ prop: 'unicode-range', value: 'u+0102-0103,u+0110-0111,u+0128-0129,u+0168-0169,u+01a0-01a1,u+01af-01b0,u+0300-0301,u+0303-0304,u+0308-0309,u+0323,u+0329,u+1ea0-1ef9,u+20ab' }],
});

const interGreek = localFont({
  src: [
    { path: './inter/greek.woff2', weight: '400', style: 'normal' },
    { path: './inter/greek.woff2', weight: '500', style: 'normal' },
    { path: './inter/greek.woff2', weight: '600', style: 'normal' },
    { path: './inter/greek.woff2', weight: '700', style: 'normal' },
    { path: './inter/greek.woff2', weight: '800', style: 'normal' },
    { path: './inter/greek.woff2', weight: '900', style: 'normal' },
  ],
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
  declarations: [{ prop: 'unicode-range', value: 'u+0370-0377,u+037a-037f,u+0384-038a,u+038c,u+038e-03a1,u+03a3-03ff' }],
});

const interGreekExt = localFont({
  src: [
    { path: './inter/greek-ext.woff2', weight: '400', style: 'normal' },
    { path: './inter/greek-ext.woff2', weight: '500', style: 'normal' },
    { path: './inter/greek-ext.woff2', weight: '600', style: 'normal' },
    { path: './inter/greek-ext.woff2', weight: '700', style: 'normal' },
    { path: './inter/greek-ext.woff2', weight: '800', style: 'normal' },
    { path: './inter/greek-ext.woff2', weight: '900', style: 'normal' },
  ],
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
  declarations: [{ prop: 'unicode-range', value: 'u+1f??' }],
});

const interCyrillic = localFont({
  src: [
    { path: './inter/cyrillic.woff2', weight: '400', style: 'normal' },
    { path: './inter/cyrillic.woff2', weight: '500', style: 'normal' },
    { path: './inter/cyrillic.woff2', weight: '600', style: 'normal' },
    { path: './inter/cyrillic.woff2', weight: '700', style: 'normal' },
    { path: './inter/cyrillic.woff2', weight: '800', style: 'normal' },
    { path: './inter/cyrillic.woff2', weight: '900', style: 'normal' },
  ],
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
  declarations: [{ prop: 'unicode-range', value: 'u+0301,u+0400-045f,u+0490-0491,u+04b0-04b1,u+2116' }],
});

const interCyrillicExt = localFont({
  src: [
    { path: './inter/cyrillic-ext.woff2', weight: '400', style: 'normal' },
    { path: './inter/cyrillic-ext.woff2', weight: '500', style: 'normal' },
    { path: './inter/cyrillic-ext.woff2', weight: '600', style: 'normal' },
    { path: './inter/cyrillic-ext.woff2', weight: '700', style: 'normal' },
    { path: './inter/cyrillic-ext.woff2', weight: '800', style: 'normal' },
    { path: './inter/cyrillic-ext.woff2', weight: '900', style: 'normal' },
  ],
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
  declarations: [{ prop: 'unicode-range', value: 'u+0460-052f,u+1c80-1c8a,u+20b4,u+2de0-2dff,u+a640-a69f,u+fe2e-fe2f' }],
});

const barlowCondensedLatin = localFont({
  src: [
    { path: './barlow-condensed/latin-500.woff2', weight: '500', style: 'normal' },
    { path: './barlow-condensed/latin-700.woff2', weight: '700', style: 'normal' },
  ],
  display: 'swap',
  preload: true,
  adjustFontFallback: false,
  declarations: [{ prop: 'unicode-range', value: 'u+00??,u+0131,u+0152-0153,u+02bb-02bc,u+02c6,u+02da,u+02dc,u+0304,u+0308,u+0329,u+2000-206f,u+20ac,u+2122,u+2191,u+2193,u+2212,u+2215,u+feff,u+fffd' }],
});

const barlowCondensedLatinExt = localFont({
  src: [
    { path: './barlow-condensed/latin-ext-500.woff2', weight: '500', style: 'normal' },
    { path: './barlow-condensed/latin-ext-700.woff2', weight: '700', style: 'normal' },
  ],
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
  declarations: [{ prop: 'unicode-range', value: 'u+0100-02ba,u+02bd-02c5,u+02c7-02cc,u+02ce-02d7,u+02dd-02ff,u+0304,u+0308,u+0329,u+1d00-1dbf,u+1e00-1e9f,u+1ef2-1eff,u+2020,u+20a0-20ab,u+20ad-20c4,u+2113,u+2c60-2c7f,u+a720-a7ff' }],
});

const barlowCondensedVietnamese = localFont({
  src: [
    { path: './barlow-condensed/vietnamese-500.woff2', weight: '500', style: 'normal' },
    { path: './barlow-condensed/vietnamese-700.woff2', weight: '700', style: 'normal' },
  ],
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
  declarations: [{ prop: 'unicode-range', value: 'u+0102-0103,u+0110-0111,u+0128-0129,u+0168-0169,u+01a0-01a1,u+01af-01b0,u+0300-0301,u+0303-0304,u+0308-0309,u+0323,u+0329,u+1ea0-1ef9,u+20ab' }],
});

const dmSansLatin = localFont({
  src: [
    { path: './dm-sans/latin.woff2', weight: '400', style: 'normal' },
    { path: './dm-sans/latin.woff2', weight: '500', style: 'normal' },
    { path: './dm-sans/latin.woff2', weight: '600', style: 'normal' },
    { path: './dm-sans/latin.woff2', weight: '700', style: 'normal' },
  ],
  display: 'swap',
  preload: true,
  adjustFontFallback: false,
  declarations: [{ prop: 'unicode-range', value: 'u+00??,u+0131,u+0152-0153,u+02bb-02bc,u+02c6,u+02da,u+02dc,u+0304,u+0308,u+0329,u+2000-206f,u+20ac,u+2122,u+2191,u+2193,u+2212,u+2215,u+feff,u+fffd' }],
});

const dmSansLatinExt = localFont({
  src: [
    { path: './dm-sans/latin-ext.woff2', weight: '400', style: 'normal' },
    { path: './dm-sans/latin-ext.woff2', weight: '500', style: 'normal' },
    { path: './dm-sans/latin-ext.woff2', weight: '600', style: 'normal' },
    { path: './dm-sans/latin-ext.woff2', weight: '700', style: 'normal' },
  ],
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
  declarations: [{ prop: 'unicode-range', value: 'u+0100-02ba,u+02bd-02c5,u+02c7-02cc,u+02ce-02d7,u+02dd-02ff,u+0304,u+0308,u+0329,u+1d00-1dbf,u+1e00-1e9f,u+1ef2-1eff,u+2020,u+20a0-20ab,u+20ad-20c4,u+2113,u+2c60-2c7f,u+a720-a7ff' }],
});

/** A CSS font-family list: the subset families in order, then the fallback face. */
const stack = (fallback: string, ...families: Array<{ style: { fontFamily: string } }>): string =>
  [...families.map((f) => f.style.fontFamily), `'${fallback}'`].join(', ');

/**
 * The three CSS variables the app reads, as next/font/google set them on <html>:
 *   --font-inter on <body>, --font-display through Tailwind, --font-dm-sans inline on the marketing pages.
 */
export const FONT_VARIABLES = {
  '--font-inter': stack('netraops-inter-fallback', interLatin, interLatinExt, interVietnamese, interGreek, interGreekExt, interCyrillic, interCyrillicExt),
  '--font-display': stack('netraops-barlow-condensed-fallback', barlowCondensedLatin, barlowCondensedLatinExt, barlowCondensedVietnamese),
  '--font-dm-sans': stack('netraops-dm-sans-fallback', dmSansLatin, dmSansLatinExt),
} as const;
