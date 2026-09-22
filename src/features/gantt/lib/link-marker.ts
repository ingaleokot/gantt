/* ---------------------------------------------------------------------------
   The arrowhead on a dependency link, and the hint on the handle you drag to
   make one.

   SVAR draws every link as two coincident polylines inside a single
   `<svg class="wx-links">` — `.wx-line-draw`, which you see, and
   `.wx-line-hitbox`, a 20px transparent stroke that makes the thin line
   clickable. It ships no `<marker>` of any kind, and its shipped types expose
   no slot to render one through, so a connector arrived as a bare elbow with
   nothing at either end: you could tell two bars were joined, but not which
   way round the dependency ran.

   So one `<defs>` is APPENDED to that svg — appended, never inserted, the same
   contract every node the row tagger owns is built under, because the
   polylines beside it are React's. React adds to the end, removes by node and
   inserts before a node it already owns, so a `<defs>` sitting at the end is
   never in its way. `styles/wx-overrides.css` then points
   `.wx-line-draw { marker-end: url(#wx-link-arrow) }` at it.

   The head is filled from `--color-link` through a class rather than from
   `fill: context-stroke`, which is still not safe to rely on everywhere.

   Neither function may import from `src/lib/` — `ShareViewer.tsx` calls both,
   and anything reaching the Supabase client from here would put it on a public
   page.
--------------------------------------------------------------------------- */
const SVG_NS = "http://www.w3.org/2000/svg";
export const LINK_ARROW_ID = "wx-link-arrow";

/* Idempotent, and called from the tagger rather than once at mount: the svg
   does not exist until the chart has drawn, the widget remounts on undo and on
   every project change, and a `<defs>` that is already there costs one
   `querySelector` to skip. */
export function ensureLinkArrowMarker(root: ParentNode = document): void {
  const svg = root.querySelector<SVGSVGElement>(".gantt-holder svg.wx-links");
  if (!svg || svg.querySelector("#" + LINK_ARROW_ID)) return;

  const defs = document.createElementNS(SVG_NS, "defs");
  const marker = document.createElementNS(SVG_NS, "marker");
  marker.setAttribute("id", LINK_ARROW_ID);
  marker.setAttribute("viewBox", "0 0 8 8");
  /* refX sits the tip ON the line's last point, refY centres it across the
     stroke; markerUnits=strokeWidth keeps the head in proportion when the
     hover rule thickens the line */
  marker.setAttribute("refX", "6.4");
  marker.setAttribute("refY", "4");
  marker.setAttribute("markerWidth", "5");
  marker.setAttribute("markerHeight", "5");
  marker.setAttribute("markerUnits", "strokeWidth");
  marker.setAttribute("orient", "auto-start-reverse");

  const head = document.createElementNS(SVG_NS, "path");
  head.setAttribute("class", "wx-link-arrow-head");
  head.setAttribute("d", "M0.6 0.9 L7 4 L0.6 7.1 Z");

  marker.appendChild(head);
  defs.appendChild(marker);
  svg.appendChild(defs);
}

/* The two discs SVAR reveals on bar hover are how a link is created, and
   nothing on screen said so. `title` is not a prop the library sets, so
   writing it here cannot be clobbered by a re-render — and unlike a tooltip of
   our own it needs no node inside markup we do not own. */
export function labelLinkHandles(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>(".gantt-holder .wx-bar .wx-link").forEach((h) => {
    const from = h.classList.contains("wx-left") ? "start" : "end";
    const label = "Drag from here to link this task's " + from + " to another task";
    if (h.title !== label) {
      h.title = label;
      h.setAttribute("aria-label", label);
    }
  });
}
