import { createFileRoute, redirect } from "@tanstack/react-router";
import SignUpPage from "../features/auth/components/SignUpPage";
import { currentSession } from "../features/auth/api/auth";
import { useRedirectWhenSignedIn } from "../features/auth/hooks/useSessionRedirect";

/* When the project does not require email confirmation, signUp hands back a
   session straight away — the hook is what notices and moves on. */
export const Route = createFileRoute("/signup")({
  beforeLoad: async () => {
    if (await currentSession()) throw redirect({ to: "/" });
  },
  component: SignUpRoute,
});

function SignUpRoute() {
  useRedirectWhenSignedIn();
  return <SignUpPage />;
}
