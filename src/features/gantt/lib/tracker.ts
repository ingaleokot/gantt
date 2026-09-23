/* Yandex Tracker link → the PRODUCT-XXXX id the grid shows in its own column.
   Shared by the editor and the public viewer, so it must not reach lib/. */

/* "…/PRODUCT-1234" → "PRODUCT-1234" */
export function trackerId(url: string | null | undefined): string | null {
  const m = /([A-Za-z][A-Za-z0-9_]*-\d+)\/?(?:[?#].*)?$/.exec(url || "");
  return m ? m[1].toUpperCase() : null;
}

/* "PRODUCT-1234" → "1234". The queue prefix is the same on every row of a
   project, so printing it on every row spends the ID column's width saying
   nothing — the number is the part that differs. The full key stays in the
   link's `title`, so hovering still tells you which queue it is. */
export function trackerNumber(id: string | null | undefined): string | null {
  if (!id) return null;
  const m = /-(\d+)$/.exec(id);
  return m ? m[1] : id;
}
