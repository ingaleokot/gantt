import { createFileRoute } from "@tanstack/react-router";
import ResetPasswordPage from "../features/auth/components/ResetPasswordPage";

/* The exception among the auth routes: NO beforeLoad redirect and no
   "signed in? go home" hook. This page is *reached* with a session — the
   recovery one the emailed link carries in the URL fragment — so bouncing on a
   live session would make it unreachable by design.

   The URL it is reached at is built by resetRedirectUrl() in
   features/auth/api/auth.ts from import.meta.env.BASE_URL, and Supabase only
   honours it if the dashboard allow-lists it. */
export const Route = createFileRoute("/reset-password")({ component: ResetPasswordPage });
