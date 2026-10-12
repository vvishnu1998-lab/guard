# Store screenshot builder

Single-file tool that composes the store screenshots for the NetraOps guard
app from raw phone captures. A **Target** selector at the top switches between
the two stores:

| target | designs | export |
|---|---|---|
| **Google Play 1080x1920** | Version C "Bold Panoramic", Version B "Light Contrast" | 10 frames, 1080x1920 |
| **App Store 6.9-inch 1320x2868** | Version D "Navy & Gold" | 5 frames, 1320x2868 |

Nothing here is wired into a build. `apps/web`, `apps/api`, `apps/mobile`,
Vercel and CI do not read this directory.

## Layout

```
netraops_builder.html    the tool — open it, that is all there is
screens/                 Play source captures (Android), in frame order
screens-ios/             App Store source captures (iPhone 17 Pro Max), in frame order
vendor/                  html-to-image, JSZip, FileSaver
out/                     exported images (gitignored — never committed)
```

The two webfonts are **not** in `vendor/` — they are base64 data URIs inside
the HTML. See "Why the fonts are inlined" below.

## Opening it

Serving over HTTP is still the recommended way:

```bash
cd marketing/play-store && python3 -m http.server 8777 --bind 127.0.0.1
```

Then open <http://127.0.0.1:8777/netraops_builder.html>.

`--bind 127.0.0.1` matters: without it the server listens on every interface
and anyone on the network can read the directory.

Opening the file directly works too. The tool shows an amber banner when it
detects `file://` and exports stay enabled — the fonts are inlined, so they
survive, but Tailwind still comes from a CDN and any asset added later would
be fetched the same way the fonts once were.

## Why the fonts are inlined

html-to-image rebuilds the frame as an SVG `foreignObject`, which means it has
to **`fetch()`** every `@font-face` source and re-embed it as a data URI. Under
`file://` that fetch is blocked — `Fetch API cannot load file:///… URL scheme
"file" is not supported` — so the embed step silently produced no font and the
export fell back to Arial.

The failure was invisible from the page: the browser's own CSS `url()` load is
*not* subject to that restriction, so the live preview rendered Barlow
correctly while the exported file did not. Only the written file was wrong.

Symptoms in the export were severe — "EVERY SHIFT." wrapped onto two lines in
the fallback face, and the "Verified." subline collided with the second line.

Both faces are therefore `url(data:font/woff2;base64,…)` in the `@font-face`
rules. A data URI needs no fetch, so it survives any origin. That costs about
84 KB of base64 in the HTML, which is the price of a tool that is correct
however it is opened.

`captureNode()` additionally awaits `document.fonts.load()` for all four faces
it renders — Barlow 700 and Inter 400/600/700 — and then `document.fonts.ready`
before every capture. Inter is a variable font, so each weight has to be
requested individually; loading the family once does not guarantee the 600 and
700 instances are ready.

## Exporting — Play target

1. Upload the five files from `screens/` into frames 1-5, **in order** —
   Login, Home, Schedule, Reports, Chat. The tool derives each screenshot's
   aspect ratio and its band colours from the uploaded pixels, so frames stay
   blank until their image is in.
2. Adjust if needed. Settings persist to `localStorage` per screen; **Reset to
   defaults** restores the shipped values. Images are never stored.
3. **Download All 10** for a zip, **Download Version C/B (5)** for one design,
   or **Export Frame** for a single image.

### Toggles

| toggle | default | what it does |
|---|---|---|
| **Status Bar** | on | Version C only. Adds the 22px row described below. |
| **Bleed** | **off** | Version C only. Off centres every phone at local X 180, one whole device per frame. On restores the panoramic strip: phones sit at their approved world positions (`265,392` frames 1-4, `205,392` frame 5) and spill across frame edges. |
| **Show Guides** | off | Draws the red *unrotated rect* — the device box before tilt, not its on-screen bounds. |
| **Use PNG** | off | See the format note under Play Store requirements. |

Each frame also has a **Status Bar Clock** field. The defaults run 8:55 / 8:56 /
8:57 / 8:58 / 9:00 across the strip so the set reads as one continuous shift.
Two of them have to match what is already inside the screenshot: Home renders
its own `8:56 AM` in the app header, and Chat shows an `8:59 AM` message
timestamp that the bar must sit *after*. No AM/PM in the bar — a real status
bar on a 12-hour phone shows neither.

Exports land in your browser's download directory. Move them to `out/` — it is
gitignored, so nothing exported is ever committed.

Filenames are fixed: `NetraOps_<C|B>_<N>_<Screen>.jpg`, e.g.
`NetraOps_C_2_Home.jpg`.

## Play Store requirements

| requirement | value |
|---|---|
| resolution | 1080x1920 (9:16 portrait) |
| format | JPEG, or 24-bit PNG **without alpha** |
| count | 2 to 8 phone screenshots per listing |
| max file size | 8 MB each |

The tool exports JPEG by default, which cannot carry an alpha channel. The
**Use PNG** checkbox switches format; if you use it, confirm the result is
24-bit and opaque before uploading — Play rejects PNGs with alpha.

Every capture asserts its own output is exactly 1080x1920 and raises a banner
if it is not.

## Play design constraints

These are approved and deliberate. Do not change them without a new approval:

- frame order, headline text, and sublines
- colours, the background gradient, and the three skewed bands
- tilt angles (`+5 / -5 / +5 / -5 / +5`) and device centres —
  Version C `(265, 392)` for frames 1-4 and `(205, 392)` for frame 5 when
  **Bleed** is on, `180` when it is off; Version B centre X `180`
- fonts: Barlow Condensed 700 for headlines, Inter for everything else
- export filenames

Version C keeps every tilted device inside **y 152-632** — clear of the
headline block, which ends at y=120. `geomC()` enforces that by solving for the
largest `innerW` whose *rotated* bounding box still fits, counting the 2px cyan
ring the box-shadow draws outside the border. At the five shipped ratios the
limit is 196.42, so `innerW` stays at the approved 196 and nothing shrinks; a
taller future capture would shrink instead of escaping the band.

No callouts. No "best", "#1", "free", "new", no prices, no calls to action —
Play's metadata policy prohibits promotional overlays on screenshots.

### The status bar row

The source captures contain **no OS status bar** — each opens with a flat band
of app padding, and the first real pixel is already app content (as low as
y=41 on Home).

So the fake status bar is not an overlay. It is its own 22px row stacked
*above* the screenshot, and the device's inner height is
`22 + innerW x ratio`. Nothing is ever painted over app content.

The row is on by default and controlled by one global toggle. Version B has no
status bar at all; its `Hide Top` slider only sets how far the device bleeds
past the top edge of the frame.

## App Store target

Select **App Store 6.9-inch 1320x2868**, upload the five files from
`screens-ios/` into frames 1-5 in order, and use **Download App Store (5)** or
the per-frame **Export Frame**. Files are `NetraOps_iOS_D_<N>_<Screen>.jpg`.
The target has its own upload slots and its own settings key
(`netraops_builder_ios_v1`); the selected target is remembered under
`netraops_builder_target_v1`. Images are never stored.

### App Store requirements

| requirement | value |
|---|---|
| display size | **6.9-inch** iPhone — required; Apple scales it down for smaller iPhones |
| resolution | **1320x2868** portrait, which is what this target exports |
| format | JPEG or PNG, RGB, **no alpha** |
| count | **1 to 10** screenshots per localisation |
| iPad | **not required** — `apps/mobile/app.json` sets `ios.supportsTablet: false`. If that ever changes, App Store Connect will also require a 13-inch iPad set |

JPEG 0.95 is the default; **Use PNG** switches format. Both are flattened onto
an opaque canvas before encoding: a `{alpha:false}` context makes Chromium write
PNG colour type 2 (RGB) instead of 6 (RGBA), so neither format can carry an
alpha channel. The size is asserted on the *encoded* file, and a wrong-size
file is refused rather than saved.

(The Play target's own **Use PNG** path still writes RGBA — see the Play
requirements note. It is unchanged here on purpose.)

### Version D — "Navy & Gold"

Same brand as Play, deliberately different design:

| | Play (C / B) | App Store (D) |
|---|---|---|
| background | blue diagonal gradient + bands / light grey | solid navy `#0B1526`, one soft radial cyan glow behind the phone |
| phone | tilted ±5° | upright, centred |
| device | dark rounded frame, cyan ring | iPhone-style: gold `#C9A84C` hairline, titanium band, black bezel, Dynamic Island |
| status bar | fake 22px row (C) / none (B) | the **real** iOS status bar from the capture — no edits |
| headline | white, top (C) / navy, bottom (B) | gold Barlow power word + white 85% Inter line; top, top, bottom, top, bottom |

Copy, in frame order:

| frame | power word | supporting line |
|---|---|---|
| 1 Login | NETRAOPS | Guard management, done right. |
| 2 Home | ON POST | Every shift verified by location. |
| 3 Schedule | THE WEEK AHEAD | Shifts at a glance. |
| 4 Reports | FILE IT FAST | Reports in seconds, with photos. |
| 5 Chat | ONE TAP AWAY | Direct line to your admin. |

Apple's guidelines apply as for Play: no "best", "#1", "free", "new", prices,
ratings, awards or calls to action on the screenshots.

#### Spec (logical px in a 440x956 frame; x3 = 1320x2868)

| element | geometry |
|---|---|
| safe area | x 32–408 (content width 376), y 44–912 |
| headline block | x 32–408, height 94. Top: y 56–150. Bottom: y 806–900 |
| title | Barlow Condensed 700, 56px / line 56, letter-spacing 0.02em, `#C9A84C`, one line |
| supporting line | Inter 600, 20px / line 26, `rgba(255,255,255,0.85)`, 12 below the title, one line |
| headline ↔ phone | 36 minimum, both placements |
| phone (outer) | 346.02 x 726, x 46.99–393.01. Headline top: y 186–912. Headline bottom: y 44–770 |
| device layers | gold 1 → titanium `#2E3546` 2 → black 8 → screen; radii concentric |
| screen | 324.02 x 704 (ratio 2868/1320 exactly), radius 40.50 = 55pt |
| Dynamic Island | 92.05 x 27.25, top 9.94 inside the screen, centred, radius 13.62 |
| glow | one radial gradient 330x560 centred on the phone, cyan 30% → 16% → 5% → 0 |

The widest title ("THE WEEK AHEAD") measures 363.5 of the 376 available; the
widest supporting line measures 316.1. A taller-than-wide capture would keep
this geometry; a much wider one shrinks the phone to the safe width instead of
crossing the margins.

Two choices here are measured, not assumed. The 55pt display radius hides only
uniform background in all five captures (max deviation 0 at every masked
pixel), so the rounded screen crops no app content. The island's footprint is
pure background in all five and sits in the gap between the clock and the
status icons, so it covers nothing.

## Vendored dependencies

`vendor/` holds html-to-image, JSZip and FileSaver, committed so the tool works
offline and cannot break when a CDN moves. The two webfonts are inlined into
the HTML instead, for the reason given above.

Tailwind still loads from its CDN — it is a dev-time convenience and the tool
degrades to unstyled-but-working without it. It is the one remaining reason the
`file://` banner is worth heeding.
