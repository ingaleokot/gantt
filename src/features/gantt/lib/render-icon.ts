/* Render a @phosphor-icons/react component into real SVG, outside React.

   Two callers need this, and both need it exactly once per glyph:
     - ../icons.tsx, for the nodes the MutationObserver row tagger appends
       (it copies the markup with innerHTML)
     - ./wxi-masks.ts, for the CSS masks that reskin SVAR's own <i class="wxi-…">
       elements (it serialises the SVG into a data URI)

   Why a detached React root and not `react-dom/server`: renderToStaticMarkup
   costs ~220 kB (68 kB gzip) in the shared chunk, which the public viewer would
   pay too. `createRoot` + `flushSync` reuses the react-dom that is already
   loaded and costs nothing. One host and one root are reused for every glyph.

   The synchronous flush is only safe outside a React render, so every caller
   must be a module-scope/rAF/effect path — never a component body. */
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { Icon, IconProps } from "@phosphor-icons/react";

let scratch: { host: HTMLDivElement; root: Root } | null = null;

/* the live <svg> the component rendered, still attached to the scratch host —
   copy what you need out of it before the next call overwrites it */
export function renderIcon(icon: Icon, props: IconProps): SVGSVGElement | null {
  try {
    if (!scratch) {
      const host = document.createElement("div");
      scratch = { host, root: createRoot(host) };
    }
    const active = scratch;
    flushSync(() => { active.root.render(createElement(icon, props)); });
    return active.host.querySelector("svg");
  } catch (e) {
    return null;
  }
}
