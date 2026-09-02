#!/usr/bin/env python3
"""Regenerate icons.css and the mask URLs in wx-overrides.css from Phosphor's
raw SVG assets (@phosphor-icons/core). Run from the repo root."""
import os, re, sys

REPO = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(
    os.path.abspath(os.path.dirname(__file__))
)
ASSETS = os.path.join(REPO, "node_modules/@phosphor-icons/core/assets")


def data_uri(weight, name):
    path = os.path.join(ASSETS, weight, name + ".svg")
    svg = open(path).read().strip()
    svg = svg.replace('fill="currentColor"', 'fill="#000"')
    svg = svg.replace('"', "'")
    svg = re.sub(r"\s+", " ", svg)
    out = (
        svg.replace("%", "%25")
        .replace("#", "%23")
        .replace("<", "%3C")
        .replace(">", "%3E")
    )
    return 'url("data:image/svg+xml,' + out + '")'


R = lambda n: data_uri("regular", n)
F = lambda n: data_uri("fill", n + "-fill")

# SVAR injects these class names itself; the mask keeps them CSP-safe and lets
# them follow currentColor.
WXI = [
    (".wxi-plus", R("plus")),
    (".wxi-close", R("x")),
    (".wxi-check", R("check")),
    (".wxi-angle-down", R("caret-down")),
    (".wxi-angle-up", R("caret-up")),
    (".wxi-angle-left", R("caret-left")),
    (".wxi-angle-right", R("caret-right")),
    (".wxi-angle-dbl-left", R("caret-double-left")),
    (".wxi-angle-dbl-right", R("caret-double-right")),
    (".wxi-menu-right", F("caret-right")),
    (".wxi-menu-left", F("caret-left")),
    (".wxi-menu-down", F("caret-down")),
    (".wxi-edit, .wxi-edit-outline", R("pencil-simple")),
    (".wxi-delete, .wxi-delete-outline", R("trash")),
    (".wxi-calendar", R("calendar-blank")),
    (".wxi-clock", R("clock")),
    (".wxi-eye", R("eye")),
    (".wxi-drag", R("dots-six-vertical")),
    (".wxi-dots-h", R("dots-three")),
    (".wxi-dots-v", R("dots-three-vertical")),
    (".wxi-content-copy", R("copy")),
    (".wxi-content-cut", R("scissors")),
    (".wxi-content-paste", R("clipboard")),
    (".wxi-indent", R("text-indent")),
    (".wxi-unindent", R("text-outdent")),
    (".wxi-swap-horizontal", R("arrows-left-right")),
    (".wxi-swap-vertical", R("arrows-down-up")),
    (".wxi-arrow-up", R("arrow-up")),
    (".wxi-arrow-down", R("arrow-down")),
    (".wxi-search", R("magnifying-glass")),
    (".wxi-empty", None),
    (".wxi-filter-plus-outline, .wxi-filter-multiple-outline", R("funnel")),
]

head = """/* Phosphor icon masks.
   SVAR injects its own `<i class="wxi-…">` markup, so the library's icon set is
   reimplemented here as currentColor mask-image data URIs pointing at Phosphor
   glyphs (@phosphor-icons/core). Anything React renders uses the
   @phosphor-icons/react components instead. Regenerate with
   scripts/gen-icons.py if the mapping changes.

   Tagger-created nodes (the fold-all chevron below, the type icons and the row
   pencil in wx-overrides.css) live in CSS for the same reason: they are built
   in plain JS, so Tailwind's scanner would never see utility class names on
   them. */
[class^="wxi-"]::before, [class*=" wxi-"]::before {
  content: "";
  display: inline-block;
  width: 1em;
  height: 1em;
  vertical-align: -0.125em;
  background-color: currentColor;
  -webkit-mask: var(--wxi, none) center / contain no-repeat;
  mask: var(--wxi, none) center / contain no-repeat;
}
"""

lines = [head]
for sel, uri in WXI:
    lines.append("%s { --wxi: %s; }" % (sel, uri if uri else "none"))

lines.append(
    """
/* fold-all toggle in the Task name header (built by the row tagger) */
.ci {
  width: 16px;
  height: 16px;
  background: currentColor;
  -webkit-mask: var(--ci) center/contain no-repeat;
  mask: var(--ci) center/contain no-repeat;
}"""
)
lines.append(".ci-collapse { --ci: %s; }" % R("arrows-in-line-vertical"))
lines.append(".ci-expand { --ci: %s; }" % R("arrows-out-line-vertical"))

open(os.path.join(REPO, "icons.css"), "w").write("\n".join(lines) + "\n")

# ---- wx-overrides.css: type icons + the hover pencil ----
TI = {
    "ti-summary": R("crown"),
    "ti-backend": R("hard-drives"),
    "ti-frontend": R("app-window"),
    "ti-design": R("paint-brush"),
    "ti-testing": R("flask"),
    "ti-milestone": R("diamond"),
    "ti-task": R("check-square"),
}
wx_path = os.path.join(REPO, "wx-overrides.css")
wx = open(wx_path).read()
for cls, uri in TI.items():
    pat = re.compile(
        r"(\.wx-willow-theme \." + cls + r" \{[^}]*?--ti: )url\(\"[^\"]*\"\)"
    )
    wx, n = pat.subn(lambda m: m.group(1) + uri, wx)
    if n != 1:
        raise SystemExit("type icon %s: %d replacements" % (cls, n))

pencil = R("pencil-simple")
block = re.search(r"\.wx-willow-theme \.row-edit \{.*?\n\}", wx, re.S)
if not block:
    raise SystemExit("row-edit block not found")
patched, n = re.subn(
    r'url\("data:image/svg\+xml,[^"]*"\)', lambda m: pencil, block.group(0)
)
if n != 2:
    raise SystemExit("row-edit pencil: %d replacements" % n)
wx = wx[: block.start()] + patched + wx[block.end() :]
open(wx_path, "w").write(wx)
print("icons.css + wx-overrides.css regenerated")
