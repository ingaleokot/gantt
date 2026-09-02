# Gantt — project context for Claude

Personal Gantt chart tool: a Vite + React SPA on SVAR react-gantt, talking straight to
cloud Supabase. Read README.md for the full architecture. Key facts and hard-won
gotchas below.

## Deployed pieces

- GitHub Pages under base path `/gantt/`:
  - `/gantt/` — the editor SPA, gated behind Supabase Auth (email + password)
  - `/gantt/share/` — the public read-only viewer, no auth, no Supabase client
  Build with `bun run build` and publish `dist/`. There is no `docs/` folder any more.
- Supabase project "Gantt": id `wouvkkaxehwuhtgpersx` (org "Personal"),
  https://wouvkkaxehwuhtgpersx.supabase.co — **cloud only, never run a local stack.**
- Edge Function `shared` (verify_jwt: false, source in `edge/shared/index.ts`):
  `?raw=1` returns `{active, projects, tasks, links, people}` as JSON with CORS `*`;
  optional `&owner=<uuid>` narrows it. Without `?raw` it returns a pointer note.
  **The user deploys it — don't.**
- The user owns all Supabase deploys and migrations. Never apply SQL, never deploy
  the function, never commit or push.

## Build

- Toolchain is Bun (`bun install`, `bun.lock`). Node is not installed and
  `/opt/homebrew/bin` is not on PATH by default — prefix shell commands with
  `export PATH=/opt/homebrew/bin:$PATH`.
- `bun run dev` (Vite, http://localhost:5173/gantt/) runs the real app against cloud
  Supabase. `bun run build` → `dist/` with both entries. `bun run preview` serves it.
- `.env` (gitignored) holds `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`,
  read via `import.meta.env`. Never hardcode or commit the values.
- There is no automated test suite. Verify by hand in `bun run dev`.

## Data model (Supabase is the only store — no localStorage, no static data)

Tables: `projects(id,name,view,position,owner)`, `tasks(id, project_id FK, parent_id
self-FK, text, type, start_date, end_date, duration, hours, days, progress, details,
open, sort_order, url, status, assignees)`, `links(id, project_id, source, target,
type)`, `people(id,name,position,owner)`, `app_state(id='main', active_project, owner)`.

- **RLS is owner-scoped.** Every insert of `projects`, `people` and `app_state` must set
  `owner = session.user.id` or the write is rejected. `tasks`/`links` inherit ownership
  through `project_id` — they have no owner column, don't add one.
- `tasks.assignees` is a comma-separated list of `people.id`.
- All persistence lives in `src/lib/db.js` as supabase-js table queries. There is no SQL
  string building anywhere — don't reintroduce it.
- Deletions are diffed client-side (select ids, then `.in('id', dead)`), never expressed
  as a `not.in.(…)` filter string.
- `tasks` carries a self-FK, so `db.js` sorts rows parents-first before inserting.

## Gotchas that cost real debugging time

- SVAR react-gantt 2.x, PRO features reimplemented manually: weekend-skipping
  scheduling (HOURS_PER_DAY=7, `scheduleFromHours` + intercepts) and undo/redo
  (JSON snapshot stacks, not `getHistory()` which is PRO-only).
- DOM decoration (type icons, status dots, tracker pills, epic bands, project span, the
  Who column chips and its picker bridge) happens in a MutationObserver tagger. APPEND
  nodes only — `insertBefore` breaks React reconciliation ("forEach of null" crashes).
  Position appended nodes with CSS flex `order`. Call `observer.takeRecords()` to avoid
  loops.
- Never set `open: true` on leaf tasks passed to the Gantt — the tree walker crashes
  ("Cannot read properties of null (reading 'forEach')"). Only tasks with children get
  `open`.
- A summary (epic) task with no children must keep explicit start/end dates or the
  widget throws; with children its dates are deleted and auto-computed.
- Widgets (MGantt/MToolbar/MContextMenu/MEditor) are memoized with stable props —
  otherwise App re-renders reset the uncontrolled editor fields mid-typing.
- Mount-guard pattern in intercept setTimeouts: compare `apiRef.current` and the
  captured activeProject before acting, or a stale mount serializes an empty widget over
  freshly loaded data. Timing subtlety: the guard relies on `dbLoad()` being a real
  network round-trip. An instantly-resolving data source (a stub, a synchronous cache)
  makes the first mount abort and the row tagger never starts.
- Vite strips SVAR's `@font-face` rules via a small plugin in `vite.config.js`; the app
  supplies its own faces and passes `fonts={false}` to Willow.
- Stylesheet import order in the entries is load-bearing: `style.css`, then
  `@svar-ui/react-gantt/all.css`, then `wx-overrides.css` and `icons.css`.
- PDF export uses jsPDF's plain browser download: `buildGanttPdf(...)` returns the doc
  and the caller calls `doc.save(name)`.
- The artifact integration is gone: no `window.claude`, no `mcp`/`downloads`/`publish`
  capability, no `view_page`/`view_chunks` template chunking. Don't bring any of it back.
