/* Sign in — email + password.

   Navigation away is not this component's job: the route subscribes to
   watchSession and moves to `/` when Supabase hands over a session (from this
   form, or from another tab). The gate is a beforeLoad redirect, so nothing
   re-renders on sign-in by itself. */
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";
import { Field } from "@ark-ui/react/field";
import { authErrorMessage, signIn } from "../api/auth";
import { firstError, validateEmail, validateRequired } from "../lib/validate";
import { AuthCard, AuthFooter, ERROR_TEXT, FIELD, FORM, INPUT, QUIET_LINK, SUBMIT } from "./AuthCard";

export default function SignInPage() {
  /* the credentials are wrong as a pair, so the server's message hangs off the
     password field rather than getting a paragraph of its own */
  const [formError, setFormError] = useState("");

  const form = useForm({
    defaultValues: { email: "", password: "" },
    onSubmit: async ({ value }) => {
      setFormError("");
      try {
        await signIn(value.email.trim(), value.password);
      } catch (e) {
        setFormError(authErrorMessage(e));
      }
    },
  });

  return (
    <AuthCard title="Project timelines" intro="Sign in to open your Gantt charts.">
      <form
        className={FORM}
        noValidate
        onSubmit={(e) => { e.preventDefault(); void form.handleSubmit(); }}
      >
        <form.Field name="email" validators={{ onSubmit: validateEmail }}>
          {(field) => {
            const err = firstError(field.state.meta.errors);
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
                  onChange={(e) => field.handleChange(e.target.value)}
                />
                <Field.ErrorText className={ERROR_TEXT}>{err}</Field.ErrorText>
              </Field.Root>
            );
          }}
        </form.Field>

        <form.Field name="password" validators={{ onSubmit: validateRequired }}>
          {(field) => {
            const err = firstError(field.state.meta.errors) || formError;
            return (
              <Field.Root className={FIELD} invalid={!!err}>
                <Field.Label>Password</Field.Label>
                <Field.Input
                  className={INPUT}
                  type="password"
                  autoComplete="current-password"
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
              {busy ? "Signing in…" : "Sign in"}
            </button>
          )}
        </form.Subscribe>
      </form>

      <AuthFooter>
        <Link className={QUIET_LINK} to="/forgot-password">Forgot your password?</Link>
        <Link className={QUIET_LINK} to="/signup">No account yet? Sign up</Link>
      </AuthFooter>
    </AuthCard>
  );
}
