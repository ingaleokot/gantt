import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight, CopySimple, Plus, SignOut, TrashSimple } from "@phosphor-icons/react";
import { signOut } from "../auth/api/auth";
import { useStore } from "./store";
import { formatRelease, formatSpan, spanDays, summarizeProject } from "./summary";
import type { ProjectSummary } from "./summary";
import type { StoreProject } from "../../lib/db";

/* The front door: every project the account owns, with enough on each card to
   choose between two that share a name — the counts, the effort and the span
   are what actually tell "Viory — MVP" from "Viory — MVP".

   Nothing here talks to Supabase. Creating, copying, renaming and deleting all
   go through the mutations in ./store, which is where the snapshot/draft/diff
   write model lives: a rename is one `update … eq(id)`, a delete is one
   `delete … eq(id)` and its cascades, and a copy is inserts. There is no path
   from this screen to a delete filtered by anything but a row id.

   Two rules from the interaction review are load-bearing in the markup below:
   every control is visible without hovering (the old project menu hid its
   delete behind `group-hover`, which does not exist on a touch screen), and
   the destructive one is a two-step confirm that says what it costs. */

/* literal class strings only — Tailwind reads source text, so none of these may
   be assembled from fragments at runtime */
const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent";
const BTN =
  `press inline-flex cursor-pointer items-center gap-1.5 rounded-[9px] border border-line bg-surface px-[0.8125rem] py-1.5 font-ui text-small font-medium text-muted hover:bg-surface-hover hover:text-ink disabled:cursor-default disabled:opacity-60 ${FOCUS}`;
const BTN_PRIMARY =
  `press inline-flex cursor-pointer items-center gap-1.5 rounded-[9px] border-0 bg-accent px-[0.8125rem] py-1.5 font-ui text-small font-semibold text-accent-ink no-underline hover:brightness-[1.08] active:brightness-[0.94] disabled:cursor-default disabled:opacity-60 ${FOCUS}`;
/* icon-only actions: always visible, never hover-revealed, and each one names
   itself for a screen reader and a tooltip */
const BTN_ICON =
  `press press-sm inline-flex h-[30px] w-[30px] flex-none cursor-pointer items-center justify-center rounded-[9px] border border-line bg-surface p-0 text-muted hover:bg-surface-hover hover:text-ink disabled:cursor-default disabled:opacity-60 ${FOCUS}`;
const BTN_ICON_DANGER =
  `press press-sm inline-flex h-[30px] w-[30px] flex-none cursor-pointer items-center justify-center rounded-[9px] border border-line bg-surface p-0 text-muted hover:border-danger hover:bg-surface-hover hover:text-danger disabled:cursor-default disabled:opacity-60 ${FOCUS}`;
const BTN_DANGER =
  `press inline-flex cursor-pointer items-center gap-1.5 rounded-[9px] border-0 bg-danger px-[0.8125rem] py-1.5 font-ui text-small font-semibold text-accent-ink hover:brightness-[1.08] active:brightness-[0.94] disabled:cursor-default disabled:opacity-60 ${FOCUS}`;
const CARD = "flex flex-col gap-3 rounded-xl border border-line bg-surface p-4 shadow-pop";
/* the card a copy just landed in. Spelled out in full rather than composed —
   Tailwind only keeps class names it can read verbatim in the source. */
const CARD_FLASH = "flex flex-col gap-3 rounded-xl border border-accent bg-surface p-4 shadow-pop ring-2 ring-accent/40";
const META_LABEL = "m-0 text-label font-semibold text-faint uppercase";
const META_VALUE = "m-0 mt-0.5 font-ui text-body text-ink tabular-nums";

const fmtEffort = (s: ProjectSummary) => (s.hours ? `${s.hours}h / ${s.days}d` : "None yet");

/* ---------- one card ---------- */

interface CardProps {
  project: StoreProject;
  lastOpened: boolean;
  /* this card is the one mid-write */
  busy: boolean;
  /* some card is mid-write — writes queue on one scope, so a second click
     would sit there doing nothing visible. Disable rather than no-op. */
  locked: boolean;
  /* a copy just landed here: say so, and bring it on screen */
  flash: boolean;
  armed: boolean;
  onArm: (armed: boolean) => void;
  onRename: (name: string) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

function ProjectCard({ project, lastOpened, busy, locked, flash, armed, onArm, onRename, onDuplicate, onDelete }: CardProps) {
  const s = summarizeProject(project);
  const days = spanDays(s);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLLIElement>(null);

  /* the confirm replaces the buttons it was triggered from, so focus has to be
     put somewhere deliberate — on the way out, not on the destructive step */
  useEffect(() => { if (armed) cancelRef.current?.focus(); }, [armed]);

  /* a copy is appended to the end of the list, which on a long list is off
     screen: without this, duplicating looks like nothing happened */
  useEffect(() => {
    if (flash) cardRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [flash]);

  const cost = s.tasks || s.epics || s.stories
    ? `Delete “${project.name || "Untitled project"}” and everything in it — ${project.tasks.length} ${project.tasks.length === 1 ? "row" : "rows"}, including ${s.tasks} ${s.tasks === 1 ? "task" : "tasks"}, ${s.stories} ${s.stories === 1 ? "story" : "stories"} and ${s.epics} ${s.epics === 1 ? "epic" : "epics"}?`
    : `Delete “${project.name || "Untitled project"}”? It is empty.`;

  return (
    <li
      ref={cardRef}
      className={flash ? CARD_FLASH : CARD}
      /* escape backs out of the armed confirm from anywhere inside the card */
      onKeyDown={(e) => { if (e.key === "Escape" && armed) { e.stopPropagation(); onArm(false); } }}
    >
      <div className="flex items-start gap-2">
        {/* a real input, not a contentEditable heading: it is a form control,
            and it is the only way to rename a project from here */}
        <input
          className={`m-0 min-w-0 flex-1 rounded-[7px] border border-transparent bg-transparent px-1.5 py-1 font-display text-title font-semibold text-ink transition-colors duration-[130ms] ease-out hover:border-line-soft hover:bg-surface-hover focus:border-accent focus:bg-surface-alt focus:outline-none ${FOCUS}`}
          value={project.name}
          aria-label="Project name"
          spellCheck={false}
          onChange={(e) => onRename(e.target.value)}
          onBlur={(e) => { if (!e.target.value.trim()) onRename("Untitled project"); }}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); } }}
        />
        {flash && (
          <span role="status" className="mt-1.5 flex-none rounded-full bg-accent-hover px-2 py-[0.125rem] text-label font-semibold text-accent uppercase">
            Copied
          </span>
        )}
        {lastOpened && !flash && (
          <span className="mt-1.5 flex-none rounded-full bg-accent-hover px-2 py-[0.125rem] text-label font-semibold text-accent uppercase">
            Last opened
          </span>
        )}
      </div>

      {/* the substance: what distinguishes two projects with the same name */}
      <dl className="m-0 grid grid-cols-[repeat(3,minmax(0,1fr))] gap-x-3 gap-y-2.5">
        <div>
          <dt className={META_LABEL}>Tasks</dt>
          <dd className={META_VALUE}>{s.tasks}</dd>
        </div>
        <div>
          <dt className={META_LABEL}>Epics</dt>
          <dd className={META_VALUE}>{s.epics}</dd>
        </div>
        <div>
          {/* the middle tier, counted separately: an epic of five stories and an
              epic of five tasks are not the same project */}
          <dt className={META_LABEL}>Stories</dt>
          <dd className={META_VALUE}>{s.stories}</dd>
        </div>
        <div>
          {/* effort is the work inside the bars, not the length of the span —
              the word has to be on screen next to a date range that is nothing
              like it */}
          <dt className={META_LABEL}>Effort</dt>
          <dd className={META_VALUE}>{fmtEffort(s)}</dd>
        </div>
        <div className="col-span-2">
          {/* what MVP actually costs, from the same roll-up the editor uses:
              every task takes the scope of the nearest epic or story above it */}
          <dt className={META_LABEL}>Release scope</dt>
          <dd className={META_VALUE}>{formatRelease(s)}</dd>
        </div>
        <div className="col-span-3">
          <dt className={META_LABEL}>Timeline</dt>
          <dd className={META_VALUE}>
            {formatSpan(s)}
            {days !== null && <span className="text-muted">{" · " + days + (days === 1 ? " day" : " days")}</span>}
          </dd>
        </div>
      </dl>

      {armed ? (
        <div className="rounded-lg border border-danger bg-surface-alt p-2.5" role="group" aria-label="Confirm delete">
          <p className="m-0 mb-2 text-mini text-ink">{cost} This cannot be undone.</p>
          <div className="flex flex-wrap gap-1.5">
            <button ref={cancelRef} type="button" className={BTN} onClick={() => onArm(false)}>Keep it</button>
            <button type="button" className={BTN_DANGER} onClick={onDelete} disabled={locked}>
              <TrashSimple size={13} aria-hidden="true" />
              {busy ? "Deleting…" : "Delete project"}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-t-line-soft pt-3">
          <Link
            to="/p/$projectId"
            params={{ projectId: project.id }}
            search={{}}
            className={BTN_PRIMARY}
          >
            Open
            <ArrowRight size={13} aria-hidden="true" />
          </Link>
          <div className="flex-1" />
          {busy && <span className="text-mini text-muted">Working…</span>}
          <button
            type="button"
            className={BTN_ICON}
            onClick={onDuplicate}
            disabled={locked}
            aria-label={`Duplicate ${project.name || "Untitled project"} — copy it with its ${project.tasks.length} ${project.tasks.length === 1 ? "row" : "rows"}`}
            title="Duplicate"
          ><CopySimple size={15} aria-hidden="true" /></button>
          <button
            type="button"
            className={BTN_ICON_DANGER}
            onClick={() => onArm(true)}
            disabled={locked}
            aria-label={`Delete ${project.name || "Untitled project"}`}
            title="Delete"
          ><TrashSimple size={15} aria-hidden="true" /></button>
        </div>
      )}
    </li>
  );
}

/* ---------- the page ---------- */

export default function ProjectsPage() {
  const st = useStore();
  const navigate = useNavigate();
  /* which row is mid-write: "new", or a project id */
  const [busy, setBusy] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  /* the copy that just landed, so the card can say so and scroll itself in */
  const [flash, setFlash] = useState<string | null>(null);
  /* a create or a copy that was refused or failed. The store's own error pill
     covers the save path; this is what the page itself could not do. */
  const [notice, setNotice] = useState<string | null>(null);

  const projects = st.projects;

  useEffect(() => {
    if (!flash) return;
    const t = window.setTimeout(() => setFlash(null), 4000);
    return () => clearTimeout(t);
  }, [flash]);

  const create = useCallback(async () => {
    if (busy) return;
    setBusy("new");
    setNotice(null);
    try {
      const id = await st.createProject("Untitled project");
      await navigate({ to: "/p/$projectId", params: { projectId: id }, search: {} });
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [busy, st.createProject, navigate]);

  const duplicate = useCallback(async (id: string) => {
    if (busy) return;
    setBusy(id);
    setNotice(null);
    try { setFlash(await st.duplicateProject(id)); }
    catch (e) { setNotice(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }, [busy, st.duplicateProject]);

  const remove = useCallback(async (id: string) => {
    if (busy) return;
    setBusy(id);
    setNotice(null);
    try {
      await st.removeProject(id);
      setArmed(null);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [busy, st.removeProject]);

  const leave = useCallback(async () => {
    /* signing out throws the draft away with the page, so ask first if
       anything is still only in this tab */
    const saved = await st.flushSave();
    if (!saved && !window.confirm(
      "Your latest changes have not reached the database yet, and signing out discards them. Sign out anyway?",
    )) return;
    await signOut();
    await navigate({ to: "/login", replace: true });
  }, [st.flushSave, navigate]);

  const statusText = {
    idle: "", saving: "Saving…", saved: "Saved · Supabase", local: "Not saved — Supabase unavailable",
  }[st.status];
  /* the store reports the mutation's own failure, and the page catches the
     same rejection — `seen` is what keeps a failed create or copy from being
     said twice. The page notice still carries what the store cannot: the
     refusals this screen raises itself, before any mutation runs. */
  const seen = new Set<string>();
  const alerts = [
    st.error ? { key: "store", text: st.error } : null,
    st.warning ? { key: "remote", text: st.warning } : null,
    notice ? { key: "page", text: notice } : null,
  ].filter((x): x is { key: string; text: string } => {
    if (!x || seen.has(x.text)) return false;
    seen.add(x.text);
    return true;
  });

  return (
    <div className="flex h-full flex-col font-ui text-ink">
      {/* the same material and the same controls as the editor's topbar, so
          the front door reads as the same product. It wraps rather than
          overflowing — the editor header's own failure below 1100px. */}
      <header className="material-chrome edge-fade relative z-10 flex flex-none flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span
            className="block h-3.5 w-3.5 rounded-[4px] bg-[linear-gradient(135deg,var(--color-accent)_0_50%,var(--color-summary-fill)_50%_100%)]"
            aria-hidden="true"
          />
          <h1 className="m-0 font-display text-display font-semibold">Projects</h1>
          {projects.length > 0 && (
            <span className="text-mini text-muted tabular-nums">
              {projects.length === 1 ? "1 project" : projects.length + " projects"}
            </span>
          )}
        </div>
        {statusText && (
          <span
            className={
              st.status === "saved"
                ? "rounded-full border border-transparent bg-accent-hover px-2.5 py-[0.1875rem] text-mini whitespace-nowrap text-accent"
                : "rounded-full border border-line bg-surface px-2.5 py-[0.1875rem] text-mini whitespace-nowrap text-muted"
            }
          >{statusText}</span>
        )}
        {alerts.map((a) => (
          <span
            key={a.key}
            role="status"
            title={a.text}
            className="max-w-[34ch] overflow-hidden rounded-full border border-danger bg-surface px-2.5 py-[0.1875rem] text-mini text-ellipsis whitespace-nowrap text-danger"
          >{a.text}</span>
        ))}
        <div className="flex-1" />
        <button type="button" className={BTN_PRIMARY} onClick={create} disabled={busy !== null}>
          <Plus size={13} weight="bold" aria-hidden="true" />
          {busy === "new" ? "Creating…" : "New project"}
        </button>
        <button type="button" className={BTN} onClick={() => { void leave(); }}>
          <SignOut size={13} aria-hidden="true" />
          Sign out
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-4 pb-8">
        {projects.length === 0 ? (
          /* a real empty state, and the only thing it does is create the first
             project. Nothing is ever invented on load: zero projects is a
             state the app renders, not one it papers over. */
          <div className="grid place-items-center py-[12vh]">
            <div className="max-w-[26rem] rounded-[14px] border border-line bg-surface px-[1.625rem] py-[1.375rem] text-center shadow-pop motion-safe:animate-rise">
              <div className="mb-1.5 font-display text-title font-semibold">No projects yet</div>
              <p className="m-0 mb-4 text-copy text-muted">
                A project holds one timeline — its epics, tasks, links and people. Create one to start planning.
              </p>
              <button type="button" className={BTN_PRIMARY} onClick={create} disabled={busy !== null}>
                <Plus size={13} weight="bold" aria-hidden="true" />
                {busy === "new" ? "Creating…" : "New project"}
              </button>
            </div>
          </div>
        ) : (
          <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(17.5rem,1fr))] gap-3 p-0 motion-safe:animate-rise">
            {projects.map((p) => (
              <ProjectCard
                key={p.id}
                project={p}
                lastOpened={p.id === st.draft.activeProject}
                busy={busy === p.id}
                locked={busy !== null}
                flash={flash === p.id}
                armed={armed === p.id}
                onArm={(on) => setArmed(on ? p.id : null)}
                onRename={(name) => st.renameProject(p.id, name)}
                onDuplicate={() => { void duplicate(p.id); }}
                onDelete={() => { void remove(p.id); }}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
