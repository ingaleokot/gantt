/* People-roster helpers shared by the editor and the public viewer.

   The roster UI itself (the People popover, the Who column and its picker)
   stays inside features/gantt/Editor.tsx: it is woven into the MutationObserver
   row tagger, and pulling it out would be a rewrite rather than a move. What
   lives here is the part that is genuinely standalone — the pure functions both
   screens had a byte-identical copy of.

   Nothing in this module may import from lib/: ShareViewer.tsx uses it, and the
   public page must never reach the Supabase client. */

/* `tasks.assignees` is a comma-separated list of people ids */
export function parseAssignees(v: unknown): string[] {
  return String(v || "").split(/[,;]/).map((s) => s.trim()).filter(Boolean);
}

/* "Inga Kot" → "IK"; "Inga" → "IN" */
export function initialsOf(name: string | undefined): string {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/* stable per-name hue so the same person keeps the same chip color */
export function nameHue(name: string | undefined): number {
  const s = String(name || "");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}
