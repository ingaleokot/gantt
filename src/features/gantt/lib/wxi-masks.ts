/* CSS masks for SVAR's own icon markup, generated from @phosphor-icons/react.

   SVAR injects `<i class="wxi-…">` elements itself — toolbar buttons, tree
   carets, editor chrome, the context menu. We never render those elements, so
   there is no React slot to put a <Phosphor /> component into, and its shipped
   types expose no icon slot or render prop either (checked: nothing icon-shaped
   in @svar-ui/react-gantt/types). Writing into those nodes with innerHTML is
   out — they are library-rendered, and the append-only rule the row tagger
   follows exists precisely to keep us out of React-managed DOM. A currentColor
   `mask-image` on `::before` is what is left, and it touches nothing SVAR owns.

   What changed: the masks used to point at .svg files inside
   @phosphor-icons/core, a second copy of the icon set. Now each glyph is
   rendered ONCE from the same @phosphor-icons/react component the rest of the
   app uses, serialised to a `svg+xml` data URI and published as a custom
   property on :root, which styles/icons.css reads as `var(--wxi-plus, none)`.
   One icon package, one source of truth, no generation step.

   `color: "#000"` rather than currentColor: a mask document reads alpha only,
   so an explicitly opaque fill is what makes the glyph show up. The `, none`
   fallback in icons.css matters — an unset variable would leave `mask-image`
   invalid, and the ::before would paint as a solid currentColor square. */
import {
  ArrowDown,
  ArrowUp,
  ArrowsDownUp,
  ArrowsLeftRight,
  CalendarBlank,
  CaretDoubleLeft,
  CaretDoubleRight,
  CaretDown,
  CaretLeft,
  CaretRight,
  CaretUp,
  Check,
  Clipboard,
  Clock,
  Copy,
  DotsSixVertical,
  DotsThree,
  DotsThreeVertical,
  Eye,
  Funnel,
  MagnifyingGlass,
  PencilSimple,
  Plus,
  Scissors,
  TextIndent,
  TextOutdent,
  Trash,
  X,
  type Icon,
  type IconWeight,
} from "@phosphor-icons/react";
import { renderIcon } from "./render-icon";

/* keys are the custom-property names styles/icons.css reads; aliases
   (wxi-edit-outline, wxi-filter-multiple-outline…) point at the same var
   there rather than rendering the glyph twice */
const WXI: Record<string, { icon: Icon; weight?: IconWeight }> = {
  "wxi-plus": { icon: Plus },
  "wxi-close": { icon: X },
  "wxi-check": { icon: Check },
  "wxi-angle-down": { icon: CaretDown },
  "wxi-angle-up": { icon: CaretUp },
  "wxi-angle-left": { icon: CaretLeft },
  "wxi-angle-right": { icon: CaretRight },
  "wxi-angle-dbl-left": { icon: CaretDoubleLeft },
  "wxi-angle-dbl-right": { icon: CaretDoubleRight },
  /* SVAR's menu carets are solid triangles, so these three take the fill weight */
  "wxi-menu-right": { icon: CaretRight, weight: "fill" },
  "wxi-menu-left": { icon: CaretLeft, weight: "fill" },
  "wxi-menu-down": { icon: CaretDown, weight: "fill" },
  "wxi-edit": { icon: PencilSimple },
  "wxi-delete": { icon: Trash },
  "wxi-calendar": { icon: CalendarBlank },
  "wxi-clock": { icon: Clock },
  "wxi-eye": { icon: Eye },
  "wxi-drag": { icon: DotsSixVertical },
  "wxi-dots-h": { icon: DotsThree },
  "wxi-dots-v": { icon: DotsThreeVertical },
  "wxi-content-copy": { icon: Copy },
  "wxi-content-cut": { icon: Scissors },
  "wxi-content-paste": { icon: Clipboard },
  "wxi-indent": { icon: TextIndent },
  "wxi-unindent": { icon: TextOutdent },
  "wxi-swap-horizontal": { icon: ArrowsLeftRight },
  "wxi-swap-vertical": { icon: ArrowsDownUp },
  "wxi-arrow-up": { icon: ArrowUp },
  "wxi-arrow-down": { icon: ArrowDown },
  "wxi-search": { icon: MagnifyingGlass },
  "wxi-filter": { icon: Funnel },
};

let installed = false;

/* Idempotent, and cheap after the first call. Both gantt screens call it as
   they load their chunk, so the variables are on :root before the widget has
   drawn a single <i>. */
export function installWxiMasks(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  const style = document.documentElement.style;
  const serializer = new XMLSerializer();
  for (const name of Object.keys(WXI)) {
    const def = WXI[name];
    /* 256 = Phosphor's own viewBox, so the mask has an intrinsic size for
       `mask-size: contain` to work from */
    const svg = renderIcon(def.icon, { size: 256, color: "#000", weight: def.weight ?? "regular" });
    if (!svg) continue;
    /* XMLSerializer, not innerHTML: a data URI is parsed as a standalone
       document and needs the xmlns declaration spelled out */
    const markup = serializer.serializeToString(svg);
    style.setProperty(`--${name}`, `url("data:image/svg+xml,${encodeURIComponent(markup)}")`);
  }
}
