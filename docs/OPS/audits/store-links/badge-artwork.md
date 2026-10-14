# Store badge artwork: provenance

**Status (owner decision, 2026-10-13 evening): the Apple badge ships now, Google Play stays a
text link of the same height, and Google's official badge replaces the text link when its
file lands.** (The earlier rule, "never ship Apple alone, both badges in one PR", was
Vishnu's and he lifted it.) Apple's badge is on the LEFT, the text link on the right, both
exactly 56 px tall (`BADGE_HEIGHT_PX` in `lib/storeLinks.ts`).

## Apple: "Download on the App Store", black, US-UK

| | |
|---|---|
| Source | Apple "Download on the App Store" badge bundle (all languages), unzipped by Vishnu in `~/Downloads/Download-on-the-App-Store/` on 2026-10-13 14:34 PT. Origin: developer.apple.com Marketing Resources, per Vishnu; I did not fetch it. |
| Picked | `US/Download_on_App_Store/Black_lockup/SVG/` (owner instruction: US, black, SVG) |
| File | `Download_on_the_App_Store_Badge_US-UK_RGB_blk_092917.svg` (name kept as supplied) |
| In repo at | `apps/web/public/badges/Download_on_the_App_Store_Badge_US-UK_RGB_blk_092917.svg` |
| sha256 | `a26fc5b38380272c92e9019a2eb8b45542a66814b3e2b203772db8904b9fb99f` |
| Size | 10,804 bytes; file date 2017-09-29 (the "092917" in the name is Apple's artwork date) |
| Intrinsic size | 119.66407 x 40 (width x height), aspect 2.99:1 |
| Altered? | No. Byte-identical copy (`cp -p`; sha256 re-checked on 2026-10-13 against BOTH copies in `~/Downloads`: the bundle path above and `~/Downloads/SVG/`). Nothing in `~/Downloads` was deleted or modified. **Pinned** as `sha256` in `STORE_ARTWORK` (`lib/storeLinks.ts`): `check:store-links` compares it with the file in the repo, `check:app-page` with the bytes the deployed site serves. |
| Content scan | 25 `<path>`, 9 `<g>`, 1 `<title>`, 1 `<svg>`. No script, event handler, `<style>`, `<image>`, `data:`, `href` or external reference (the single `http://` is the SVG xmlns). Safe to serve from our domain. |
| Licence | Apple Marketing Agreement, accepted by Vishnu when he downloaded the bundle. |
| NOT checked | Whether this 2017-dated file is byte-identical to what Apple's Marketing Tools emits today. It was not compared (that would be a new download). |

**Measured on the built page (2026-10-13, a production build, Chromium):** displayed
height **56 px**, width 167.5 px (`<img>` height 56, SVG aspect 2.991); the **visible**
(non-transparent) badge measured 56 x 167.5 px, i.e. the artwork fills its box, with no
built-in padding. The clear space is a quarter of that, **14 px**, and the tile's padding
(24 px on a phone, 32 px from the `sm` breakpoint) and the gap to the neighbouring link
(20 px stacked, 32 px side by side) are both larger. The SVG's own size reads 119.66407 x 40;
`STORE_ARTWORK` holds 120 x 40 (HTML attributes), within 1% of that aspect, and only
reserves space before the file loads.

Rules this artwork carries (Apple Marketing Resources and Identity Guidelines,
read in Phase 2): use the supplied black badge unchanged (its grey border is
part of the artwork); at least 40 px tall on screen (this file is natively 40);
clear space of a quarter of its height with nothing inside it; no animating,
angling, recolouring or redrawing; one per layout, subordinate to the main
message; first in a lineup that includes another platform's badge.

## Google: "Get it on Google Play"

**PENDING.** Gated behind Partner Marketing Hub approval (about 1 business day,
per Vishnu). Required before the follow-up PR: the unaltered artwork, its
source and sha256, natural pixel dimensions, and a measured *visible* badge
height (Google's PNGs carry built-in padding, and Google's visible badge must be
at least as tall as Apple's). Re-read the Hub's current legal line at that time.

## When Google's file lands (a small PR)

1. Add the file under `apps/web/public/badges/`, unaltered; record its source, sha256 and natural size here.
2. Add `google` to `STORE_ARTWORK` in `apps/web/lib/storeLinks.ts` (src, width, height, sha256). The text link becomes the badge; `StoreBadge` and both check scripts already handle it, and the row stays `BADGE_HEIGHT_PX` tall.
3. **Measure the VISIBLE badge height** (Google's PNGs carry built-in padding): Google's visible badge must be at least as tall as Apple's (56 px), so the file may need to display taller than 56 px. If it does, raise `BADGE_HEIGHT_PX` for both rather than shrinking Apple, and re-check Apple's clear space.
4. Re-read the Partner Marketing Hub's current legal line and update the footer credit text if it changed.
5. Re-run `npm run check:store-links` and `check:app-page` against a production build; screenshots at 375/390/1280.
