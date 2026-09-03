import { createFileRoute, redirect } from "@tanstack/react-router";
import ForgotPasswordPage from "../features/auth/components/ForgotPasswordPage";
import { currentSession } from "../features/auth/api/auth";
import { useRedirectWhenSignedIn } from "../features/auth/hooks/useSessionRedirect";

/* Someone already signed in does not need a reset mail — they can change the
   password from a session. */
export const Route = createFileRoute("/forgot-password")({
  beforeLoad: async () => {
    if (await currentSession()) throw redirect({ to: "/" });
  },
  component: ForgotPasswordRoute,
});

function ForgotPasswordRoute() {
  useRedirectWhenSignedIn();
  return <ForgotPasswordPage />;
}
