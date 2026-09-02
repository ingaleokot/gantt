# Gantt

A personal Gantt chart tool built as a Claude artifact on top of
[SVAR React Gantt](https://github.com/svar-widgets/react-gantt), with Supabase as the
backing store and a public view-only share page.

## What it does

The editor runs as a Claude artifact (a single self-contained HTML page). It supports
multiple projects, epics with auto-rolled-up dates/hours/days, four task types
(backend / frontend / design / testing) with pastel colors, Merlin-style epic bars,
hour-based estimates (7 h = 1 work day) that skip weekends, bidirectional hours/days
editing, statuses (not started / in progress / done), Yandex Tracker links with an
extracted `PRODUCT-XXXX` ID column, a centered edit modal, keyboard copy/paste/undo
(Cmd+C / Cmd+V / Cmd+Z), collapse/expand-all, PDF export, and a Share button that
hands out a live view-only link.

## Layout

- `src/app.jsx` — the editor app (bundled into the artifact page)
- `src/view.jsx` — the read-only viewer app (same look, no editing UI)
- `src/pdf.js` — vector PDF export (jsPDF, A4 landscape)
- `style.css`, `wx-overrides.css`, `icons.css` — shell styles, SVAR re-skin, icon masks
- `build.mjs` — esbuild: emits `out/gantt-chart.html` (artifact fragment),
  `out/view-template.html` (standalone viewer page with a `__GANTT_VIEW_DATA__`
  placeholder), and `out/test.html` (local harness with a stubbed `window.claude`)
- `edge/shared/index.ts` — Supabase Edge Function `shared`: composes the viewer page
  with live data on every request
- `hosting/gantt-share.html` — the one static file to put on any host; it fetches the
  composed page from the edge function and renders it full-screen
- `test*.mjs`, `testshell.mjs`, `testhost.mjs` — Playwright regression tests

## Storage (Supabase)

All data lives in Postgres — the page keeps nothing locally:

- `projects (id, name, view, position)`
- `tasks (id, project_id → projects, parent_id → tasks, text, type, start_date,
  end_date, duration, hours, days, progress, details, open, sort_order, url, status)`
- `links (id, project_id, source → tasks, target → tasks, type)`
- `app_state (id = 'main', active_project)`
- `view_page (id = 'main', hash, chunk_count)` and `view_chunks (idx, hash, data)` —
  the viewer page template, uploaded in base64 chunks by the editor the first time
  Share is opened (and re-synced whenever the template changes)

The editor reads and writes through the viewer's Supabase connector in claude.ai
(`execute_sql`). No auth yet — RLS is enabled with no policies, and the share
function uses the service role server-side; auth is planned later.

## Share flow

Supabase refuses to serve renderable pages from `*.supabase.co` (HTML is rewritten
to `text/plain`; SVG prompts a download), so the share page is split in two:

1. `hosting/gantt-share.html` sits on any static host — this URL is what viewers open.
2. It fetches `https://<project>.supabase.co/functions/v1/shared/<id>?raw=1`
   (CORS-open), where the edge function stitches the viewer template from
   `view_chunks` with fresh rows from the database, and renders the result in a
   full-page iframe.

Viewers always see the current data; the hosted file never needs re-uploading.

## Develop

```sh
npm install
node build.mjs        # builds out/
node test9.mjs        # share feature (viewer render + template sync)
node testhost.mjs     # hosted share page, cross-origin
node test7.mjs        # editor stability
node test8.mjs        # relational persistence
```

Tests expect a Chromium at `/opt/pw-browsers/chromium` (or run `npx playwright install`
and drop the `executablePath`).
