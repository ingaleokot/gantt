import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
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

export default defineConfig({
  base: "/gantt/",
  /* stripSvarFonts keeps enforce:"pre" so it rewrites SVAR's CSS before
     Tailwind and Vite's own CSS pipeline see it */
  plugins: [react(), stripSvarFonts, tailwindcss()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        share: resolve(import.meta.dirname, "share/index.html"),
      },
    },
  },
});
