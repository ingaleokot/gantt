import { Link, Outlet, createRootRouteWithContext } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";

/* Nothing here may import the Supabase client, directly or transitively: the
   route tree is eager (it is what decides which route matches), so anything it
   pulls in ships to the public /share pages too. Auth reaches the tree through
   lib/auth.ts, which imports the client dynamically. */

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: () => <Outlet />,
  notFoundComponent: () => (
    <div className="grid min-h-screen place-items-center bg-ground p-6 text-center font-ui text-body text-muted">
      <div>
        <p className="m-0 mb-2 font-display text-title font-semibold text-ink">No such page</p>
        <Link to="/" className="text-accent underline">Back to your projects</Link>
      </div>
    </div>
  ),
});
