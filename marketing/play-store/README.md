# Play Store screenshot builder

Single-file tool that composes the Google Play Store screenshots for the
NetraOps guard app from five raw phone captures.

It renders two approved designs — **Version C "Bold Panoramic"** and
**Version B "Light Contrast"** — five frames each, and exports all ten at
1080x1920.

Nothing here is wired into a build. `apps/web`, `apps/api`, `apps/mobile`,
Vercel and CI do not read this directory.

## Layout

```
netraops_builder.html    the tool — open it, that is all there is
screens/                 the five source captures, in frame order
vendor/                  html-to-image, JSZip, FileSaver, and the webfonts
out/                     exported images (gitignored — never committed)
```

## Opening it

The tool needs `fetch()` on its own vendored files, which the `file://`
origin blocks. Serve the directory over HTTP instead:

```bash
cd marketing/play-store && python3 -m http.server 8777 --bind 127.0.0.1
```

Then open <http://127.0.0.1:8777/netraops_builder.html>.

`--bind 127.0.0.1` matters: without it the server listens on every interface
and anyone on the network can read the directory.

## Exporting

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

## Design constraints

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

## Vendored dependencies

`vendor/` is committed so the tool works offline and cannot break when a CDN
moves. Tailwind still loads from its CDN — it is a dev-time convenience and
the tool degrades to unstyled-but-working without it.
