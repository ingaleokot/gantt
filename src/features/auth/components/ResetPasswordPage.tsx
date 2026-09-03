/* Set a new password, arrived at from the link in the reset email.

   This is the one auth page that must NOT redirect when a session exists — the
   recovery session is exactly what it is reached with. useRecoverySession
   resolves whether this URL actually carried a usable link; only then is the
   form worth showing. */
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";
import { Field } from "@ark-ui/react/field";
import { PASSWORD_MIN_LENGTH, authErrorMessage, updatePassword } from "../api/auth";
import { useRecoverySession } from "../hooks/useRecoverySession";
import { firstError, validatePassword } from "../lib/validate";
import { AuthCard, AuthFooter, ERROR_TEXT, FIELD, FORM, INPUT, NOTICE_TEXT, QUIET_LINK, SUBMIT } from "./AuthCard";

export default function ResetPasswordPage() {
  const recovery = useRecoverySession();
  const [formError, setFormError] = useState("");
  const [done, setDone] = useState(false);

  const form = useForm({
    defaultValues: { password: "", confirm: "" },
    onSubmit: async ({ value }) => {
      setFormError("");
      try {
        await updatePassword(value.password);
        setDone(true);
      } catch (e) {
        /* the server has its own opinion about password strength and about
           whether the recovery session is still good — show what it said */
        setFormError(authErrorMessage(e));
      }
    },
  });

  if (recovery.phase === "checking") {
    return <AuthCard title="One moment" intro="Checking your reset link…"><span /></AuthCard>;
  }

  if (recovery.phase === "invalid") {
    return (
      <AuthCard title="That link did not work" intro={recovery.reason}>
        <AuthFooter>
          <Link className={QUIET_LINK} to="/forgot-password">Send me a new link</Link>
          <Link className={QUIET_LINK} to="/login">Back to sign in</Link>
        </AuthFooter>
      </AuthCard>
    );
  }

  if (done) {
    return (
      <AuthCard title="Password changed" intro="You are signed in with the new one.">
        <p className={NOTICE_TEXT}>Use it next time you sign in on any device.</p>
        <AuthFooter>
          <Link className={QUIET_LINK} to="/">Open your projects</Link>
        </AuthFooter>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Choose a new password" intro="Type it twice so a slip does not lock you out.">
      <form
        className={FORM}
        noValidate
        onSubmit={(e) => { e.preventDefault(); void form.handleSubmit(); }}
      >
        <form.Field name="password" validators={{ onChange: validatePassword, onSubmit: validatePassword }}>
          {(field) => {
            const err = field.state.meta.isTouched ? firstError(field.state.meta.errors) : "";
            return (
              <Field.Root className={FIELD} invalid={!!err}>
                <Field.Label>New password</Field.Label>
                <Field.Input
                  className={INPUT}
                  type="password"
                  autoComplete="new-password"
                  autoFocus
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

        <form.Field
          name="confirm"
          validators={{
            /* the sibling field is read off the form, so the check re-runs as
               either box changes rather than only on submit */
            onChangeListenTo: ["password"],
            onChange: ({ value, fieldApi }) =>
              value !== fieldApi.form.state.values.password ? "The two passwords do not match." : undefined,
            onSubmit: ({ value, fieldApi }) =>
              value !== fieldApi.form.state.values.password ? "The two passwords do not match." : undefined,
          }}
        >
          {(field) => {
            const err = field.state.meta.isTouched ? firstError(field.state.meta.errors) : "";
            return (
              <Field.Root className={FIELD} invalid={!!err}>
                <Field.Label>Repeat password</Field.Label>
                <Field.Input
                  className={INPUT}
                  type="password"
                  autoComplete="new-password"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
                <Field.ErrorText className={ERROR_TEXT}>{err}</Field.ErrorText>
              </Field.Root>
            );
          }}
        </form.Field>

        {formError && <p className={ERROR_TEXT}>{formError}</p>}

        <form.Subscribe selector={(s) => s.isSubmitting}>
          {(busy) => (
            <button className={SUBMIT} type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save new password"}
            </button>
          )}
        </form.Subscribe>
      </form>

      <AuthFooter>
        <Link className={QUIET_LINK} to="/login">Back to sign in</Link>
      </AuthFooter>
    </AuthCard>
  );
}
