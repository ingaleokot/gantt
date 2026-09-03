/* Create an account.

   Two outcomes, and they must not be confused. If the project does not require
   email confirmation, signUp returns a session and the route's watchSession
   moves to `/`. If it does, `data.session` is null and nothing has happened
   yet — so the card switches to a "check your inbox" state rather than
   pretending the account is usable. */
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";
import { Field } from "@ark-ui/react/field";
import { PASSWORD_MIN_LENGTH, authErrorMessage, signUp } from "../api/auth";
import { firstError, validateEmail, validatePassword } from "../lib/validate";
import { AuthCard, AuthFooter, ERROR_TEXT, FIELD, FORM, INPUT, NOTICE_TEXT, QUIET_LINK, SUBMIT } from "./AuthCard";

export default function SignUpPage() {
  const [formError, setFormError] = useState("");
  const [pending, setPending] = useState<string | null>(null); /* the address awaiting confirmation */

  const form = useForm({
    defaultValues: { email: "", password: "" },
    onSubmit: async ({ value }) => {
      setFormError("");
      const email = value.email.trim();
      try {
        const { needsConfirmation } = await signUp(email, value.password);
        if (needsConfirmation) setPending(email);
      } catch (e) {
        setFormError(authErrorMessage(e));
      }
    },
  });

  if (pending) {
    return (
      <AuthCard title="Check your inbox" intro={`We sent a confirmation link to ${pending}.`}>
        <p className={NOTICE_TEXT}>
          Open it to activate the account, then come back and sign in. The link expires, so if it
          goes stale just sign up again with the same address.
        </p>
        <AuthFooter>
          <Link className={QUIET_LINK} to="/login">Back to sign in</Link>
        </AuthFooter>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Create an account" intro="One account holds every project, its people and its timelines.">
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

        <form.Field name="password" validators={{ onChange: validatePassword, onSubmit: validatePassword }}>
          {(field) => {
            const err = field.state.meta.isTouched ? firstError(field.state.meta.errors) : "";
            return (
              <Field.Root className={FIELD} invalid={!!err}>
                <Field.Label>Password</Field.Label>
                <Field.Input
                  className={INPUT}
                  type="password"
                  autoComplete="new-password"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
                <Field.HelperText className="m-0 text-mini text-faint">
                  At least {PASSWORD_MIN_LENGTH} characters.
                </Field.HelperText>
                <Field.ErrorText className={ERROR_TEXT}>{err}</Field.ErrorText>
              </Field.Root>
            );
          }}
        </form.Field>

        <form.Subscribe selector={(s) => s.isSubmitting}>
          {(busy) => (
            <button className={SUBMIT} type="submit" disabled={busy}>
              {busy ? "Creating…" : "Sign up"}
            </button>
          )}
        </form.Subscribe>
      </form>

      <AuthFooter>
        <Link className={QUIET_LINK} to="/login">Already have an account? Sign in</Link>
      </AuthFooter>
    </AuthCard>
  );
}
