import { createFileRoute, redirect } from "@tanstack/react-router";
import SignInPage from "../features/auth/components/SignInPage";
import { currentSession } from "../features/auth/api/auth";
import { useRedirectWhenSignedIn } from "../features/auth/hooks/useSessionRedirect";

/* the other half of the gate in _authed.tsx: a live session has no business
   sitting on the sign-in screen.

   Nothing here reaches lib/supabase at the top level — the route tree is eager,
   and features/auth/api/auth.ts is the seam that imports the client inside each
   call instead. */
export const Route = createFileRoute("/login")({
  beforeLoad: async () => {
    if (await currentSession()) throw redirect({ to: "/" });
  },
  component: LoginRoute,
});

function LoginRoute() {
  useRedirectWhenSignedIn();
  return <SignInPage />;
}
