# Gantt

A personal Gantt chart tool built on [SVAR React Gantt](https://github.com/svar-widgets/react-gantt),
with Supabase as the backing store and a public view-only share page. It is a Vite +
React SPA — one entry, routed with [TanStack Router](https://tanstack.com/router) and
persisted through [TanStack Query](https://tanstack.com/query) — deployed to GitHub Pages
under `/gantt/`. The shell is Tailwind CSS v4 + Ark UI + Phosphor icons.

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

The app is TypeScript throughout (`strict: true`); see [TypeScript](#typescript) below.

The tree is **feature-first**: `routes/` holds thin route definitions and nothing else,
each feature owns its own screens, api and helpers, and `lib/` is what genuinely crosses
all of them.

```
src/
  main.tsx              the only module entry — router, query client, and the four
                        stylesheets in the order that matters
  routeTree.gen.ts      generated from routes/ by the router plugin, committed
  routes/               thin route definitions: a path, a guard, a component
  app/AuthedShell.tsx   the layout behind the auth gate; mounts the store provider
  features/
    auth/
      api/auth.ts       the only module that calls supabase.auth.* — and it imports
                        the client *dynamically*, which is what keeps supabase-js out
                        of the entry bundle and off the public share page
      components/       SignInPage · SignUpPage · ForgotPasswordPage ·
                        ResetPasswordPage, plus the AuthCard chrome they share
      hooks/            useSessionRedirect (both directions), useRecoverySession
      lib/validate.ts   the field validators the TanStack Form fields use
    gantt/
      Editor.tsx        the editor for one project (/p/$projectId)
      ShareViewer.tsx   the read-only viewer — same look, no editing UI, no Supabase
                        client; it must not import from src/lib/
      pdf.ts            vector PDF export (jsPDF, A4 landscape); returns a jsPDF doc
      icons.ts          Phosphor glyphs for the nodes the row tagger builds in plain JS
      lib/              render-icon (one detached React root), wxi-masks (the CSS masks
                        for SVAR's own <i> icons), tracker (PRODUCT-XXXX extraction)
    people/roster.ts    assignee helpers shared by both gantt screens
    projects/store.tsx  the React Query snapshot, the draft, and the write mutations
  lib/
    supabase.ts         the browser Supabase client, createClient<Database>(…)
    db.ts               all persistence: supabase-js table queries, no SQL strings;
                        the snapshot/draft diff (saveStore); home of the StoreTask /
                        StoreLink / StoreProject / StoreData / Person shapes
    database.types.ts   generated from the live schema, never hand-edited
  styles/               style.css (Tailwind entry + the single @theme token source),
                        wx-overrides.css (SVAR re-skin), icons.css (masks for SVAR's
                        own <i class="wxi-…"> markup)
  vite-env.d.ts         vite/client plus the global augmentations the app needs
```

Two things stayed put on purpose. **`lib/db.ts` is one persistence layer**, not several:
its `saveStore` diff spans every table in a single pass, and splitting it per feature
would mean splitting the one thing that must not be split. And **the people roster UI
lives inside `features/gantt/Editor.tsx`**, because the People popover, the Who column and
its picker are woven into the MutationObserver row tagger — only the standalone helpers
(`parseAssignees`, `initialsOf`, `nameHue`) moved out to `features/people/roster.ts`,
where the viewer can share them instead of keeping a second copy.

Outside `src/`:

- `index.html` — the only HTML entry; `src/main.tsx` is its module
- `vite.config.ts` — `base: '/gantt/'`, `@tanstack/router-plugin` (route-tree codegen +
  automatic route code-splitting), `@tailwindcss/vite`, a small plugin that strips SVAR's
  CDN `@font-face` rules, and one that copies `dist/index.html` to `dist/404.html`
- `tsconfig.json` / `tsconfig.node.json` — the app (`src/`) and the build tooling
  (`vite.config.ts`, which needs the Node globals the browser code must not see)
- `edge/shared/index.ts` — Supabase Edge Function `shared`: the public JSON feed for the
  viewer (deployed by hand; this repo only holds the source, and it is Deno source that
  deliberately sits outside both tsconfigs)

## Routes

| Route | Purpose |
| --- | --- |
| `/login` | sign in with email + password; redirects to `/` when a session already exists |
| `/signup` | create an account; same redirect |
| `/forgot-password` | request a password-reset email; same redirect |
| `/reset-password` | set a new password, reached from the link in that email — **not** redirected away by an existing session, because a recovery session is exactly what it arrives with |
| `/` | resolves to the last opened project and forwards to `/p/$projectId`; with no projects, an empty state with a **New project** button |
| `/p/$projectId` | the editor — deep-linkable, with `?view=day\|week\|month` as a validated search param |
| `/share/$projectId` | the public read-only viewer: no auth, and the Supabase client is never loaded |
| `/share` | the same viewer on whichever project the feed reports as active (the shape of the old share link) |

The auth gate is a `beforeLoad` redirect on a pathless `_authed` layout rather than a
conditional render, and the project switcher navigates instead of setting state — the URL
is the source of truth for which project is open. `app_state.active_project` is now only
"last opened", used to resolve `/`.

Route components are code-split, and the only module that reaches the Supabase client from
the eager route tree is `src/features/auth/api/auth.ts`, which imports it dynamically.
That is what lets one HTML entry serve both the editor and a public share page that never
downloads supabase-js. Verify it after any route change: `bun run build`, then check that
`dist/assets/index-*.js` names the supabase chunk only inside an `import(...)`.

## Styling stack

Tailwind CSS v4 + [Ark UI](https://ark-ui.com) + [Phosphor icons](https://phosphoricons.com).

- **Tokens.** `src/styles/style.css` is the Tailwind entry. Every design token lives in one
  `@theme static` block there as `--color-*` / `--font-*` / `--text-*` / `--shadow-*` /
  `--ease-*` / `--dur-*` / `--animate-*`, which gives both the utilities (`bg-surface`,
  `text-ink`, `text-display`, `font-display`, `shadow-pop`) and the CSS variables the
  plain stylesheets read. `static` is required: Tailwind cannot
  see uses that live in another stylesheet and would otherwise tree-shake those variables
  away. There is **no `tailwind.config.js`** — v4 configures itself from CSS.
  The stylesheets live in `src/styles/`, so `style.css` also carries `@source "../";` —
  automatic source detection would start from that directory and find nothing but CSS.
- **Themes.** Three blocks must stay in step: the `@theme` block (light), the
  `@media (prefers-color-scheme: dark) :root:not([data-theme="light"])` block, and
  `:root[data-theme="dark"]`. The two dark blocks are unlayered so they beat the layered
  `@theme` values.
- **No preflight.** `src/styles/style.css` imports `tailwindcss/theme.css` and
  `tailwindcss/utilities.css` but not the reset: preflight forces `box-sizing: border-box`
  and zeroes padding on every element, and SVAR's gantt sizes its own DOM with content-box
  widths. Everything the app renders sets its own border/background/padding utilities, so
  the reset buys nothing and would silently reflow the widget.
- **`styles/wx-overrides.css` stays selector-based CSS.** Most of its ~130 selectors target
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
- **Phosphor icons**, from exactly one package — `@phosphor-icons/react`. Three
  mechanisms, all fed from it:
  - **JSX components** for everything the app renders itself: the header, the popovers,
    the auth cards.
  - **`src/features/gantt/icons.ts`** for the nodes the MutationObserver tagger builds in
    plain JS — the type icons, the row pencil, the fold-all chevron and the Who "+". Each
    component is rendered once into a detached React root (`lib/render-icon.ts`) and its
    markup cached at module scope, which the tagger then assigns.
  - **`src/features/gantt/lib/wxi-masks.ts`** for the ~31 `<i class="wxi-…">` elements
    SVAR injects itself. The app never renders those and must not write into them, so
    they are reskinned with a `mask-image`. The masks are not files: each glyph is
    rendered from the same React component, serialised into an `svg+xml` data URI and
    published as a `--wxi-*` custom property on `:root`, which `styles/icons.css` reads as
    `mask-image: var(--wxi-plus, none)`.

  `@phosphor-icons/core`, the raw-`.svg` half of the set, used to be a second dependency
  purely to feed those mask rules. It is gone. There is still no icon generation step and
  no glyph data in the repo — `bun install` is the only thing that updates any of it.

## Design language

The shell follows Apple's interface-design guidance, translated to CSS:

- **Response.** Every control gives feedback on pointer-down, not on release: the `press`
  class scales to `0.97` (`0.9` for icon-sized targets) over `--dur-press` (100 ms).
- **Motion.** Four duration tokens (`--dur-press` / `-hover` / `-enter` / `-exit`) and a
  mirrored easing pair (`--ease-emphasized` in, `--ease-exit` out).
- **Anchored surfaces.** Popovers and menus scale out of the edge nearest their trigger
  and collapse back into it, using Ark's `data-state` and the `--transform-origin` it
  computes from the placement.
- **Materials.** Two weights — `material-chrome` for the topbar, the thicker
  `material-pop` for floating panels — each a translucent layer with a blur, a bright top
  edge and a shadow scaled to its size. The topbar meets the content with a soft scroll
  edge instead of a hairline.
- **Typography.** A nine-step rem ramp with size-specific tracking and leading: positive
  tracking on small uppercase labels, zero through body, negative as display sizes grow.
  Spacing that must scale with text is rem/em, so the layout follows the reader's
  text-size setting. The SVAR widget keeps px sizes — its column widths are content-box px
  set in JS.
- **Accessibility.** `prefers-reduced-motion` (cross-fade instead of scale, brightness
  instead of a press), `prefers-reduced-transparency` (opaque, no blur) and
  `prefers-contrast: more` (near-solid, defined borders) are all honoured, and every
  interactive element has a visible `:focus-visible` ring.

## Auth and access

The editor is gated behind Supabase Auth (email + password), with four separate pages —
sign in, sign up, forgot password, reset password — each linking to the others. Forms are
[TanStack Form](https://tanstack.com/form) over Ark UI `Field`, so validation, error text
and the busy state are the same everywhere.

Every `supabase.auth.*` call in the app lives in `src/features/auth/api/auth.ts`. The gate
itself is a `beforeLoad` redirect, which means nothing re-renders when the session changes
underneath it — so the pages subscribe to `onAuthStateChange` and navigate: to `/` when a
session appears, to `/login` when one goes away.

Two behaviours are deliberate rather than incidental. **Sign-up does not pretend.** If the
project requires email confirmation, `signUp` returns no session, and the page says so
instead of dropping the user somewhere that will not load. And **the reset request never
reveals whether an account exists** — the same neutral "if that address has an account, we
sent it a link" either way.

### Password reset

`resetPasswordForEmail(email, { redirectTo })` where `redirectTo` is built from
`import.meta.env.BASE_URL` against the current origin, so the same code produces
`http://localhost:5173/gantt/reset-password` in dev and
`https://ingaleokot.github.io/gantt/reset-password` in production. Supabase's link goes to
`/auth/v1/verify`, which redirects there with the recovery token in the URL fragment; the
client is created with `detectSessionInUrl: true`, so loading it exchanges the fragment
for a session and emits `PASSWORD_RECOVERY`. `/reset-password` then takes the new password
twice and calls `updateUser({ password })`. An expired or reused link arrives as
`#error=…&error_code=otp_expired` instead, and the page says so and offers a fresh one.

> **Both redirect URLs must be allow-listed** in the Supabase dashboard, under
> Authentication → URL Configuration → Redirect URLs. Supabase silently falls back to the
> project's Site URL for any `redirectTo` it does not recognise, and the reset mail then
> points at the wrong page.

RLS is **owner-scoped**, so every insert of `projects`, `people` and `app_state` carries
`owner = session.user.id`. `tasks` and `links` have no owner column — they inherit
ownership through `project_id`.

## Storage (Supabase)

All data lives in Postgres — the page keeps nothing locally:

- `people (id, name, position, owner)` — the roster tasks are assigned from
- `projects (id, name, view, position, owner)`
- `tasks (id, project_id → projects, parent_id → tasks, text, type, start_date, end_date,
  duration, hours, days, progress, details, open, sort_order, url, status, assignees)` —
  `assignees` is a comma-separated list of `people.id`
- `links (id, project_id, source → tasks, target → tasks, type)`
- `app_state (id = 'main', active_project, owner)`

### Saving

React Query holds a snapshot of what Postgres actually contains under `["store"]`; the
editor writes into a separate in-memory draft. A save is a mutation that diffs the draft
against the snapshot and issues **only the rows that changed** — an insert for a new task,
an `update … eq(id)` for an edited one, a `delete … in(id)` for a removed one, and a
single upsert of exactly the changed rows for the bulk cases (epic roll-ups, `sort_order`
rewrites, snapshot undo/redo). On success the snapshot becomes the draft. Writes are still
debounced by 1.4 s so a drag does not fire thirty requests, but what the debounce emits is
targeted.

This replaced a save that deleted every task and link of every loaded project and
re-inserted them each time. Adding one task rewrote the whole store, and anything that
interrupted the gap between the delete and the insert — a failed request, a closed
laptop — lost it. Nothing in `src/lib/db.ts` may delete by anything other than row id, and
`saveStore` refuses to run at all without a snapshot to diff against, because without one
every row looks new and every stored row looks deleted.

Creating and deleting a project, and recording the last opened one, are their own
single-row mutations rather than something the diff infers. All the write mutations share
one TanStack Query scope, so they queue instead of racing each other's snapshot.

## Share flow

`/gantt/share/<projectId>` is a route with no Supabase client and no auth. It fetches
`https://<project>.supabase.co/functions/v1/shared?raw=1`, where the edge function
(`verify_jwt: false`, service role) returns `{ active, projects, tasks, links, people }`
as JSON with CORS `*`, and renders it read-only. Viewers always see current data.
An optional `&owner=<uuid>` narrows the feed to one account.

## Develop

```sh
bun install
bun run dev        # http://localhost:5173/gantt/ against cloud Supabase
bun run typecheck  # tsc --noEmit over src/ and over vite.config.ts
bun run build      # → dist/ (one entry, plus 404.html for GitHub Pages)
bun run preview
```

Tooling is [Bun](https://bun.sh) (`bun.lock` is the lockfile; there is no npm lockfile).
There is no automated test suite — `bun run typecheck` is the only automated check, so
verify behaviour by hand in `bun run dev`, and verify styling in `bun run build &&
bun run preview` (Tailwind only keeps class names it can see spelled out in the source).

## TypeScript

Everything under `src/` is TypeScript with `strict: true`. Two configs, because the app
and the build tooling need different globals:

- `tsconfig.json` — `include: ["src"]`, `types: ["vite/client"]`, `jsx: "react-jsx"`,
  `moduleResolution: "bundler"`. Imports inside `src/` are extensionless
  (`./lib/db`, not `./lib/db.js`) so both tsc and Vite resolve them.
- `tsconfig.node.json` — `include: ["vite.config.ts"]`, `types: ["node"]`.

`bun run typecheck` runs `tsc --noEmit` over both. Vite itself only strips types
(esbuild), so a type error never fails the build — run the typecheck.

`src/routeTree.gen.ts` is generated by the router plugin on every `dev` and `build` and is
committed; on a fresh clone run `bun run build` once before the first typecheck. It is
`@ts-nocheck`'d, but the routes you write are fully checked — `src/main.tsx` registers the
router with `declare module "@tanstack/react-router"`, so a bad `to:` or a missing route
param is a compile error.

### Database types

`src/lib/database.types.ts` is generated from the live cloud project and committed.
`src/lib/supabase.ts` passes it to `createClient<Database>(…)`, so every `.from("tasks")`
call is checked against the real columns. Regenerate it after any migration:

```sh
supabase gen types typescript --project-id wouvkkaxehwuhtgpersx > src/lib/database.types.ts
```

(or the Supabase MCP `generate_typescript_types` tool with that project id). Never edit
it by hand.

Copy `.env.example` to `.env` and fill in `VITE_SUPABASE_URL` and
`VITE_SUPABASE_PUBLISHABLE_KEY` (both are public client credentials; `.env` is gitignored).

## Deploy

`bun run build` emits `dist/` under the `/gantt/` base path. Publish `dist/` to GitHub
Pages (Pages → build from an Actions workflow, or push `dist/` to a `gh-pages` branch) —
the old `docs/` folder is gone. The edge function is deployed separately from
`edge/shared/index.ts`.

`dist/404.html` is a copy of `dist/index.html`, written by a plugin in `vite.config.ts`.
GitHub Pages has no SPA rewrite, so it serves 404.html for any path without a file; making
that file the app is what lets a hard refresh on `/gantt/p/<id>` work. `vite dev` and
`vite preview` rewrite to index.html themselves, so a missing 404.html only ever shows up
in production.
