# Gantt — project context for Claude

Personal Gantt chart tool: a Vite + React SPA on SVAR react-gantt, styled with Tailwind
CSS v4 + Ark UI + Phosphor icons, talking straight to cloud Supabase. Read README.md for
the full architecture. Key facts and hard-won gotchas below.

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

## Styling layer (Tailwind v4 + Ark UI + Phosphor)

- **One token source.** `style.css` is the Tailwind entry and holds every token in a
  single `@theme static` block: `--color-*`, `--font-*`, the `--text-*` ramp, `--shadow-*`,
  `--ease-*`, `--dur-*`, `--animate-rise`. `static` is load-bearing: `wx-overrides.css`
  reads those tokens through `var(--color-…)` / `var(--dur-…)`, and Tailwind cannot see
  uses in another stylesheet, so without it they'd be tree-shaken. There is **no
  `tailwind.config.js`** — v4 configures from CSS.
- **Three theme blocks** must stay in step: `@theme` (light), the
  `@media (prefers-color-scheme: dark) :root:not([data-theme="light"])` block, and
  `:root[data-theme="dark"]`. Both dark blocks are unlayered so they beat the layered
  `@theme` values regardless of specificity.
- **Preflight is deliberately not imported** — only `tailwindcss/theme.css` and
  `tailwindcss/utilities.css`. Preflight's `box-sizing: border-box` + zeroed padding on
  `*` would reflow SVAR's content-box internals. Consequence: our own elements are
  content-box too, so widths like the 380px share popover measure 414px with padding —
  the same as before the migration. Don't add `box-border` to "fix" it.
- **`wx-overrides.css` and `icons.css` stay plain CSS.** Their selectors target markup we
  never render — SVAR's internals and the nodes the tagger builds in JS.
- **Literal class strings only.** Tailwind's scanner reads source text, so never build a
  class name by concatenation (`"bg-" + type`). Tagger-created nodes keep semantic classes
  backed by CSS; conditional JSX spells out the full class list per branch. A slip works
  in dev and silently loses styles in the production build — check with
  `bun run build && bun run preview`.
- Two `rounded-*` utilities on one element race inside `@layer utilities` (source order
  doesn't decide the winner) — set the radius once per element.
- Ark owns the shell primitives: `Popover` (Share, People, Who picker), `Menu` (project
  switcher), `SegmentGroup` (Day/Week/Month, viewer project switcher), `Field` (login).
  The SVAR gantt, MToolbar, MContextMenu and MEditor are library-owned — leave them alone.

### Design conventions (the Apple-design pass)

- **Press feedback belongs on pointer-down.** Every interactive control carries the
  `press` class (`@layer components` in `style.css`): `transform: scale(0.97)` over
  `--dur-press` (100 ms), plus `press-sm` (0.9) for icon-sized targets. `:active` latches
  on pointerdown, so the surface moves before the click commits. Widget-owned controls
  (`.wx-button`, `.row-edit`, `.who-chips`, `.fold-all`, `.tracker-link`, `.editor-okay`)
  get the same treatment from selectors in `wx-overrides.css`.
- **Motion tokens.** `--dur-press: 100ms`, `--dur-hover: 130ms`, `--dur-enter: 180ms`,
  `--dur-exit: 130ms`; `--ease-emphasized` for anything arriving and `--ease-exit`, its
  mirror, for anything leaving. Don't hardcode a duration or a curve.
- **Anchored popovers.** `pop-anim` keys the `pop-in` / `pop-out` keyframes off Ark's
  `data-state`, with `transform-origin: var(--transform-origin)` — the variable zag writes
  on the positioner from the resolved placement — so each panel grows out of the edge
  nearest its trigger and collapses back into it. The Who picker's remount `key` and
  anchor rect are held in refs (`pickerKeyRef` / `lastPickerRef`) that survive the close;
  keying them on the live `picker` would remount on close and cut the exit off mid-flight.
- **Two material weights.** `material-chrome` (topbar: 20px blur, 58% surface) and
  `material-pop` (floating surfaces: 30px blur, 82% surface, `--shadow-material`). Both
  carry a bright top hairline (`--color-glass-edge`). Bigger surfaces read thicker. Never
  stack one on the other — solid chips (buttons, inputs) are what sits *on* glass. The
  topbar closes with `edge-fade` (a soft gradient) rather than a 1px rule.
- **Type ramp, not px.** Nine rem steps — `text-label` (10.5px) · `tiny` · `mini` ·
  `small` · `body` · `copy` · `title` · `display` · `hero` (20px) — each with its own
  tracking and leading: `+0.06em` at the uppercase micro end down to `-0.022em` at the
  display end. Spacing that has to scale with text is rem/em too. **The SVAR widget keeps
  px sizes** (`--wx-font-size` etc.): its column widths are content-box px set in JS, so
  scaling its body text would clip cells.
- **Three accessibility signals, all mandatory.** `prefers-reduced-motion` swaps scale for
  a cross-fade and turns the press into a brightness step; `prefers-reduced-transparency`
  raises opacity and drops every `backdrop-filter` (required — the app has real blur now);
  `prefers-contrast: more` goes near-solid with `--color-ink` borders. These blocks live
  **unlayered** at the bottom of `style.css` and `wx-overrides.css` so they outrank the
  layered Tailwind utilities that set background/border on the same elements.
- **Focus is never the unstyled state.** `FOCUS` (a shared class string in `app.jsx` /
  `Login.jsx`) is spelled into every interactive recipe; widget-owned controls get
  `:focus-visible` rules in `wx-overrides.css`.
- The Who picker is a **controlled** `Popover.Root` keyed on the task id, anchored to the
  tagger-built cell via `positioning.getAnchorRect`. The key forces a remount so Ark
  re-measures instead of reusing the previous row's placement; the stored rect is the
  fallback for when the widget re-renders the cell away.
- **Icons: components first, masks only where SVAR renders the element.** Everything the
  app renders is a `@phosphor-icons/react` component — in JSX for the header and popovers,
  and through `src/icons.jsx` for the nodes the tagger builds (type icons, row pencil,
  fold-all chevron, the Who "+"). `icons.jsx` renders each glyph once into a detached
  React root and caches the SVG string; the tagger re-runs on every mutation, so it must
  never render per row. It deliberately avoids `react-dom/server`, which costs ~220 kB in
  the shared chunk. The **only** CSS-drawn icons are the `<i class="wxi-…">` elements SVAR
  injects itself: no React slot exists there, so `icons.css` masks them, with the `url()`
  pointing straight at `@phosphor-icons/core/assets/**.svg` so Vite inlines the installed
  package's own files at build time. There is no icon generation script and no glyph data
  committed here — don't reintroduce either, and don't convert the tagger glyphs back.

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
  supplies its own faces and passes `fonts={false}` to Willow. Keep that plugin's
  `enforce: "pre"` and keep it ahead of `tailwindcss()` in the plugin list.
- Stylesheet import order in the entries is load-bearing: `style.css`, then
  `@svar-ui/react-gantt/all.css`, then `wx-overrides.css` and `icons.css`.
- PDF export uses jsPDF's plain browser download: `buildGanttPdf(...)` returns the doc
  and the caller calls `doc.save(name)`.
- The artifact integration is gone: no `window.claude`, no `mcp`/`downloads`/`publish`
  capability, no `view_page`/`view_chunks` template chunking. Don't bring any of it back.
