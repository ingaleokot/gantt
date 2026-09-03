import { createFileRoute } from "@tanstack/react-router";
import ProjectsPage from "../../features/projects/ProjectsPage";

/* `/` is the app's front door: every project the account owns, and the place
   they are created, renamed, copied and deleted.

   It used to be a resolver that forwarded to `app_state.active_project`, so
   the list only ever existed as a dropdown inside one project's editor.
   `active_project` is still written — it is what the "Last opened" badge marks
   — but nothing redirects on it any more, because a redirect made this page
   unreachable. */
export const Route = createFileRoute("/_authed/")({ component: ProjectsPage });
