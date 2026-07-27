# Mobile-Responsive Pattern

The web app is a single Next.js project serving three portals (`/admin`,
`/client`, `/vishnu`). All three should work at 375–430px viewports
without horizontal scroll. This doc captures the pattern already in
place so new pages follow it instead of inventing a new one.

## Breakpoint

Tailwind default `md:` — **768px** — is the mobile↔desktop switching
line. Below `md`, mobile layout. At `md` and up, desktop layout.

We use only `md:` in the responsive lattice. Do not introduce `sm:` or
`lg:` splits for layout switching — only for typography/spacing polish.

## Navigation — already responsive, do not touch

`components/admin/AdminNav.tsx` (and its `/client` / `/vishnu`
equivalents) already ship a full mobile navigation:

- Desktop: fixed `w-56` left sidebar, `hidden md:flex`.
- Mobile: fixed top bar with hamburger (`md:hidden`, `h-14`), sliding
  drawer overlay (`fixed inset-0 z-50`) with a click-to-close
  backdrop. Drawer auto-closes on route change via `useEffect` on
  `usePathname`.
- Layout accounts for the top bar with `pt-[72px] md:pt-6` in
  `app/admin/layout.tsx`.

**Do not rebuild the nav.** New pages inherit it for free by living
under the portal's layout.

## Page-level pattern for lists

Every list-style page (sites, guards, shifts, clients, billing history)
uses a **card layout that reads mobile-first** and stays as cards at
every breakpoint. That is the reference.

- One card per row entry, stacked vertically.
- Card holds the primary label, secondary metadata below, and
  right-aligned action controls.
- No `<table>` for lists. If you need alignment, use a grid inside the
  card.

Do not build a desktop table that collapses to cards on mobile —
maintain a single card layout for both. Compare
`app/admin/sites/page.tsx` and `app/admin/guards/page.tsx`.

## Page-level pattern for data tables

Some views are genuinely tabular (activity logs, live-status guard
list, breach history). For those:

1. Prefer converting to a card layout at mobile using
   `hidden md:table` / `md:hidden` twin renderings.
2. If the table has too many columns and cards are impractical, wrap in
   a horizontally scrolling container:

   ```tsx
   <div className="overflow-x-auto">
     <table className="min-w-full">…</table>
   </div>
   ```

   The scroll must live inside a bounded container — never let the
   `<body>` scroll horizontally.

## Filter rows

Filter/tab rows (`24H | 7D | 30D`, `ALL | OPEN | RESOLVED`) that fit on
one desktop line often overflow at 390px. Wrap with `flex flex-wrap
gap-2` so overflowed chips wrap to the next line instead of clipping.

## Master/detail views (chat)

Two-pane layouts (list + selected item, e.g. chat conversations)
collapse to a master/detail switch on mobile: show the list; tapping an
item swaps the whole viewport to the detail view with a back arrow.
Desktop keeps the side-by-side. Reference implementation:
`app/admin/chat/page.tsx`.

## Typography that wraps

Big display numbers in narrow KPI cards (`text-4xl` values like
`29h 50m`) can wrap awkwardly on mobile. Use `whitespace-nowrap` and
step the font size down (`text-3xl md:text-4xl`) so the value stays on
one line.

## Padding and containers

Body padding is applied by the portal layout (`p-4 md:p-6`). Individual
pages should not add their own outer padding — start their root with
`space-y-6` or similar and let the layout own the gutter.

## Viewport targets

Primary: iPhone SE (375), iPhone 14 (390), iPhone 14 Pro Max (430),
iPad portrait (768). Desktop 1024px+ must render exactly as it did
before any responsive edit — verify with a 1280×800 snapshot after
each change.
