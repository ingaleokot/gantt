import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

/* stylesheet order matters: shell tokens, then the widget theme, then our
   re-skin on top of it. One entry now serves both the editor and the public
   viewer, so the imports live here rather than in each screen. */
import "./styles/style.css";
import "@svar-ui/react-gantt/all.css";
import "./styles/wx-overrides.css";
import "./styles/icons.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false },
    mutations: { retry: 0 },
  },
});

/* `basepath` is the Vite base ("/gantt/") — GitHub Pages serves the app from
   there, and dist/404.html is what makes a hard refresh on a deep link work
   (Pages has no SPA rewrite). */
const router = createRouter({
  routeTree,
  basepath: import.meta.env.BASE_URL,
  context: { queryClient },
  defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

/* the root is cached on the container so a dev hot-reload of this module
   re-renders instead of creating a second root */
const container = document.getElementById("app") as HTMLElement;
container.__root = container.__root || createRoot(container);
container.__root.render(
  <QueryClientProvider client={queryClient}>
    <RouterProvider router={router} />
  </QueryClientProvider>,
);
