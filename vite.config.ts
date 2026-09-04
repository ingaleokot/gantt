import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { copyFileSync, existsSync } from "fs";
import { resolve } from "path";

/* SVAR ships @font-face rules that pull Roboto/Open Sans from its own CDN.
   The app supplies its own faces (and passes fonts={false} to Willow), so
   drop them — otherwise the widget silently restyles itself mid-load. */
const stripSvarFonts: Plugin = {
  name: "strip-svar-fontface",
  enforce: "pre",
  transform(code: string, id: string) {
    if (id.includes("@svar-ui") && id.endsWith(".css")) {
      return { code: code.replace(/@font-face\{[^}]*\}/g, ""), map: null };
    }
    return null;
  },
};

/* GitHub Pages has no SPA rewrite: it serves 404.html for any path without a
   file, so a hard refresh on /gantt/p/<id> needs 404.html to BE the app. This
   only ever fails in production — `vite dev` and `vite preview` both rewrite
   to index.html on their own. */
const pagesFallback: Plugin = {
  name: "pages-404-fallback",
  apply: "build",
  closeBundle() {
    const index = resolve(import.meta.dirname, "dist/index.html");
    if (existsSync(index)) copyFileSync(index, resolve(import.meta.dirname, "dist/404.html"));
  },
};

export default defineConfig({
  base: process.env.VITE_BASE_PATH || "/gantt/",
  /* tanstackRouter regenerates src/routeTree.gen.ts and must run before the
     React plugin; stripSvarFonts keeps enforce:"pre" so it rewrites SVAR's CSS
     before Tailwind and Vite's own CSS pipeline see it */
  plugins: [
    tanstackRouter({
      target: "react",
      routesDirectory: "./src/routes",
      generatedRouteTree: "./src/routeTree.gen.ts",
      /* route components (and everything only they import) become their own
         chunks, which is what keeps supabase-js out of the public /share page */
      autoCodeSplitting: true,
    }),
    react(),
    stripSvarFonts,
    tailwindcss(),
    pagesFallback,
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
