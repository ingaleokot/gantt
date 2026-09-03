/* Field validators shared by the four auth forms, in the shape TanStack Form
   expects (`({ value }) => message | undefined`). They are plain functions so a
   page can compose them without pulling a schema library in.

   Client-side rules only cover what the user can fix before a round trip; the
   server's own message is always surfaced too (see authErrorMessage). */
import { PASSWORD_MIN_LENGTH } from "../api/auth";

/* deliberately loose — the only authority on whether an address exists is the
   confirmation mail, so this catches typos, not exotic-but-valid addresses */
export function validateEmail({ value }: { value: string }): string | undefined {
  const v = value.trim();
  if (!v) return "Enter your email address.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return "That does not look like an email address.";
  return undefined;
}

export function validatePassword({ value }: { value: string }): string | undefined {
  if (!value) return "Enter your password.";
  if (value.length < PASSWORD_MIN_LENGTH) return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  return undefined;
}

/* sign-in must not tell the user their stored password is too short — it only
   needs to know the box is not empty */
export function validateRequired({ value }: { value: string }): string | undefined {
  return value ? undefined : "Enter your password.";
}

/* TanStack Form types an error as whatever the validator returned, so the
   union is wider than ReactNode. Narrow it once, here, instead of casting at
   every call site. */
export function firstError(errors: readonly unknown[]): string {
  for (const e of errors) {
    if (typeof e === "string" && e) return e;
    if (e && typeof e === "object" && "message" in e) {
      const m = (e as { message: unknown }).message;
      if (typeof m === "string" && m) return m;
    }
  }
  return "";
}
