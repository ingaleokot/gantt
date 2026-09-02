import { createFileRoute } from "@tanstack/react-router";
import ShareViewer from "../ShareViewer";

/* Public, read-only, and deliberately ignorant of auth: this route pulls the
   JSON the `shared` edge function publishes and renders it. Nothing it imports
   may reach the Supabase client. */
export const Route = createFileRoute("/share/$projectId")({ component: Shared });

function Shared() {
  const { projectId } = Route.useParams();
  return <ShareViewer projectId={projectId} />;
}
