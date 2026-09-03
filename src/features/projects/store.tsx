import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { cloneStore, deleteProject, fetchStore, insertProject, saveStore, setActiveProject } from "../../lib/db";
import type { Person, StoreData, StoreProject } from "../../lib/db";

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
   rows instead of a wipe. */

export const STORE_KEY = ["store"] as const;
export const storeQuery = queryOptions({
  queryKey: STORE_KEY,
  queryFn: fetchStore,
  staleTime: Infinity,
  refetchOnWindowFocus: false,
});

export const uid = () => "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/* long enough to batch a drag, short enough that nothing is lost on a reload */
const SAVE_DEBOUNCE = 1400;

export type SaveStatus = "idle" | "saving" | "saved" | "local";

export interface StoreApi {
  ownerId: string;
  /* the live draft; mutate it, then call scheduleSave() */
  draft: StoreData;
  projects: StoreProject[];
  people: Person[];
  status: SaveStatus;
  error: string | null;
  /* re-render everything reading the draft (project names, roster) */
  bump: () => void;
  scheduleSave: () => void;
  flushSave: () => Promise<void>;
  createProject: (name: string) => Promise<string>;
  removeProject: (id: string) => Promise<void>;
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
  const bump = useCallback(() => setRev((r) => r + 1), []);
  const saveTimer = useRef<number | null>(null);

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
      return desired;
    },
    onSuccess: (desired) => { qc.setQueryData(STORE_KEY, desired); },
  });

  const flushSave = useCallback(async () => {
    if (saveTimer.current !== null) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    if (!draftRef.current || !qc.getQueryData<StoreData>(STORE_KEY)) return;
    try { await sync.mutateAsync(); } catch { /* the failure is on sync.error */ }
  }, [qc, sync.mutateAsync]);

  const scheduleSave = useCallback(() => {
    if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => { saveTimer.current = null; void flushSave(); }, SAVE_DEBOUNCE);
  }, [flushSave]);

  /* leaving the tab with a debounce pending would otherwise drop it */
  useEffect(() => {
    const onHide = () => { if (document.hidden && saveTimer.current !== null) void flushSave(); };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [flushSave]);

  const create = useMutation({
    scope: { id: "gantt-store-write" },
    mutationFn: async (name: string) => {
      const draft = draftRef.current;
      const prev = qc.getQueryData<StoreData>(STORE_KEY);
      if (!draft || !prev) throw new Error("Store not loaded");
      const p: StoreProject = { id: uid(), name, view: "day", tasks: [], links: [] };
      await insertProject(p, draft.projects.length, ownerId);
      draft.projects.push(p);
      const mirror: StoreProject = { id: p.id, name: p.name, view: p.view, tasks: [], links: [] };
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
    await flushSave();
    return create.mutateAsync(name);
  }, [flushSave, create.mutateAsync]);

  const removeProject = useCallback(async (id: string) => {
    await flushSave();
    await remove.mutateAsync(id);
  }, [flushSave, remove.mutateAsync]);

  const markOpened = useCallback((id: string) => {
    const snap = qc.getQueryData<StoreData>(STORE_KEY);
    if (!id || !snap || snap.activeProject === id) return;
    opened.mutate(id);
  }, [qc, opened.mutate]);

  const status: SaveStatus = sync.isPending ? "saving" : sync.isError ? "local" : sync.isSuccess ? "saved" : "idle";
  const error = sync.error ? msg(sync.error) : create.error ? msg(create.error) : remove.error ? msg(remove.error) : null;
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
      bump,
      scheduleSave,
      flushSave,
      createProject,
      removeProject,
      markOpened,
    };
    /* `rev` is the dependency that matters: the draft object keeps its
       identity while its contents change, so bump() is what re-publishes it */
  }, [rev, draft, ownerId, status, error, bump, scheduleSave, flushSave, createProject, removeProject, markOpened]);

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
