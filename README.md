# Gantt

A personal Gantt chart tool built on [SVAR React Gantt](https://github.com/svar-widgets/react-gantt),
with Supabase as the backing store and a public view-only share page. It is a Vite +
React SPA with two entry points, deployed to GitHub Pages under `/gantt/`. The shell is
Tailwind CSS v4 + Ark UI + Phosphor icons.

## What it does

Multiple projects, epics with auto-rolled-up dates/hours/days, four task types
(backend / frontend / design / testing) with pastel colors, Merlin-style epic bars,
hour-based estimates (7 h = 1 work day) that skip weekends, bidirectional hours/days
editing, statuses (not started / in progress / done), a people roster with per-task and
per-epic assignment shown as initials in a Who column, Yandex Tracker links with an
extracted `PRODUCT-XXXX` ID column, a centered edit modal, keyboard copy/paste/undo
(Cmd+C / Cmd+V / Cmd+Z), collapse/expand-all, PDF export, and a Share button that hands
out the read-only link.

## Layout

- `index.html` — editor entry; `src/app.jsx` is its module
- `share/index.html` — public viewer entry; `src/view.jsx` is its module
- `src/app.jsx` — the editor app, behind the auth gate
- `src/Login.jsx` — email + password sign-in / sign-up screen
- `src/lib/supabase.js` — the browser Supabase client (reads `import.meta.env`)
- `src/lib/db.js` — all persistence: supabase-js table queries, no SQL strings
- `src/view.jsx` — the read-only viewer (same look, no editing UI, no Supabase client)
- `src/pdf.js` — vector PDF export (jsPDF, A4 landscape); returns a jsPDF doc
- `style.css` — Tailwind entry and the single `@theme` token source
- `wx-overrides.css`, `icons.css` — SVAR re-skin and Phosphor icon masks (plain CSS)
- `scripts/gen-icons.py` — regenerates those mask data URIs from `@phosphor-icons/core`
- `vite.config.js` — `base: '/gantt/'`, two rollup inputs, `@tailwindcss/vite`, and a
  small plugin that strips SVAR's CDN `@font-face` rules
- `edge/shared/index.ts` — Supabase Edge Function `shared`: the public JSON feed for the
  viewer (deployed by hand; this repo only holds the source)

## Styling stack

Tailwind CSS v4 + [Ark UI](https://ark-ui.com) + [Phosphor icons](https://phosphoricons.com).

- **Tokens.** `style.css` is the Tailwind entry. Every design token lives in one
  `@theme static` block there as `--color-*` / `--font-*` / `--shadow-*` / `--animate-*`,
  which gives both the utilities (`bg-surface`, `text-ink`, `font-display`, `shadow-pop`)
  and the CSS variables the plain stylesheets read. `static` is required: Tailwind cannot
  see uses that live in another stylesheet and would otherwise tree-shake those variables
  away. There is **no `tailwind.config.js`** — v4 configures itself from CSS.
- **Themes.** Three blocks must stay in step: the `@theme` block (light), the
  `@media (prefers-color-scheme: dark) :root:not([data-theme="light"])` block, and
  `:root[data-theme="dark"]`. The two dark blocks are unlayered so they beat the layered
  `@theme` values.
- **No preflight.** `style.css` imports `tailwindcss/theme.css` and
  `tailwindcss/utilities.css` but not the reset: preflight forces `box-sizing: border-box`
  and zeroes padding on every element, and SVAR's gantt sizes its own DOM with content-box
  widths. Everything the app renders sets its own border/background/padding utilities, so
  the reset buys nothing and would silently reflow the widget.
- **`wx-overrides.css` stays selector-based CSS.** Most of its ~130 selectors target
  markup we never render (`.wx-willow-theme .wx-row`, `[data-col-id=":text"] .wx-content`,
  the nodes the MutationObserver tagger builds in plain JS), so there is nothing to put a
  class on. It reads the same `@theme` tokens through `var(--color-…)`, so tokens still
  have one home.
- **Literal class strings only.** Tailwind's scanner matches class names that appear
  verbatim in the source. The tagger creates ~14 DOM nodes in plain JS, so those keep
  semantic class names backed by CSS rules rather than utilities, and anything conditional
  in JSX spells out the whole class list per branch (never `"bg-" + name`). A mistake here
  works in dev and silently loses styles in the production build — verify with
  `bun run build && bun run preview`, not just `bun run dev`.
- **Ark UI** owns the shell interaction primitives: `Popover` for Share, the People
  manager and the Who picker (dismissal, focus and placement, replacing the hand-rolled
  `mousedown` listeners and `getBoundingClientRect()` math), `Menu` for the project
  switcher, `SegmentGroup` for the Day/Week/Month and project switchers, `Field` for the
  login inputs. The SVAR gantt, its toolbar, context menu and task editor are
  library-owned and stay untouched.
- **Phosphor icons** everywhere React renders (`@phosphor-icons/react` components). SVAR
  injects its own `<i class="wxi-…">` markup, so `icons.css` reimplements that icon set as
  `mask-image` data URIs pointing at Phosphor glyphs; `scripts/gen-icons.py` regenerates
  `icons.css` and the type-icon/pencil masks in `wx-overrides.css` from
  `@phosphor-icons/core`.

## Auth and access

The editor is gated behind Supabase Auth (email + password). `onAuthStateChange` drives
the gate: no session → login screen, session → the Gantt. RLS is **owner-scoped**, so
every insert of `projects`, `people` and `app_state` carries `owner = session.user.id`.
`tasks` and `links` have no owner column — they inherit ownership through `project_id`.

## Storage (Supabase)

All data lives in Postgres — the page keeps nothing locally:

- `people (id, name, position, owner)` — the roster tasks are assigned from
- `projects (id, name, view, position, owner)`
- `tasks (id, project_id → projects, parent_id → tasks, text, type, start_date, end_date,
  duration, hours, days, progress, details, open, sort_order, url, status, assignees)` —
  `assignees` is a comma-separated list of `people.id`
- `links (id, project_id, source → tasks, target → tasks, type)`
- `app_state (id = 'main', active_project, owner)`

Saves are debounced and rewrite the whole store: upsert projects/people, delete the ones
that disappeared, then replace all tasks and links for the surviving projects.

## Share flow

`/gantt/share/` is a static page with no Supabase client and no auth. It fetches
`https://<project>.supabase.co/functions/v1/shared?raw=1`, where the edge function
(`verify_jwt: false`, service role) returns `{ active, projects, tasks, links, people }`
as JSON with CORS `*`, and renders it read-only. Viewers always see current data.
An optional `&owner=<uuid>` narrows the feed to one account.

## Develop

```sh
bun install
bun run dev       # http://localhost:5173/gantt/ against cloud Supabase
bun run build     # → dist/ (both entries)
bun run preview
```

Tooling is [Bun](https://bun.sh) (`bun.lock` is the lockfile; there is no npm lockfile).
There is no automated test suite — verify changes by hand in `bun run dev`.

Copy `.env.example` to `.env` and fill in `VITE_SUPABASE_URL` and
`VITE_SUPABASE_PUBLISHABLE_KEY` (both are public client credentials; `.env` is gitignored).

## Deploy

`bun run build` emits `dist/` with `index.html` and `share/index.html` under the
`/gantt/` base path. Publish `dist/` to GitHub Pages (Pages → build from an Actions
workflow, or push `dist/` to a `gh-pages` branch) — the old `docs/` folder is gone.
The edge function is deployed separately from `edge/shared/index.ts`.
