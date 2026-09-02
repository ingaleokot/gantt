import { createFileRoute } from "@tanstack/react-router";
import ShareViewer from "../ShareViewer";

/* `/share` with no project keeps the links handed out before the viewer became
   deep-linkable working: it falls back to whatever the feed reports as active. */
export const Route = createFileRoute("/share/")({ component: Shared });

function Shared() {
  return <ShareViewer projectId={null} />;
}
