/* The chrome the four auth pages share, plus the class recipes they are built
   from. Splitting the old combined Login into four pages would otherwise have
   copied this markup four times.

   The recipes are literal strings interpolated whole — never assembled from
   fragments. Tailwind's scanner reads source text, so `"bg-" + tone` would
   work in dev and silently lose its styles in the production build. `press`
   and `FOCUS` are the app-wide conventions: feedback on pointer-down, and a
   visible focus ring on every interactive element. */
import type { ReactNode } from "react";

export const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent";
export const FIELD = "flex flex-col gap-1 font-ui text-mini text-muted";
export const INPUT =
  `rounded-lg border border-line bg-surface-alt px-2.5 py-2 font-ui text-body text-ink transition-colors duration-[130ms] ease-out ${FOCUS}`;
export const ERROR_TEXT = "m-0 mt-1.5 text-mini text-danger";
export const NOTICE_TEXT = "m-0 text-mini text-accent";
export const SUBMIT =
  `press mt-1.5 cursor-pointer rounded-lg border-0 bg-accent px-3 py-[0.5625rem] font-ui text-body font-semibold text-accent-ink hover:brightness-[1.08] active:brightness-[0.94] disabled:cursor-default disabled:opacity-60 ${FOCUS}`;
/* the cross-links between the pages ("No account? Sign up", "Back to sign in") */
export const QUIET_LINK =
  `press inline-block cursor-pointer rounded-md bg-transparent p-1 font-ui text-mini text-muted no-underline hover:text-ink ${FOCUS}`;
export const FORM = "flex flex-col gap-2.5";

export function AuthCard({ title, intro, children }: { title: string; intro: string; children: ReactNode }) {
  return (
    <div className="grid min-h-screen place-items-center bg-ground p-6 font-ui text-ink">
      <div className="flex w-full max-w-[340px] flex-col gap-2.5 rounded-[14px] border border-line bg-surface px-6 pt-[26px] pb-5 shadow-pop">
        <div className="mb-0.5" aria-hidden="true">
          <span className="block h-3.5 w-3.5 rounded-[4px] bg-[linear-gradient(135deg,var(--color-accent)_0_50%,var(--color-summary-fill)_50%_100%)]" />
        </div>
        <h1 className="m-0 font-display text-hero font-semibold">{title}</h1>
        <p className="m-0 mb-1.5 text-small text-muted">{intro}</p>
        {children}
      </div>
    </div>
  );
}

/* the row of cross-links at the foot of every card */
export function AuthFooter({ children }: { children: ReactNode }) {
  return <div className="mt-1 flex flex-col items-start gap-0.5 border-t border-t-line-soft pt-2.5">{children}</div>;
}
