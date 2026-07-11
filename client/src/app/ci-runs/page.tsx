import { CiRunsView } from "./_components/CiRunsView/CiRunsView";

/* Route: /ci-runs (cross-agent CI Runs page). Thin route entry — filters,
   table, row rendering, and i18n are colocated under _components/CiRunsView,
   matching the plain top-level page pattern used by agents/page.tsx and
   evals/page.tsx (no dynamic route segment exists here). */
export default function CiRunsPage() {
  return <CiRunsView />;
}
