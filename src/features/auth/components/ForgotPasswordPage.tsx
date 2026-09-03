/* Request a reset email.

   The response is deliberately the same whether or not the address has an
   account: saying "no such user" here would turn the form into an account
   enumerator. Supabase's own API is quiet about it too, so the only thing that
   could leak it is this screen.

   The link in the mail has to come back to /reset-password on this origin —
   see resetRedirectUrl() in ../api/auth, and note that Supabase will silently
   fall back to the project's Site URL unless that exact URL is allow-listed in
   the dashboard. */
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";
import { Field } from "@ark-ui/react/field";
import { authErrorMessage, requestPasswordReset } from "../api/auth";
import { firstError, validateEmail } from "../lib/validate";
import { AuthCard, AuthFooter, ERROR_TEXT, FIELD, FORM, INPUT, NOTICE_TEXT, QUIET_LINK, SUBMIT } from "./AuthCard";

export default function ForgotPasswordPage() {
  const [formError, setFormError] = useState("");
  const [sent, setSent] = useState(false);

  const form = useForm({
    defaultValues: { email: "" },
    onSubmit: async ({ value }) => {
      setFormError("");
      try {
        await requestPasswordReset(value.email.trim());
        setSent(true);
      } catch (e) {
        /* a genuine failure (rate limit, network) is worth showing; "no such
           user" is not something Supabase reports here in the first place */
        setFormError(authErrorMessage(e));
      }
    },
  });

  if (sent) {
    return (
      <AuthCard title="Check your inbox" intro="If that address has an account, we sent it a reset link.">
        <p className={NOTICE_TEXT}>
          The link opens this app on a page where you can set a new password. It is single-use and
          expires, so ask again if it goes stale.
        </p>
        <AuthFooter>
          <Link className={QUIET_LINK} to="/login">Back to sign in</Link>
        </AuthFooter>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Reset your password" intro="We will email you a link that sets a new one.">
      <form
        className={FORM}
        noValidate
        onSubmit={(e) => { e.preventDefault(); void form.handleSubmit(); }}
      >
        <form.Field name="email" validators={{ onSubmit: validateEmail }}>
          {(field) => {
            const err = firstError(field.state.meta.errors) || formError;
            return (
              <Field.Root className={FIELD} invalid={!!err}>
                <Field.Label>Email</Field.Label>
                <Field.Input
                  className={INPUT}
                  type="email"
                  autoComplete="email"
                  autoFocus
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => { setFormError(""); field.handleChange(e.target.value); }}
                />
                <Field.ErrorText className={ERROR_TEXT}>{err}</Field.ErrorText>
              </Field.Root>
            );
          }}
        </form.Field>

        <form.Subscribe selector={(s) => s.isSubmitting}>
          {(busy) => (
            <button className={SUBMIT} type="submit" disabled={busy}>
              {busy ? "Sending…" : "Send reset link"}
            </button>
          )}
        </form.Subscribe>
      </form>

      <AuthFooter>
        <Link className={QUIET_LINK} to="/login">Back to sign in</Link>
        <Link className={QUIET_LINK} to="/signup">No account yet? Sign up</Link>
      </AuthFooter>
    </AuthCard>
  );
}
