import { Link, Outlet, createRootRouteWithContext } from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";

/* Nothing here may import the Supabase client, directly or transitively: the
   route tree is eager (it is what decides which route matches), so anything it
   pulls in ships to the public /share pages too. Auth reaches the tree through
   features/auth/api/auth.ts, which imports the client dynamically. */

const SHELL = "grid min-h-screen place-items-center bg-ground p-6 text-center font-ui text-body text-muted";
const LINK = "press inline-flex cursor-pointer items-center rounded-lg border-0 bg-accent px-3.5 py-2 font-ui text-body font-semibold text-accent-ink no-underline hover:brightness-[1.08] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent";

/* A throw from inside the gantt widget used to take the whole page with it and
   leave nothing to click. It is still a bug when it happens, but it must not
   be a dead end: the message says what broke and both ways out are one click
   away, and the timeline itself is safe — it is in Postgres, not on screen. */
function RouteError({ error, reset }: ErrorComponentProps) {
  const text = error instanceof Error ? error.message : String(error);
  return (
    <div className={SHELL}>
      <div className="max-w-[460px]">
        <p className="m-0 mb-2 font-display text-title font-semibold text-ink">This view could not be drawn</p>
        <p className="m-0 mb-4 text-copy">
          Your timeline is safe — it is stored in the database, not in this page.
        </p>
        <pre className="m-0 mb-5 overflow-x-auto rounded-lg border border-line bg-surface-alt px-3 py-2 text-left font-mono text-mini text-ink">{text}</pre>
        <div className="flex justify-center gap-2">
          <button type="button" className={LINK} onClick={reset}>Try again</button>
          <Link to="/" className={LINK}>Back to your projects</Link>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: () => <Outlet />,
  errorComponent: RouteError,
  notFoundComponent: () => (
    <div className={SHELL}>
      <div>
        <p className="m-0 mb-2 font-display text-title font-semibold text-ink">No such page</p>
        <Link to="/" className="text-accent underline">Back to your projects</Link>
      </div>
    </div>
  ),
});
