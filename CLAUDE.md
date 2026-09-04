# Gantt — project context for Claude

Personal Gantt chart tool: a Vite + React SPA on SVAR react-gantt, routed with TanStack
Router, persisted through TanStack Query, styled with Tailwind CSS v4 + Ark UI + Phosphor
icons, talking straight to cloud Supabase. Read README.md for the full architecture. Key
facts and hard-won gotchas below.

## Deployed pieces

- GitHub Pages under base path `/gantt/`. **One HTML entry** (`index.html` → `src/main.tsx`)
  serves every route; the share page is a lazily loaded route, not a second entry.
  Build with `bun run build` and publish `dist/`. There is no `docs/` folder any more.
- **`dist/404.html` is a copy of `dist/index.html`**, written by the `pages-404-fallback`
  plugin in `vite.config.ts`. GitHub Pages has no SPA rewrite, so without it a hard
  refresh on `/gantt/p/<id>` 404s. `vite dev` and `vite preview` both rewrite to
  index.html on their own, so this only ever breaks in production — don't drop the plugin
  because "deep links work locally".
- Supabase project "Gantt": id `wouvkkaxehwuhtgpersx` (org "Personal"),
  https://wouvkkaxehwuhtgpersx.supabase.co — **cloud only, never run a local stack.**
- Edge Function `shared` (verify_jwt: false, source in `edge/shared/index.ts`):
  `?raw=1` returns `{active, projects, tasks, links, people}` as JSON with CORS `*`;
  the payload is assembled by the SECURITY DEFINER SQL function `public.share_feed`, so
  **a new task column only reaches the viewer once that function names it** — `release`
  does not yet (see "Release scope" below for the one-line SQL);
  optional `&owner=<uuid>` narrows it. Without `?raw` it returns a pointer note.
  **The user deploys it — don't.**
- The user owns all Supabase deploys and migrations. Never apply SQL, never deploy
  the function, never commit or push.

## Folder structure (feature-first)

```
src/
  main.tsx            one entry: router + query client + the four stylesheets, in order
  routeTree.gen.ts    generated, committed, @ts-nocheck'd
  routes/             THIN route definitions only — no business logic lives here
  app/                AuthedShell: the layout behind the gate, mounts StoreProvider
  features/
    auth/             api/ (every supabase.auth.* call) · components/ (4 pages + card
                      chrome) · hooks/ (session redirects, recovery session) · lib/
                      (field validators)
    gantt/            Editor · ShareViewer · pdf · icons · lib/ (render-icon,
                      wxi-masks, tracker, taxonomy)
    people/           roster.ts — the assignee helpers both gantt screens share
    projects/         store.tsx — the snapshot/draft write model and project CRUD ·
                      ProjectsPage.tsx (the `/` list) · summary.ts (per-project totals,
                      type-only imports so it stays free of supabase)
  lib/                supabase client · db.ts (all persistence) · database.types.ts
  styles/             style.css · wx-overrides.css · icons.css
```

Two deliberate departures from a strict feature split, both because the alternative
would have been a rewrite rather than a move:

- **`lib/db.ts` stays whole and shared.** It is one persistence layer (fetchStore /
  saveStore diff over every table at once), and the shared domain types (`TaskId`,
  `StoreTask`, `StoreLink`, `StoreProject`, `StoreData`, `Person`) live there. Splitting
  it per feature would mean splitting the diff, which is the one thing that must stay in
  one place. `features/projects/store.tsx` is the React layer over it.
- **The people roster UI stays inside `features/gantt/Editor.tsx`.** The People popover,
  the Who column and its picker are woven into the MutationObserver row tagger. Only the
  genuinely standalone part moved to `features/people/roster.ts` — `parseAssignees`,
  `initialsOf`, `nameHue`, which the editor and the viewer each had a byte-identical copy
  of. `features/gantt/lib/tracker.ts` is the same story for `trackerId`.

`features/people/roster.ts` and everything under `features/gantt/lib/` are imported by
`ShareViewer.tsx`, so **none of them may import from `lib/`** — that would drag the
Supabase client onto the public page. `features/gantt/lib/taxonomy.ts` is the newest
member of that set: the tier list, the release scopes, the tier↔widget mapping and the
filter predicate, shared by the editor, the viewer, the PDF, the projects list **and the
`/p/$projectId` route file** (which validates the filter out of the URL and therefore must
not reach supabase either).

## Build

- Toolchain is Bun (`bun install`, `bun.lock`). Node is not installed and
  `/opt/homebrew/bin` is not on PATH by default — prefix shell commands with
  `export PATH=/opt/homebrew/bin:$PATH`. `node_modules/.bin/tsc` is a Node shim, so
  run the compiler through Bun (`bun run typecheck`, not `./node_modules/.bin/tsc`).
- `bun run dev` (Vite, http://localhost:5173/gantt/) runs the real app against cloud
  Supabase. `bun run build` → `dist/` (one entry + `404.html`). `bun run preview` serves it.
- `src/routeTree.gen.ts` is **generated** by `@tanstack/router-plugin` on every `dev` and
  `build`, and committed. `bun run typecheck` reads it, so on a fresh clone run
  `bun run build` once before the first typecheck. Never edit it by hand.
- `.env` (gitignored) holds `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`,
  read via `import.meta.env`. Never hardcode or commit the values.
- There is no test suite. `bun run typecheck` is the only automated check — verify
  behaviour by hand in `bun run dev` and styling in `bun run build && bun run preview`.

## TypeScript

- Everything under `src/` is `.ts`/`.tsx` with **`strict: true`**. There are no `.js`
  or `.jsx` files left in the app; don't add any.
- Two configs, and `bun run typecheck` runs `tsc --noEmit` over both:
  `tsconfig.json` (`include: ["src"]`, `types: ["vite/client"]`, `jsx: "react-jsx"`,
  `moduleResolution: "bundler"`) and `tsconfig.node.json` (`include: ["vite.config.ts"]`,
  `types: ["node"]` for `import.meta.dirname` and `"path"`). Keeping them apart is what
  stops the browser code from seeing Node globals. `edge/shared/index.ts` is Deno source
  outside the Vite build — it belongs to **neither** config; don't pull it in.
- Imports inside `src/` are **extensionless** (`../../lib/db`, `./icons`). `./icons.jsx`
  would not resolve now, and `./icons.tsx` is not something Vite likes in source.
- Vite/esbuild only strips types, so a type error never fails `bun run build`. The
  typecheck is the gate.
- `src/vite-env.d.ts` holds the global augmentations: the `VITE_*` env vars,
  `window.__ganttProbe`, `HTMLElement.__root` (the cached React root on the mount
  container) and `--*` custom properties on `React.CSSProperties` (the `--who-hue`
  chips). Add global declarations there, not inline.
- Shared domain types live in `src/lib/db.ts` (`TaskId`, `StoreTask`, `StoreLink`,
  `StoreProject`, `StoreData`, `Person`); `features/gantt/Editor.tsx` and
  `features/gantt/pdf.ts` import them.
  `ShareViewer.tsx` deliberately keeps its own `ViewTask`/`ViewLink`/`Feed` shapes — it
  must not import from `lib/` at all, because that would drag the Supabase client into
  the public page.
- The generated route tree carries `// @ts-nocheck`, but the routes you write are fully
  checked: `main.tsx` registers the router through `declare module "@tanstack/react-router"`,
  so a wrong `to:` or a missing param is a type error.

## Routing (TanStack Router, `basepath: import.meta.env.BASE_URL` = `/gantt/`)

File-based routes in `src/routes/`, `autoCodeSplitting: true`.

| Route | File | Purpose |
| --- | --- | --- |
| `/login` | `routes/login.tsx` | sign in (email + password); `beforeLoad` redirects to `/` when a session already exists |
| `/signup` | `routes/signup.tsx` | create an account; same redirect |
| `/forgot-password` | `routes/forgot-password.tsx` | request a reset email; same redirect |
| `/reset-password` | `routes/reset-password.tsx` | set a new password from the emailed link — **no redirect**, see below |
| `/` | `routes/_authed/index.tsx` | the projects list (`features/projects/ProjectsPage.tsx`): every project the account owns, and where they are created, renamed, duplicated and deleted; with no projects, an empty state and a **New project** button |
| `/p/$projectId` | `routes/_authed/p.$projectId.tsx` | the editor, deep-linkable, with three validated search params: the filter's `?type=`, `?rel=`, `?who=` (see Filtering). `?view=` is **gone** — see The timeline scale |
| `/share/$projectId` | `routes/share.$projectId.tsx` | public read-only viewer — no auth, no Supabase client |
| `/share` | `routes/share.index.tsx` | the same viewer on the feed's active project, so links handed out before the viewer was deep-linkable still work |

- **The auth gate is a `beforeLoad` redirect**, not a conditional render: the pathless
  layout `routes/_authed.tsx` resolves the session and throws `redirect({ to: "/login" })`.
  Its component (`src/app/AuthedShell.tsx`) mounts `StoreProvider` once, so switching
  projects navigates without reloading the store.
- Consequence of the gate being a redirect: **nothing re-renders on sign-in by itself.**
  `useRedirectWhenSignedIn()` (in `features/auth/hooks/useSessionRedirect.ts`) subscribes
  to `watchSession` and navigates to `/` when a session turns up — from a form, from a
  sign-up that returns one, or from another tab — and `useRedirectWhenSignedOut()` in
  `AuthedShell` does the mirror image. `/login`, `/signup` and `/forgot-password` all use
  the first. Remove either and the user signs in successfully and stays on the login
  screen.
- **`/reset-password` uses neither hook and has no `beforeLoad` redirect.** It is
  *reached with* a session — the recovery one the emailed link carries — so bouncing on a
  live session would make it unreachable. Adding the redirect "for consistency" breaks
  password reset entirely.
- **No route file may import `lib/supabase` (or anything reaching it) at the top level.**
  The route tree is eager — it is what decides which route matches — so a static import
  there puts supabase-js in the entry bundle and ships it to the public `/share` pages.
  `src/features/auth/api/auth.ts` is the seam: it is imported statically by the route
  files and `await import("../../../lib/supabase")`s inside each function, which is what
  puts the client in its own chunk. The auth *components* never touch supabase-js either
  — they call that module. (The old `src/Login.tsx` broke this rule with a top-level
  `import { supabase }`.) Verify after any route change with
  `bun run build` and a look at whether `assets/index-*.js` references the supabase chunk
  through `import(...)` only.
- The URL is the source of truth for which project is open. `app_state.active_project` is
  only "last opened", written by `p.$projectId` on mount; `/` marks that card **Last
  opened** and nothing redirects on it. It used to: `/` forwarded to that project, which
  is exactly why a projects list could not exist — the route that would have shown it
  always bounced. Don't put the redirect back.
- **The editor has no project switcher.** The dropdown of every other project (an Ark
  `Menu` with a hover-revealed delete inside it) is gone; `/` is the list, and the mark at
  the editor's top left is a `<Link to="/">` back to it. There is no `SegmentGroup` in
  `Editor.tsx` at all any more — the Day/Week/Month scale went with it. The link calls `scheduleSave()`
  on click so the debounce still in flight is not lost on the way out.
- The viewer's project segments **navigate**; they do not set state. The editor is keyed
  on `projectId`, so opening another project remounts it with a clean widget, undo stack
  and row tagger.

## The timeline scale, and the header

There is **one scale: days.** The Day / Week / Month `SegmentGroup` is gone from the editor
and from the public viewer, and with it `?view=` on `/p/$projectId`. Consequences worth
knowing before "restoring" any of it:

- **`?view=` is not in the route's search schema any more.** `validateSearch` BUILDS the
  search object rather than checking it, so an old bookmarked `?view=week` is dropped on
  the way in and the editor opens normally. It is not an error.
- **`projects.view` stays in the schema and is left exactly as stored.** Nothing writes it
  now and nothing reads it, so removing the switcher dirtied no project row. There is no
  migration.
- **`pdf.ts` keeps its own day/week/month logic and must.** It picks the unit from the
  project's span (`spanDays <= 62 ? day : <= 260 ? week : month`), because a nine-month
  timeline drawn in day columns is unreadable on A4. That has nothing to do with this UI.

The header is two groups, not one run: identity on the left — back link, the project's
name, and a quiet second line under it carrying the save state, the filter pill and the
totals — and the actions on the right. It used to be nine controls and an eight-fact stats
string at the same weight on one row, in which the project's own name was the thing that
got clipped to four characters and "Export PDF" / "Sign out" wrapped onto a second line.
What holds it together now:

- the identity block is `flex-1 min-w-0` and the actions `flex-none`, so the title takes
  what is left and ellipsizes rather than pushing controls off a page that cannot scroll;
- **Share and Export PDF are icon-only** (`BTN_ICON`) and carry `aria-label` AND `title` —
  an icon-only control with no accessible name was a review finding, don't reintroduce it;
- People / Filter / Sign out drop their LABEL below 1080px (`max-[1080px]:sr-only`), never
  the control; the back link's label goes at 900px;
- the stats line sheds its least important segments first — the date span below 860px, the
  epic/story counts and the unscoped total below 1180px — so effort and the MVP/Full split
  survive to ~700px instead of the whole line vanishing at 1100 as it used to.

Verified at 700 / 960 / 1114 / 1440: one row of controls, all six present and inside the
viewport, header 62px, title never clipped. Below ~760px the fixed `gridWidth` pushes the
chart off-screen — that is the widget's own layout, not the header's, and is what SVAR's
draggable resizer is for.

## Auth (`src/features/auth/`)

Four separate pages, one per job — there is no `mode` toggle any more. Forms are
`@tanstack/react-form` v1: `useForm({ defaultValues, onSubmit })`, `<form.Field>` with
`validators`, `<form.Subscribe selector={(s) => s.isSubmitting}>` for the busy state.
Ark UI `Field` supplies the label/error wiring; validators live in `auth/lib/validate.ts`
and errors are narrowed through `firstError()` (TanStack types an error as whatever the
validator returned, which is wider than `ReactNode`).

- **`api/auth.ts` is the only module in the app that calls `supabase.auth.*`** — sign in,
  sign up, reset request, password update, sign out, session watch, recovery session. All
  behind `await import("../../../lib/supabase")`; see the routing rule above.
- `authErrorMessage()` rewrites the two Supabase strings the user can act on ("Invalid
  login credentials", "Email not confirmed") and passes everything else through.
- **Sign-up with confirmation on returns no session.** `signUp()` reports
  `needsConfirmation: !data.session`, and the page switches to a "check your inbox" state
  instead of pretending the account is usable.
- **The reset request never reveals whether an account exists.** Same neutral message
  either way — this screen is the only thing that could turn the app into an account
  enumerator.
- Password floor is Supabase's own **6 characters** (`PASSWORD_MIN_LENGTH`), enforced
  client-side *and* surfaced from the server if it disagrees.

### The password-reset round trip

1. `/forgot-password` calls `resetPasswordForEmail(email, { redirectTo })`.
2. `redirectTo` comes from `resetRedirectUrl()`:
   `new URL(import.meta.env.BASE_URL + "reset-password", location.origin)`. That resolves
   to `http://localhost:5173/gantt/reset-password` in dev and
   `https://ingaleokot.github.io/gantt/reset-password` in production — **never hardcode
   either.** Verified: the request goes out as
   `POST /auth/v1/recover?redirect_to=<that URL>`.
3. **Supabase only honours a `redirectTo` it recognises.** Both URLs must be in
   Authentication → URL Configuration → Redirect URLs in the dashboard, or the mail
   arrives pointing at the project's Site URL and the flow dead-ends. That is a
   project-settings change — the user makes it, not us.
4. The link goes to `/auth/v1/verify`, which redirects to that URL with the token in the
   **URL fragment**. `lib/supabase.ts` is created with **`detectSessionInUrl: true`** (it
   used to be `false`) precisely for this: importing the client is what exchanges the
   fragment for a session, emits `PASSWORD_RECOVERY` and scrubs the URL.
5. `hooks/useRecoverySession.ts` covers both orderings — `getSession()` (which awaits the
   client's own initialisation) and a late `PASSWORD_RECOVERY` event. An expired or
   reused link produces neither, arriving instead as `#error=…&error_code=otp_expired`,
   which `recoveryLinkError()` reads with no client at all.
6. `updateUser({ password })` sets it (`PUT /auth/v1/user`), the two boxes are validated
   as a matching pair, and the page ends in a success state.

## Data model (Supabase is the only store — no localStorage, no static data)

Tables: `projects(id,name,view,position,owner)`, `tasks(id, project_id FK, parent_id
self-FK, text, type, start_date, end_date, duration, hours, days, progress, details,
open, sort_order, url, status, assignees, release)`, `links(id, project_id, source,
target, type)`, `people(id,name,position,owner)`,
`app_state(id='main', active_project, owner)`.

- **RLS is owner-scoped.** Every insert of `projects`, `people` and `app_state` must set
  `owner = session.user.id` or the write is rejected. `tasks`/`links` inherit ownership
  through `project_id` — they have no owner column, don't add one.
- `tasks.assignees` is a comma-separated list of `people.id`.
- `tasks.type` is **plain text with no check constraint** — which is why adding the
  `story` tier needed no migration.
- `tasks.release` is `text null`, guarded by
  `tasks_release_check: release is null or release in ('mvp','full')` and indexed by
  `tasks_release_idx on (project_id, release) where release is not null`. Only the two
  container tiers ever carry one.
- All persistence lives in `src/lib/db.ts` as supabase-js table queries. There is no SQL
  string building anywhere — don't reintroduce it.
- `src/lib/database.types.ts` is **generated** from the live cloud project and committed;
  `src/lib/supabase.ts` passes it to `createClient<Database>(…)` so every `.from("…")`
  is checked against the real columns. Regenerate after any migration with
  `supabase gen types typescript --project-id wouvkkaxehwuhtgpersx > src/lib/database.types.ts`
  (or the Supabase MCP `generate_typescript_types` tool). Never hand-edit it.
- Foreign keys (checked against the live schema): `tasks.project_id`, `links.project_id`,
  `links.source`, `links.target` and `tasks.parent_id` are all **ON DELETE CASCADE**;
  `app_state.active_project` is ON DELETE SET NULL. So deleting a project takes its tasks
  and links with it, and deleting a task takes its children and its links.
- `tasks` carries a self-FK, so `db.ts` sorts rows parents-first before inserting.

## Three tiers: epic → story → task

`TASK_TYPES` lives in `features/gantt/lib/taxonomy.ts` (not in `Editor.tsx` any more) and
is the list `tasks.type` may hold: `task`, `backend`, `frontend`, `design`, `testing`,
**`story`**, `summary` (labelled "Epic"), `milestone`. A story lives inside an epic and
contains items of its own.

**The seam, and the bug it exists to prevent.** SVAR's widget makes a row a PARENT — tree
toggle, rolled-up bracket bar — only when its `type` is exactly `"summary"`. There is no
second parent type and no way to add one (checked: the shipped types expose nothing, and
`summary.autoConvert` only edits the context menu's Convert list; the store never rewrites
a `type` by itself — `rollupEpics` is this app's only auto-converter). So:

```
stored in Postgres    tasks.type = "story"
handed to the widget  type = "summary"  +  kind = "story"
```

`kind` is a **widget-only field**: `prepareTasks` writes it on the way in, `cleanTask`
turns it back into `type` on the way out and deletes it, and it never appears in a
database row. `effectiveType(type, kind)` in `taxonomy.ts` is the ONLY place the mapping
lives; `kind` wins whenever it names a tier.

`prepareTasks` used to read

```ts
if (parents.has(r.id) && r.type !== "summary") r.type = "summary";
```

— it overwrote the stored type in place, and because `cleanTask`'s `KEEP` list
round-trips `type`, the coercion was **written back to Postgres**. Every story would have
become an epic permanently on the next save. Verified against a stubbed PostgREST: a
project containing a story loads, rolls up and saves with `type: "story"` intact, and
`kind` appears in no request body.

Everything downstream reads the tier, never the raw type:

- **the row tagger** — `is-epic` / `is-story` on the row, `in-epic` (nesting connector) +
  `in-story` (its colour) on rows underneath one, `ti-story` for the icon, `band-story`
  for the chart band, `is-story` on the bar;
- **`rollupEpics`** — both tiers are containers, both recurse, so an epic of stories of
  tasks totals its tasks exactly once. A tier contributes no effort of its own, and a
  CHILDLESS tier keeps whatever estimate it has (the roll-up would otherwise erase it and
  the update-task intercept would refuse to let it back in);
- **`computeStats`, `features/projects/summary.ts`, `pdf.ts`** — all three count epics and
  stories separately, give neither any effort of its own, and ignore both when measuring
  the project span.

**An empty tier that is NESTED is drawn as a plain bar.** SVAR's date roll-up
(`normalizeDates` → `getSummaryDates`) recurses into every descendant of a dateless
summary and throws *"Summary tasks must have start and end dates if they have no
subtasks"* the moment it reaches a container with nothing in it — the empty row's own
dates do not save it, and neither do its parent's. (This is why a nested empty epic was
already fatal before stories existed; it is simply much easier to reach now.) So
`prepareTasks` hands an empty NESTED tier over as `type: "task"` while `kind` keeps saying
which tier it is: the row still shows its icon, rail and release marker, the stored type
is untouched, and it becomes a summary again the moment it gains a child. A **top-level**
empty tier is not reachable by that recursion and keeps the behaviour it always had —
explicit start/end dates, invented if it has none.

The editor modal's Type select is bound to **`kind`**, not `type` — a select bound to
`type` would show every story as "Epic". The `update-task` intercept derives `type` from
whichever of the two arrives (the modal sends `kind`, the context menu's Convert list
sends `type`) and keeps them in step, before any other branch reads `merged.type`.

### Release scope (MVP / Full release)

`tasks.release` is `null | "mvp" | "full"` and only the two container tiers carry one. A
leaf task **inherits** the scope of the nearest tier above it (`scopeOf` in `taxonomy.ts`)
— without that, filtering by MVP would show the marked epics and none of the work in them,
and "what does MVP cost" would always be zero.

- **modal**: a "Release scope" select, hidden unless the row is a tier (`isHidden` reads
  the tier, not the drawn type, so an empty nested story is still scopeable). The empty
  option is `""`, which `db.ts` maps back to a NULL column.
- **grid**: a **Scope column** of its own (`{ id: "scope", width: 72 }`, second in
  `COLUMNS` in both gantt screens), filled by the row tagger with a `.release-tag` pill.
  It used to be appended after the task NAME, in a cell that already carried the tree
  toggle, the type icon, the status dot, the text and the edit pencil. Every row in scope
  is tagged now, not only the tier that owns it — solid on the owner, ghosted (`rel-soft`)
  on the rows that inherit — which is the same distinction the PDF's SCOPE column draws
  with bold and regular, and what makes the column readable as a column. `gridWidth` grew
  by 48 rather than the column's full 72, so the chart gives up less than the column
  costs; the widget's own draggable resizer is how a narrow window is rebalanced.
  `gridWidth` is deliberately a CONSTANT: SVAR re-runs `init(config)` on any prop change,
  so one that tracked the window would re-initialise the store — and drop the filter — on
  every resize tick.
- **the Scope column header hosts the release filter.** A tagger-appended `.col-filter`
  button (append-only, positioned by CSS, `pointerdown` stopped, and the column declared
  `sort: false` so there is nothing for it to fight) opens a controlled Ark `Popover`
  anchored through `getAnchorRect` — the same bridge the Who picker uses, because React
  cannot render inside a header cell the widget owns. It is a SECOND entry point to the
  release dimension, not a replacement: the header's Filter popover still holds all three.
- **totals**: `releaseTotals()` groups leaf effort by inherited scope — see MVP ⊂ Full
  below for what the four numbers mean and how they are worded.
- **PDF**: a 16 mm SCOPE column between ID and START — bold and coloured on the tier that
  owns the scope, muted on the rows that inherit it — plus the same release line the
  editor header shows, drawn under the meta line from `releaseSummaryText`.
- **share viewer**: `release` is read from the feed if present. **It is not there yet.**
  `public.share_feed` builds the JSON column by column, so until the owner adds
  `'release', t.release,` next to `'status', t.status,` in that function every shared row
  reads as unscoped — which the viewer handles silently rather than breaking. That is a
  migration; **the user applies it, not us.**

### MVP is a subset of the full release

`mvp` and `full` are **not two disjoint buckets**. Marking a tier `mvp` says "this ships in
the MVP", and everything in the MVP also ships in the full release; marking one `full` says
"this ships in the full release and NOT in the MVP". Everything reads that rule from
`taxonomy.ts` rather than restating it, so no screen can disagree:

- `releaseMatches(selected, scope)` is what `makeFilter` uses. Filtering by **Full release
  returns the MVP rows too**; filtering by MVP does not return full-only rows.
- `ReleaseTotals` is `{ mvp, fullOnly, fullRelease, unscoped }`. There is deliberately **no
  field called plain `full`** — that name is exactly what made "MVP 21h · Full 7h" read as
  two buckets that fail to add up. `fullRelease` is `mvp + fullOnly`.
- `releaseSummaryText()` is the one wording, used verbatim by the editor header, the public
  viewer, the projects cards and the PDF: **"MVP 56h · Full 98h incl. MVP · unscoped 65h"**.
  The "incl. MVP" is dropped only when there is no MVP effort to include.
- `RELEASE_INCLUSION_NOTE` ("Full release includes everything marked MVP.") is printed
  under the Release chips in **both** filter popovers, on screen — never a tooltip. A user
  who filters by Full and sees MVP rows come back would otherwise read it as a bug.
- The editor modal's own Release-scope select does NOT use those labels: there the ids are
  being *assigned*, so it reads "MVP — also in the full release" and "Full release only —
  not in the MVP".

## Filtering (type · release · who)

An Ark `Popover` in the editor header, with three multi-select groups ANDed together, and
a second entry point to the release dimension on the Scope column's header. The state is
three validated search params on `/p/$projectId` —
`?type=story,backend&rel=mvp,none&who=h1,none` — so a filtered timeline
is a link. `type` and `rel` are validated against the known ids; `who` can only be checked
for SHAPE at the route (the roster is not loaded there), so the editor drops ids nobody
holds any more via `usableFilter` — a stale person in a URL is ignored, never fatal.

**A filter must never cause a write, and here is why it structurally cannot.** The editor
serializes the widget into the draft on every change, and `saveStore` emits a **DELETE**
for any row that is in the snapshot and not in the draft. Handing the widget a reduced
dataset would therefore delete every filtered-out task on the next save. Nothing reduces
the dataset:

- the filter is applied through SVAR's own `api.exec("filter-tasks", { filter, open })`,
  which calls `tree.filterTree()`. That does exactly one thing: it records the set of ids
  that should be VISIBLE (`_filteredIds`);
- `tree.toArray()` (the rendered rows, both halves of the widget) honours it, so the grid
  and the chart stay in step by construction;
- `tree.serialize()` — which is what `api.serialize({data:"tasks"})` returns, and
  therefore what every save, roll-up, header total and undo entry is built from — walks
  the full pool and never looks at it.
- **`open: false` is deliberate.** With `open: true` the library sets `task.open = true`
  on every ancestor of a match; `open` is a persisted column, so merely applying a filter
  would have dirtied rows. The cost is that a collapsed epic containing a match stays
  collapsed — the epic itself is still shown.

Verified against the stubbed PostgREST: applying, changing and clearing filters issues
**zero requests of any kind**; an edit made while a filter hides three of seven rows emits
exactly one `PATCH /tasks?id=eq.…` and no delete; all seven rows are still stored
afterwards; and undo/redo round-trips the full set while filtered.

Ancestors of a match stay visible — that is SVAR's own tree walk (a branch survives when
any descendant survives) and it is the rule this app wants: hiding an epic whose story
matched would orphan the row. Children of a match are NOT implied; each row answers for
itself.

Two more rules the review left behind: the header totals and the roll-ups always report
the **whole project** (a number that silently changed meaning under a filter would be
worse than no number), and an empty result gets its own overlay saying all N rows are
still there, with a Clear button — never a blank chart. `runFilter` is also re-run from
the widget's own change events (a row added while a filter is on is not in the visible set
yet), and an `appliedRef` keeps an unfiltered editor completely inert.

The viewer has the same control on local state: `/share/$projectId` takes no search params
today, so a filtered view there is not a link.

## The write path: snapshot + diff, never a wipe

`src/features/projects/store.tsx` owns it. Two pieces of state:

- **the snapshot** — React Query `["store"]`, loaded once by `fetchStore()`. It is
  *what Postgres actually holds*, and it is only replaced when a write succeeds.
- **the draft** — `draftRef` inside `StoreProvider`, seeded from the first successful
  load. The editor serializes the SVAR widget into it on every change (synchronously),
  and the roster and project names are edited on it directly.

`scheduleSave()` debounces 1400 ms and then runs the `sync` mutation, which diffs draft
against snapshot (`saveStore` in `db.ts`) and emits only the rows that differ:

- new row → `insert` (tasks ordered parents-first)
- one changed row → `update(...).eq("id", id)`
- several changed rows → **one `upsert` of exactly those rows** — this is the path epic
  roll-ups, `sort_order` rewrites and snapshot undo/redo take
- removed row → `delete().in("id", deadIds)`, and never anything else

Order inside a save is load-bearing: inserts, then updates, then deletes. A task dragged
out of an epic has to be re-parented *before* the epic row is dropped, or the cascade
takes it along.

Explicit user actions are their own mutations rather than something the diff infers:
`insertProject`, `deleteProject`, `setActiveProject`. All the write mutations share
`scope: { id: "gantt-store-write" }` so they queue instead of racing each other's
snapshot.

**Why this replaced the old code.** `dbSave` used to `delete().in("project_id", ids)` on
`links` and `tasks` and re-insert everything, on a debounce, while the user typed. Adding
one task deleted every task in every loaded project; a failure or a closed laptop between
the delete and the insert lost the lot. Nothing may go back to that shape:

- **no `delete()` filtered by anything but `id`** — there are exactly two `.delete()`
  calls in `src/`, both keyed by row id;
- **`saveStore` refuses to run without a snapshot** (`if (!draft || !prev) throw`).
  Without one every row looks new and every stored row looks deleted;
- the draft and the snapshot must never share objects — `cloneStore` on the way into the
  cache is what keeps the next diff honest.

Ids compare through `key()` (`String(id)`), because SVAR mints ids the text columns store
back as strings. Comparing raw would re-insert every in-session row on the next save.

## The projects page (`/`)

`features/projects/ProjectsPage.tsx` is the front door. It talks to nothing itself —
create, rename, duplicate and delete are all `store.tsx` mutations — and
`features/projects/summary.ts` computes each card's counts, effort and span from the
draft, with **type-only imports from `lib/db`** so it stays free of the Supabase client.

Two projects can share a name (the account really does have two "Viory — New platform /
MVP"), so the card carries what tells them apart: tasks, epics, stories, effort, the
release split (`releaseSummaryText`: "MVP 56h · Full 98h incl. MVP", or "Not scoped"),
the date span and its length, plus
the year on any date outside the current one. `summary.ts` counts the
way the editor's own header does — an epic contributes no effort of its own (its hours
are the roll-up of its children) and a milestone is neither a task nor effort — so the
list and the editor never disagree.

Rules the interaction review left behind, all load-bearing in the markup:

- **nothing is hover-revealed.** Duplicate and delete are always-visible icon buttons
  with an `aria-label` that names the project (and, for duplicate, how many rows it will
  copy). The old switcher hid delete behind `group-hover`, which does not exist on touch.
- **the destructive step says what it costs** — "…and everything in it — 4 rows,
  including 2 tasks and 1 epic?" — as a two-step confirm inside the card, with focus
  moved to **Keep it**, and Escape backing out.
- **no silent no-ops.** Writes queue on one mutation scope, so while any row is mid-write
  every card's actions are disabled rather than swallowing the click; an emptied name
  falls back to "Untitled project" on blur rather than vanishing.
- **the header wraps** instead of overflowing, and the list scrolls — the editor header's
  own failure below 1100px is not repeated here.

### Duplicating a project

`duplicateProject(id)` in `store.tsx`. It is not a server-side copy and it touches
nothing that already exists — it is the ordinary write path, given rows:

1. `flushSave()` first, so the copy is made from what Postgres actually holds; if that
   fails the user is asked before a copy is taken of an older version.
2. `copyRows()` mints a **fresh id for every task and link** and rewrites `parent`,
   `source` and `target` through that map. This is the part that matters: a copy still
   pointing at the original's rows would re-parent them on the first save, and deleting
   the copy would then cascade into the original. Links that lost an endpoint are
   dropped, and `sortOrder` is stripped — it records what Postgres holds for a row that
   has never been stored.
3. `copyName()` gives "Plan copy", then "Plan copy 2" — a list that already has duplicate
   names must not gain two identical copies.
4. The project row goes in through the same single `insertProject` a new project uses
   (with `owner`, or RLS rejects it); its tasks and links go into the **draft only**, and
   the snapshot gets a mirror project with no rows under it. So the next diff sees them
   as the inserts they are — `parentsFirst` orders them for the tasks self-FK — and a
   copy interrupted halfway retries itself instead of leaving half a project behind.

Verified against a stubbed PostgREST: one duplicate emits exactly `POST projects` (1
row), `POST tasks` (4 rows, epic first), `POST links` (1 row), and **no delete of any
kind**.

## Styling layer (Tailwind v4 + Ark UI + Phosphor)

- **One token source.** `src/styles/style.css` is the Tailwind entry and holds every token in a
  single `@theme static` block: `--color-*`, `--font-*`, the `--text-*` ramp, `--shadow-*`,
  `--ease-*`, `--dur-*`, `--animate-rise`. `static` is load-bearing: `wx-overrides.css`
  reads those tokens through `var(--color-…)` / `var(--dur-…)`, and Tailwind cannot see
  uses in another stylesheet, so without it they'd be tree-shaken. There is **no
  `tailwind.config.js`** — v4 configures from CSS.
- **`@source "../";` at the top of `style.css` is load-bearing too.** The stylesheets live
  in `src/styles/`, and automatic source detection would start from there and find nothing
  but CSS. That line points the scanner at `src/`, which is the whole surface — index.html
  carries no utility classes. Drop it and every utility silently vanishes from the build.
- New tokens keep to the same rule: `--color-story-row` / `--color-story-rail` (the story
  tier's wash and rail) and `--color-release-mvp[-bg]` / `--color-release-full[-bg]` (the
  two release pills) are declared in all three theme blocks. The pills themselves are the
  `.release-tag` rules in `wx-overrides.css` — written bare AND scoped, like `.who-chip`,
  because the same markup appears inside the grid (tagger-built) and in JSX.
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
- Ark owns the shell primitives: `Popover` (Share, People, Who picker, Filter, the Scope
  column's release filter), `Field` (login). `SegmentGroup` and `Menu` are no longer used
  anywhere — it was the editor's project switcher.
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
- **Focus is never the unstyled state.** `FOCUS` (a shared class string in `Editor.tsx` /
  `Login.tsx`) is spelled into every interactive recipe; widget-owned controls get
  `:focus-visible` rules in `wx-overrides.css`.
- The Who picker is a **controlled** `Popover.Root` keyed on the task id, anchored to the
  tagger-built cell via `positioning.getAnchorRect`. The key forces a remount so Ark
  re-measures instead of reusing the previous row's placement; the stored rect is the
  fallback for when the widget re-renders the cell away.
- **Icons: one package, `@phosphor-icons/react`, and nothing else.**
  `@phosphor-icons/core` (the raw-`.svg` half of the set) used to be a second dependency
  feeding `icons.css`'s `mask-image: url(...)` rules. It is **gone** — don't add it back,
  and don't reach for any other icon package.
  Three mechanisms, all sourced from that one package:
  1. **JSX components** for everything the app renders itself — header, popovers, the
     auth cards.
  2. **`features/gantt/icons.ts`** for the nodes the MutationObserver tagger builds in
     plain JS (type icons — including `ti-story`, an open book that shares no silhouette
     with the epic's crown at 15px — the row pencil, the fold-all chevron, the Who "+"). Each glyph is
     rendered once through `lib/render-icon.ts` — a single detached React root plus
     `flushSync` — and its markup cached at module scope. The tagger re-runs on every
     mutation, so it must **never** render per row: that is what the cache and the
     `__glyph` guard are for. It deliberately avoids `react-dom/server`, which would cost
     ~220 kB in the shared chunk.
  3. **`features/gantt/lib/wxi-masks.ts`** for the ~31 `<i class="wxi-…">` elements SVAR
     injects itself. There is no React slot there (checked: SVAR's shipped types expose no
     icon slot or render prop), and **writing into those nodes with `innerHTML` is
     forbidden** — they are library-rendered, which is exactly what the append-only tagger
     rule exists to avoid. So each glyph is rendered once through the same
     `render-icon.ts`, serialised with `XMLSerializer` into a URL-encoded
     `data:image/svg+xml` URI and published as a `--wxi-*` custom property on `:root`;
     `styles/icons.css` reads them as `mask-image: var(--wxi-plus, none)`. Both gantt
     screens call `installWxiMasks()` as their chunk loads (idempotent, never inside a
     render), so the variables are set before the widget draws its first `<i>`.
  The `, none` fallback in those `var()` calls is load-bearing: an unset variable makes
  the declaration invalid at computed-value time, and the `::before` would then paint as a
  solid `currentColor` square rather than going missing. An empty mask fails silently, so
  verify icons in `bun run build && bun run preview`, not just dev.
  There is still no icon generation script and no glyph data committed here —
  `bun install` is the only thing that updates any of it.

## Gotchas that cost real debugging time

- SVAR react-gantt 2.x, PRO features reimplemented manually: weekend-skipping
  scheduling (HOURS_PER_DAY=7, `scheduleFromHours` + intercepts) and undo/redo
  (JSON snapshot stacks, not `getHistory()` which is PRO-only).
- **The widget's vertical scrolling is not what it looks like, and one CSS word broke
  it.** `.wx-gantt` is the scroller; inside it a tall `.wx-pseudo-rows` holds a
  `position: sticky` `.wx-stuck` sized to the viewport, and the chart's own content is
  offset upwards by the scroll amount. So the GRID's header stays put on its own (it is a
  separate flex child of the pinned layout) while the date scale — a child of the offset
  chart — is only held in place by SVAR's shipped `.wx-scale { position: sticky; top: 0 }`.
  `wx-overrides.css` used to override that to `position: relative`, purely to give
  `.project-span` something to position against, and the scale therefore rode off the top
  of the screen with the bars. Sticky is itself a positioned ancestor, so `.project-span`
  works either way, and sticky only pins on the axis it is given a threshold for, so the
  scale still scrolls SIDEWAYS with the bars. Never set that back to `relative`.
- Four places where SVAR's shipped types are wrong or too narrow, each narrowed locally
  rather than cast to `any` — don't "fix" them by widening the api:
  - `IApi.getTask` is typed `ITask` (everything optional) but returns a parsed task, so
    `Editor.tsx` and `ShareViewer.tsx` each define `ParsedTask` + `GanttApi` and cast the
    `init(api)` argument once.
  - `GanttScaleCell` omits the `date` the rendered cells carry, which `xForDate` reads —
    hence the local `ScaleCell`/`ScaleRow`/`ScaleData` and the cast on `_scales`.
  - `exec("show-editor", {id})` types `id` as `TID`, but `null` is what closes the
    editor; that one call site asserts `null as unknown as TID`.
  - `@svar-ui/gantt-store` does not re-export `IParsedTask`/`ITaskType`/`ISummaryConfig`
    /`TDurationUnit` through its package index — import only what the index exports and
    spell the rest out locally.
- Ids: SVAR's `uid()` is an incrementing **number**, so tasks and links created in-session
  carry numeric ids while the Postgres columns are `text`. That is why `TaskId` is
  `string | number` and why the two `insert` calls in `db.ts` carry a commented cast —
  don't "fix" it with `String(id)` unless you also migrate the data.
- `MToolbar`/`MContextMenu` are handed `api!`: the api is genuinely null until the widget
  mounts, and the components cope, but their prop type doesn't model it.
- DOM decoration (type icons, status dots, tracker pills, epic bands, project span, the
  Who column chips and its picker bridge) happens in a MutationObserver tagger. APPEND
  nodes only — `insertBefore` breaks React reconciliation ("forEach of null" crashes).
  Position appended nodes with CSS flex `order`. Call `observer.takeRecords()` to avoid
  loops.
- Never set `open: true` on leaf tasks passed to the Gantt — the tree walker crashes
  ("Cannot read properties of null (reading 'forEach')"). Only tasks with children get
  `open`.
- **A summary that is nested and empty crashes the parse**, whatever dates it carries:
  `getSummaryDates` recurses into every descendant of a dateless summary and throws
  "Summary tasks must have start and end dates if they have no subtasks". `prepareTasks`
  hands empty nested tiers over as plain bars for exactly this reason — see "Three tiers".
- A summary (epic) task with no children must keep explicit start/end dates or the
  widget throws; with children its dates are deleted and auto-computed.
- Widgets (MGantt/MToolbar/MContextMenu/MEditor) are memoized with stable props —
  otherwise App re-renders reset the uncontrolled editor fields mid-typing.
- Mount-guard pattern in intercept setTimeouts: compare `apiRef.current` and the captured
  project id before acting, or a stale mount serializes an empty widget over freshly
  loaded data. It no longer depends on the load being a slow round trip — the editor only
  mounts once `StoreProvider` has data, so there is no "adopt the loaded store" step to
  race any more. Keep it anyway: changing the scale remounts the widget, and the pending
  timeout from the old one must abort.
- **No project is ever invented.** The old `loadData()` fabricated
  `{ id: uid(), name: "Project timeline" }` client-side, and the first debounced save
  wrote that phantom into the real database. Zero projects is a real state, rendered by
  the `/` route; a project exists only because `insertProject` ran for a click.
- The gantt holder is keyed on `seed + projectId + storeRev`. `seed` is bumped by
  **undo/redo** (`restoreSnapshot`) so the widget remounts around the restored data; it
  used to be bumped by `changeView` too, which is gone with the scale switcher. Do not
  delete `seed` — undo still needs it.
- Vite strips SVAR's `@font-face` rules via a small plugin in `vite.config.ts`; the app
  supplies its own faces and passes `fonts={false}` to Willow. Keep that plugin's
  `enforce: "pre"` and keep it ahead of `tailwindcss()` in the plugin list.
- Stylesheet import order is load-bearing: `styles/style.css`, then
  `@svar-ui/react-gantt/all.css`, then `styles/wx-overrides.css` and `styles/icons.css`.
  There is one entry, so all four are imported by `src/main.tsx` in that order and nowhere
  else — don't move them back into the screens.
- PDF export uses jsPDF's plain browser download: `buildGanttPdf(...)` returns the doc
  and the caller calls `doc.save(name)`. It is **async**, and three things about it are
  load-bearing:
  - **jsPDF is `await import("jspdf")`, never a static import.** A static one put 386 kB
    in the editor's route chunk (`p._projectId-*.js` was 511 kB, now 126 kB) on every
    project open. `pdf.ts` imports only `type { jsPDF }` at module scope; verify after
    any change that the built editor chunk mentions jspdf solely as `import("./jspdf…")`.
  - **Text is drawn in DejaVu Sans, embedded from `features/gantt/fonts/`.** jsPDF's
    built-in Helvetica is a WinAnsi Type1 face, so a Cyrillic name printed as one wrong
    Latin glyph per byte ("Поиск" → "> 8 A :"). The two `.ttf` faces are Vite assets
    (`new URL("./fonts/…", import.meta.url)`), fetched on the first export and held in a
    module-scope promise — never bundled. If the fetch fails the export still runs in
    Helvetica with a console warning. Don't reintroduce `setFont("helvetica", …)`.
  - The table is TASK · ID · **SCOPE** · START · END · EFFORT h. SCOPE prints the release
    the row inherits, bold and coloured on the tier that owns it; stories print with the
    epic's bracket bar in the story colour. The PDF always exports the whole project — it
    is a document of the plan, not a snapshot of the filter.
  - **Every table cell is clipped to its column by `fitText`**, which measures against the
    font actually set and ellipsizes. Only the TASK column used to truncate, so
    `PRODUCT-2907` (19.8 mm) ran through the 19 mm ID column into START. Column widths are
    sized to their widest content; scale labels are dropped rather than allowed to hang
    over the chart's edge rules.
- The artifact integration is gone: no `window.claude`, no `mcp`/`downloads`/`publish`
  capability, no `view_page`/`view_chunks` template chunking. Don't bring any of it back.
