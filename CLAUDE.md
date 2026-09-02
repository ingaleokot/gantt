# Gantt — project context for Claude

Personal Gantt chart tool. Editor runs as a Claude artifact; data lives in Supabase;
a public view-only page is served through a Supabase Edge Function + one static file.
Read README.md for the full architecture. Key facts and hard-won gotchas below.

## Deployed pieces

- Artifact (editor): https://claude.ai/code/artifact/09b3dbcb-ca6b-4bca-bdc8-f0243049ac30
  — republish `out/gantt-chart.html` to this URL. Capabilities: mcp (Supabase,
  execute_sql only) + downloads. Do NOT add the artifact self-publish capability:
  publish() reloads every open view and loses in-progress edits.
- Supabase project "Gantt": id `wouvkkaxehwuhtgpersx` (org "Personal"),
  https://wouvkkaxehwuhtgpersx.supabase.co
- Edge Function `shared` (verify_jwt: false, source in `edge/shared/index.ts`):
  `/functions/v1/shared/<anything>?raw=1` returns the composed viewer HTML
  (CORS *); without `?raw` returns a pointer note.
- `hosting/gantt-share.html` — the public share page; the build copies it to
  `docs/index.html`, which GitHub Pages serves at
  https://ingaleokot.github.io/gantt/. It fetches ?raw=1 and renders it in a
  full-page srcdoc iframe. Never edit `docs/` by hand — `bun build.mjs` rewrites it.

## Build

- Toolchain is Bun (`bun install`, `bun.lock`). Node/npm are not used and the npm
  lockfile was dropped.
- `bun build.mjs` → `out/gantt-chart.html` (artifact fragment, no doctype),
  `docs/index.html` (the GitHub Pages share page),
  `out/view-template.html` (standalone viewer with `"__GANTT_VIEW_DATA__"`
  placeholder), `out/test.html` (harness with stubbed `window.claude`).
- There is no automated test suite: the Playwright regression scripts were removed.
  Verify changes by hand in `out/test.html` before republishing the artifact.

## Data model (Supabase is the only store — no localStorage, no static data)

Tables: `people(id,name,position)`, `projects(id,name,view,position)`, `tasks(id, project_id FK, parent_id
self-FK, text, type, start_date, end_date, duration, hours, days, progress,
details, open, sort_order, url, status, assignees)` — `assignees` is a
comma-separated list of `people.id`, resolved to names/initials at render time, `links(id, project_id, source, target,
type)`, `app_state(id='main', active_project)`, plus `view_page` / `view_chunks`
(viewer template, base64 chunks, synced by the editor when Share opens and the
hash differs). RLS enabled with NO policies, no auth yet — auth is planned; the
page goes through the user's Supabase connector (execute_sql), the edge function
uses the service role.

## Gotchas that cost real debugging time

- SVAR react-gantt 2.x, PRO features reimplemented manually: weekend-skipping
  scheduling (HOURS_PER_DAY=7, `scheduleFromHours` + intercepts) and undo/redo
  (JSON snapshot stacks, not `getHistory()` which is PRO-only).
- DOM decoration (type icons, status dots, tracker pills, epic bands, project
  span) happens in a MutationObserver tagger. APPEND nodes only — `insertBefore`
  breaks React reconciliation ("forEach of null" crashes). Position appended
  nodes with CSS flex `order`. Call `observer.takeRecords()` to avoid loops.
- Never set `open: true` on leaf tasks passed to the Gantt — the tree walker
  crashes ("Cannot read properties of null (reading 'forEach')"). Only tasks
  with children get `open`.
- A summary (epic) task with no children must keep explicit start/end dates or
  the widget throws; with children its dates are deleted and auto-computed.
- Widgets (MGantt/MToolbar/MContextMenu/MEditor) are memoized with stable props —
  otherwise App re-renders reset the uncontrolled editor fields mid-typing.
- Mount-guard pattern in intercept setTimeouts: compare `apiRef.current` and the
  captured activeProject before acting, or a stale mount serializes an empty
  widget over freshly loaded data.
- Supabase refuses to serve renderable pages from *.supabase.co: text/html and
  xml/xhtml GET responses are rewritten to text/plain, SVG prompts a download,
  absent content-type is forced to text/plain. Hence the static hosting page +
  ?raw fetch design. Don't try to serve HTML from the edge function directly.
- SQL strings: escape single quotes by doubling; template chunks are base64 so
  they're SQL-safe. `String.replace` with JSON payloads must use a function
  replacement (`.replace(x, () => json)`) to dodge `$` pattern expansion.
- Artifact publishes from Claude use force:true — the user granted standing
  consent because Supabase is the source of truth, page-saved artifact versions
  can be discarded.
