/* ---------------------------------------------------------------------------
   Phosphor glyphs for the nodes the MutationObserver tagger builds by hand.

   Those nodes are appended into SVAR-managed DOM in plain JS, so they cannot be
   JSX — but there is no reason for them to be CSS mask hacks either. Each glyph
   is rendered ONCE from its real @phosphor-icons/react component into a detached
   node (see ./lib/render-icon), and the resulting SVG markup is cached at module
   scope; the tagger then just assigns that string. The tagger re-runs on every
   widget mutation, so the render must never happen per row — hence the cache and
   the `__glyph` guard.

   The append-only contract is unchanged: these are still nodes we create and
   append ourselves, and no React root is ever mounted inside the widget's DOM —
   the root lives on a detached <div> and its markup is copied out.

   The other half of the icon story is ./lib/wxi-masks: SVAR injects its own
   `<i class="wxi-…">` elements, which we never render, so there is no React slot
   to fill. Those are masked from custom properties generated out of the same
   @phosphor-icons/react components. Between the two there is exactly one icon
   package in the app.
--------------------------------------------------------------------------- */
import {
  AppWindow,
  ArrowsInLineVertical,
  ArrowsOutLineVertical,
  CheckSquare,
  Crown,
  Diamond,
  Flask,
  HardDrives,
  PaintBrush,
  PencilSimple,
  Plus,
  type Icon,
} from "@phosphor-icons/react";
import { renderIcon } from "./lib/render-icon";

/* keys double as the tagger's semantic class suffixes (ti-summary, ci-expand…),
   so a name is enough to pick both the glyph and its CSS hook */
const GLYPHS: Record<string, Icon> = {
  "ti-summary": Crown,
  "ti-backend": HardDrives,
  "ti-frontend": AppWindow,
  "ti-design": PaintBrush,
  "ti-testing": Flask,
  "ti-milestone": Diamond,
  "ti-task": CheckSquare,
  "row-edit": PencilSimple,
  "ci-collapse": ArrowsInLineVertical,
  "ci-expand": ArrowsOutLineVertical,
  "who-add": Plus,
};

/* the tagger stamps the glyph name onto the node it wrote, so a re-run can
   tell "already showing this one" from "needs rewriting" without reading DOM */
export type GlyphHost = HTMLElement & { __glyph?: string };

const cache = new Map<string, string>();

/* the SVG markup for one glyph — rendered at most once per name per session */
export function glyphMarkup(name: string): string {
  let html = cache.get(name);
  if (html !== undefined) return html;
  const icon = GLYPHS[name] || GLYPHS["ti-task"];
  /* width/height come off the element so CSS owns the box; fill stays
     currentColor so the per-type colors live in styles/wx-overrides.css */
  const svg = renderIcon(icon, { width: "100%", height: "100%", "aria-hidden": "true" });
  html = svg ? svg.outerHTML : "";
  cache.set(name, html);
  return html;
}

/* idempotent: writes the glyph only when the element is not already showing it */
export function setGlyph(el: GlyphHost | null | undefined, name: string): void {
  if (!el || el.__glyph === name) return;
  el.__glyph = name;
  el.innerHTML = glyphMarkup(name);
}
