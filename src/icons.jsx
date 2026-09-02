/* ---------------------------------------------------------------------------
   Phosphor glyphs for the nodes the MutationObserver tagger builds by hand.

   Those nodes are appended into SVAR-managed DOM in plain JS, so they cannot be
   JSX — but there is no reason for them to be CSS mask hacks either. Each glyph
   is rendered ONCE from its real @phosphor-icons/react component into a detached
   node, and the resulting SVG markup is cached at module scope; the tagger then
   just assigns that string. The tagger re-runs on every widget mutation, so the
   render must never happen per row — hence the cache and the `__glyph` guard.

   Why a detached React root and not renderToStaticMarkup: `react-dom/server`
   adds ~220 kB (68 kB gzip) to the shared chunk, which both the editor and the
   public viewer would pay for eleven small icons. `createRoot` + `flushSync`
   uses the react-dom that is already loaded and costs nothing. The call happens
   from a requestAnimationFrame callback, never from inside a React render, so
   the synchronous flush is safe.

   The append-only contract is unchanged: these are still nodes we create and
   append ourselves, and no React root is ever mounted inside the widget's DOM —
   the root lives on a detached <div> and its markup is copied out.

   The one place that still uses CSS mask-image is `icons.css`: SVAR injects its
   own `<i class="wxi-…">` elements, which we never render, so there is no React
   slot to fill there. See the header of that file.
--------------------------------------------------------------------------- */
import React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
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
} from "@phosphor-icons/react";

/* keys double as the tagger's semantic class suffixes (ti-summary, ci-expand…),
   so a name is enough to pick both the glyph and its CSS hook */
const GLYPHS = {
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

const cache = new Map();
let scratch = null; /* one detached host + root, reused for every glyph */

/* the SVG markup for one glyph — rendered at most once per name per session */
export function glyphMarkup(name) {
  let html = cache.get(name);
  if (html !== undefined) return html;
  const Icon = GLYPHS[name] || GLYPHS["ti-task"];
  try {
    if (!scratch) {
      const host = document.createElement("div");
      scratch = { host, root: createRoot(host) };
    }
    /* width/height come off the element so CSS owns the box; fill stays
       currentColor so the per-type colors live in wx-overrides.css */
    flushSync(() => {
      scratch.root.render(<Icon width="100%" height="100%" aria-hidden="true" />);
    });
    html = scratch.host.innerHTML;
  } catch (e) {
    html = "";
  }
  cache.set(name, html);
  return html;
}

/* idempotent: writes the glyph only when the element is not already showing it */
export function setGlyph(el, name) {
  if (!el || el.__glyph === name) return;
  el.__glyph = name;
  el.innerHTML = glyphMarkup(name);
}
