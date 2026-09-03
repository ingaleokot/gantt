/* Yandex Tracker link → the PRODUCT-XXXX id the grid shows in its own column.
   Shared by the editor and the public viewer, so it must not reach lib/. */

/* "…/PRODUCT-1234" → "PRODUCT-1234" */
export function trackerId(url: string | null | undefined): string | null {
  const m = /([A-Za-z][A-Za-z0-9_]*-\d+)\/?(?:[?#].*)?$/.exec(url || "");
  return m ? m[1].toUpperCase() : null;
}
