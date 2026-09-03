import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  cloneStore, deleteProject, fetchStore, insertProject, isConflict, normalizeOrder,
  pendingWrites, saveStore, setActiveProject, storesDiffer,
} from "../../lib/db";
import type { Person, StoreData, StoreLink, StoreProject, StoreTask } from "../../lib/db";

/* The write model, in one place.

   `["store"]` in the React Query cache is the snapshot of what Postgres
   actually holds. `draftRef` is what the user is looking at: the editor
   serializes the widget into it on every change. A save diffs the draft
   against the snapshot and writes only the rows that differ — one insert for a
   new task, one update for an edited one, one delete for a removed one — and
   on success the snapshot becomes the draft.

   That indirection is the point. The previous version deleted every task and
   link of every loaded project and re-inserted them on each debounced save, so
   adding one task rewrote the whole store and a failure between the delete and
   the insert lost it. The diff keeps the bulk operations that legitimately
   touch many rows (epic roll-ups, reordering, snapshot undo/redo) working:
   they simply produce many changed rows, which is one upsert of exactly those
   rows instead of a wipe.

   What a failed save must never do is go quiet. A save that fails leaves work
   that exists only in this tab, so: every write it issues is idempotent and
   the whole diff is retried on a backoff, `flushSave` reports whether it
   actually succeeded so sign-out and delete can ask before discarding, and the
   tab refuses to close without asking while anything is still pending. And
   because nothing pushes changes here, coming back to the tab is when it looks
   at Postgres again — adopting a newer state when there is nothing to lose,
   and saying so rather than overwriting when there is. */

export const STORE_KEY = ["store"] as const;
export const storeQuery = queryOptions({
  queryKey: STORE_KEY,
  queryFn: fetchStore,
  staleTime: Infinity,
  /* the reconcile below refetches on focus deliberately and compares before
     it adopts anything — React Query's own refetch would replace the snapshot
     under a draft that is mid-edit */
  refetchOnWindowFocus: false,
});

export const uid = () => "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/* ---------- duplicating a project ----------
   A copy is rows the user asked for, so it is built here and written the same
   way anything else is: the project row through the same single insert a new
   project uses, and its tasks and links by the diff, as inserts. Nothing is
   copied in Postgres and nothing existing is touched.

   Every id is minted fresh, and `parent`, `source` and `target` are rewritten
   through the map — a copy that pointed at the original's rows would re-parent
   them the moment it was saved, and deleting the copy would then cascade into
   the original. Links whose ends did not both come along are dropped. */
function copyRows(p: StoreProject): { tasks: StoreTask[]; links: StoreLink[] } {
  let n = 0;
  const mint = () => "c" + Date.now().toString(36) + (n++).toString(36) + Math.random().toString(36).slice(2, 5);
  const map = new Map<string, string>();
  (p.tasks || []).forEach((t) => map.set(String(t.id), mint()));
  const tasks = (p.tasks || []).map((t) => {
    const c: StoreTask = { ...t, id: map.get(String(t.id)) as string };
    /* `sortOrder` is the snapshot's record of what Postgres holds for the row
       it was copied from; these rows have never been stored, so their order is
       their array index and the field must not claim otherwise */
    delete c.sortOrder;
    const parent = t.parent === undefined || t.parent === null ? null : map.get(String(t.parent));
    if (parent) c.parent = parent; else delete c.parent;
    return c;
  });
  const links: StoreLink[] = [];
  (p.links || []).forEach((l) => {
    const source = l.source === undefined || l.source === null ? undefined : map.get(String(l.source));
    const target = l.target === undefined || l.target === null ? undefined : map.get(String(l.target));
    if (!source || !target) return;
    links.push({ id: mint(), source, target, type: l.type || "e2s" });
  });
  return { tasks, links };
}

/* "Plan" → "Plan copy" → "Plan copy 2": distinct at a glance in a list where
   two projects may already share a name */
function copyName(name: string, taken: string[]): string {
  const base = (name || "Untitled project") + " copy";
  if (!taken.includes(base)) return base;
  for (let i = 2; i < 500; i++) if (!taken.includes(base + " " + i)) return base + " " + i;
  return base;
}

/* long enough to batch a drag, short enough that nothing is lost on a reload */
const SAVE_DEBOUNCE = 1400;
/* a failed save is retried on its own; the user should not have to poke it */
const RETRY_BACKOFF = [2000, 5000, 15000, 30000];

export type SaveStatus = "idle" | "saving" | "saved" | "local";

export interface StoreApi {
  ownerId: string;
  /* the live draft; mutate it, then call scheduleSave() */
  draft: StoreData;
  projects: StoreProject[];
  people: Person[];
  status: SaveStatus;
  error: string | null;
  /* something is true but not an error: the timeline moved somewhere else */
  warning: string | null;
  /* bumped when a newer snapshot is adopted from Postgres, so the editor can
     remount the widget around it instead of showing stale rows */
  storeRev: number;
  /* re-render everything reading the draft (project names, roster) */
  bump: () => void;
  scheduleSave: () => void;
  /* resolves true when everything is in Postgres, false when it is not */
  flushSave: () => Promise<boolean>;
  createProject: (name: string) => Promise<string>;
  /* a copy of one project's rows, written as inserts; resolves to its id */
  duplicateProject: (id: string) => Promise<string>;
  removeProject: (id: string) => Promise<void>;
  /* one project row, one `update … eq(id)` once the debounce fires */
  renameProject: (id: string, name: string) => void;
  /* records "last opened" so `/` can resolve to it next time */
  markOpened: (id: string) => void;
}

const Ctx = createContext<StoreApi | null>(null);

export function useStore(): StoreApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("useStore outside <StoreProvider>");
  return v;
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function StoreProvider({ ownerId, children }: { ownerId: string; children: React.ReactNode }) {
  const qc = useQueryClient();
  const query = useQuery(storeQuery);
  const draftRef = useRef<StoreData | null>(null);
  const [rev, setRev] = useState(0);
  const [storeRev, setStoreRev] = useState(0);
  const [warning, setWarning] = useState<string | null>(null);
  const bump = useCallback(() => setRev((r) => r + 1), []);
  const saveTimer = useRef<number | null>(null);
  const retryTimer = useRef<number | null>(null);
  const retryStep = useRef(0);
  const inFlight = useRef(0);

  /* seed the draft from the first successful load and never again: from here
     on the draft leads and the snapshot follows it */
  if (query.data && !draftRef.current) draftRef.current = cloneStore(query.data);

  const sync = useMutation({
    /* one save at a time — a create or a delete queued behind an in-flight
       diff must see the snapshot that diff left behind */
    scope: { id: "gantt-store-write" },
    mutationFn: async () => {
      const draft = draftRef.current;
      const prev = qc.getQueryData<StoreData>(STORE_KEY);
      /* without a snapshot every row would look new, and every persisted row
         would look deleted — refuse rather than guess */
      if (!draft || !prev) throw new Error("Store not loaded");
      const desired = cloneStore(draft);
      await saveStore(desired, prev, ownerId);
      /* the ordering that was just written is now what Postgres holds */
      return normalizeOrder(desired);
    },
    onSuccess: (desired) => {
      qc.setQueryData(STORE_KEY, desired);
      retryStep.current = 0;
      setWarning(null);
    },
    /* deliberately no snapshot rewrite on failure. A save is a sequence of
       requests and any of them can be the last that lands, but every write it
       issues is now an upsert of a row that carries its own primary key, so
       running the whole diff again from the unchanged snapshot re-sends
       exactly what did not land and rewrites what did with the same values.
       Re-reading Postgres here instead would pull in rows another tab created
       — rows the draft has never seen — and the next diff would read them as
       deletions. */
  });

  /* the mutation object is rebuilt on every render; the callbacks below must
     reach the current one without being rebuilt themselves */
  const syncRef = useRef(sync);
  syncRef.current = sync;

  const clearRetry = useCallback(() => {
    if (retryTimer.current !== null) { clearTimeout(retryTimer.current); retryTimer.current = null; }
  }, []);

  const flushSave = useCallback(async (): Promise<boolean> => {
    if (saveTimer.current !== null) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    clearRetry();
    if (!draftRef.current || !qc.getQueryData<StoreData>(STORE_KEY)) return false;
    /* counted here rather than read off `sync.isPending`: that flag only turns
       true once React has re-rendered, and the request is already in the air
       by then — a window in which the unload guard would have said "nothing
       pending" while a save was mid-flight */
    inFlight.current += 1;
    try {
      await syncRef.current.mutateAsync();
      return true;
    } catch {
      /* the message is on sync.error and in the status pill; the caller gets
         the one bit it needs — this did not reach Postgres */
      return false;
    } finally {
      inFlight.current -= 1;
    }
  }, [qc, clearRetry]);

  /* a failed save retries itself on a backoff rather than waiting for the next
     keystroke, which may never come */
  const armRetry = useCallback(() => {
    clearRetry();
    const wait = RETRY_BACKOFF[Math.min(retryStep.current, RETRY_BACKOFF.length - 1)];
    retryStep.current += 1;
    retryTimer.current = window.setTimeout(() => {
      retryTimer.current = null;
      void flushSave();
    }, wait);
  }, [clearRetry, flushSave]);

  useEffect(() => {
    if (sync.isError && saveTimer.current === null && retryTimer.current === null) armRetry();
  }, [sync.isError, sync.failureCount, armRetry]);

  const scheduleSave = useCallback(() => {
    if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    clearRetry();
    saveTimer.current = window.setTimeout(() => { saveTimer.current = null; void flushSave(); }, SAVE_DEBOUNCE);
  }, [flushSave, clearRetry]);

  /* has anything failed to reach Postgres, or not been sent yet? */
  const pending = useCallback(
    () => saveTimer.current !== null || retryTimer.current !== null || inFlight.current > 0
      || syncRef.current.isPending || syncRef.current.isError,
    [],
  );

  /* leaving the tab with a debounce pending would otherwise drop it — and so
     would leaving it with a save that has already failed, which is the case
     the old `saveTimer.current !== null` guard never covered */
  useEffect(() => {
    const onHide = () => { if (document.hidden && pending()) void flushSave(); };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [flushSave, pending]);

  /* and closing it outright must at least ask */
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (!pending()) return;
      e.preventDefault();
      /* older browsers want the assignment; the string itself is never shown */
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [pending]);

  /* ---------- another tab ----------
     Nothing pushes changes here, so coming back to the tab is the moment to
     look. If this tab has no unsaved work, the newer state is simply adopted.
     If it does, it is NOT adopted — that would throw the user's edits away —
     and they are told the timeline moved instead of being left to discover it
     when a save quietly writes over someone else's. */
  useEffect(() => {
    let cancelled = false;
    const look = async () => {
      const draft = draftRef.current;
      const snap = qc.getQueryData<StoreData>(STORE_KEY);
      /* only a request genuinely in flight is a reason not to look; a save
         that has already failed is the case where looking matters most */
      if (!draft || !snap || syncRef.current.isPending) return;
      let fresh: StoreData;
      try { fresh = await fetchStore(); } catch { return; }
      if (cancelled || !storesDiffer(snap, fresh, ownerId)) return;
      if (pendingWrites(draft, snap, ownerId) === 0 && !syncRef.current.isError) {
        qc.setQueryData(STORE_KEY, fresh);
        draftRef.current = cloneStore(fresh);
        setWarning(null);
        setStoreRev((n) => n + 1);
        bump();
      } else {
        setWarning("This timeline changed somewhere else. Your unsaved edits are still here — reload to see the other version.");
      }
    };
    const onFocus = () => { void look(); };
    const onVisible = () => { if (!document.hidden) void look(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [qc, ownerId, bump]);

  const create = useMutation({
    scope: { id: "gantt-store-write" },
    /* `seed` is only ever set by a duplicate. The project row is inserted here;
       its tasks and links go into the draft alone and reach Postgres as the
       inserts the next diff emits — which is also what makes a failed copy
       retry itself instead of leaving half a project behind. */
    mutationFn: async ({ name, seed }: { name: string; seed?: { tasks: StoreTask[]; links: StoreLink[] } }) => {
      const draft = draftRef.current;
      const prev = qc.getQueryData<StoreData>(STORE_KEY);
      if (!draft || !prev) throw new Error("Store not loaded");
      const p: StoreProject = { id: uid(), name, view: "day", tasks: seed ? seed.tasks : [], links: seed ? seed.links : [] };
      await insertProject(p, draft.projects.length, ownerId);
      draft.projects.push(p);
      /* the mirror is what Postgres now holds — the project row and nothing
         under it, so the diff sees the seeded rows as the inserts they are */
      const mirror: StoreProject = { id: p.id, name: p.name, view: p.view, position: draft.projects.length - 1, tasks: [], links: [] };
      qc.setQueryData(STORE_KEY, { ...prev, projects: [...prev.projects, mirror] });
      return p.id;
    },
    onSuccess: bump,
  });

  const remove = useMutation({
    scope: { id: "gantt-store-write" },
    mutationFn: async (id: string) => {
      const draft = draftRef.current;
      const prev = qc.getQueryData<StoreData>(STORE_KEY);
      if (!draft || !prev) throw new Error("Store not loaded");
      /* the cascades on tasks.project_id and links.project_id take the rows
         under it; nothing else is touched */
      await deleteProject(id);
      draft.projects = draft.projects.filter((p) => p.id !== id);
      qc.setQueryData(STORE_KEY, { ...prev, projects: prev.projects.filter((p) => p.id !== id) });
    },
    onSuccess: bump,
  });

  const opened = useMutation({
    scope: { id: "gantt-store-write" },
    mutationFn: async (id: string) => {
      await setActiveProject(id, ownerId);
      const prev = qc.getQueryData<StoreData>(STORE_KEY);
      if (prev) qc.setQueryData(STORE_KEY, { ...prev, activeProject: id });
      if (draftRef.current) draftRef.current.activeProject = id;
    },
  });

  const createProject = useCallback(async (name: string) => {
    /* a project is created against the snapshot, so anything still only in the
       draft has to land first. If it cannot, ask rather than carry on. */
    const ok = await flushSave();
    if (!ok && !window.confirm(
      "Your latest changes have not reached the database yet. Create a new project anyway?",
    )) throw new Error("Cancelled — nothing was created.");
    return create.mutateAsync({ name });
  }, [flushSave, create.mutateAsync]);

  const duplicateProject = useCallback(async (id: string) => {
    const ok = await flushSave();
    if (!ok && !window.confirm(
      "Your latest changes have not reached the database yet, so the copy would be made from an older version. Duplicate anyway?",
    )) throw new Error("Cancelled — nothing was copied.");
    const draft = draftRef.current;
    const src = draft && draft.projects.find((p) => p.id === id);
    if (!draft || !src) throw new Error("That project is no longer here.");
    const name = copyName(src.name, draft.projects.map((p) => p.name));
    const newId = await create.mutateAsync({ name, seed: copyRows(src) });
    /* the copied rows exist only in the draft until this lands */
    scheduleSave();
    return newId;
  }, [flushSave, create.mutateAsync, scheduleSave]);

  /* renaming is an edit like any other: the draft leads, and the debounced diff
     turns it into the one project row that changed */
  const renameProject = useCallback((id: string, name: string) => {
    const draft = draftRef.current;
    const p = draft && draft.projects.find((x) => x.id === id);
    if (!p || p.name === name) return;
    p.name = name;
    bump();
    scheduleSave();
  }, [bump, scheduleSave]);

  const removeProject = useCallback(async (id: string) => {
    const ok = await flushSave();
    if (!ok && !window.confirm(
      "Your latest changes have not reached the database yet, and deleting a project cannot be undone. Delete it anyway?",
    )) return;
    await remove.mutateAsync(id);
  }, [flushSave, remove.mutateAsync]);

  const markOpened = useCallback((id: string) => {
    const snap = qc.getQueryData<StoreData>(STORE_KEY);
    if (!id || !snap || snap.activeProject === id) return;
    opened.mutate(id);
  }, [qc, opened.mutate]);

  const status: SaveStatus = sync.isPending ? "saving" : sync.isError ? "local" : sync.isSuccess ? "saved" : "idle";
  /* every write mutation reports here, `opened` included — it was the one
     whose failure had nowhere to go, which is exactly why the app_state
     collision below it could never be seen */
  const error = sync.error ? msg(sync.error)
    : create.error ? msg(create.error)
    : remove.error ? msg(remove.error)
    : opened.error ? "Could not record which project was open: " + msg(opened.error)
    : null;
  const conflict = sync.error && isConflict(sync.error);
  const draft = draftRef.current;

  /* the value is rebuilt whenever the draft is bumped, so consumers reading
     draft.projects / draft.people re-render with it */
  const value = useMemo<StoreApi | null>(() => {
    if (!draft) return null;
    return {
      ownerId,
      draft,
      projects: draft.projects,
      people: draft.people,
      status,
      error,
      warning: conflict ? null : warning,
      storeRev,
      bump,
      scheduleSave,
      flushSave,
      createProject,
      duplicateProject,
      removeProject,
      renameProject,
      markOpened,
    };
    /* `rev` is the dependency that matters: the draft object keeps its
       identity while its contents change, so bump() is what re-publishes it */
  }, [rev, draft, ownerId, status, error, warning, conflict, storeRev, bump, scheduleSave, flushSave, createProject, duplicateProject, removeProject, renameProject, markOpened]);

  if (query.isError) {
    return (
      <div className="grid min-h-screen place-items-center bg-ground p-6 text-center font-ui text-body text-muted">
        Could not reach Supabase: {msg(query.error)} — refresh to retry.
      </div>
    );
  }
  if (!value) {
    return <div className="grid min-h-screen place-items-center bg-ground font-ui text-body text-muted">Loading…</div>;
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
