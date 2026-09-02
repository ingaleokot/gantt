/// <reference types="vite/client" />
import type { IApi } from "@svar-ui/react-gantt";
import type { Root } from "react-dom/client";

declare global {
  /* The two public client credentials the entries read through
     import.meta.env. vite/client already declares BASE_URL and friends; this
     only narrows ours from the `any` its index signature hands back. */
  interface ImportMetaEnv {
    readonly VITE_SUPABASE_URL: string;
    readonly VITE_SUPABASE_PUBLISHABLE_KEY: string;
  }

  interface Window {
    /* optional debug/probe hook: handed the gantt api on mount if present */
    __ganttProbe?: (api: IApi) => void;
  }

  /* both entries cache their React root on the mount container so a dev
     hot-reload re-renders instead of creating a second root */
  interface HTMLElement {
    __root?: Root;
  }
}

declare module "react" {
  /* the Who chips carry their hue as a CSS custom property, which
     React.CSSProperties does not model out of the box */
  interface CSSProperties {
    [key: `--${string}`]: string | number | undefined;
  }
}
