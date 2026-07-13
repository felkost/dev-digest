import { ConfigureRunView } from "./_components/ConfigureRunView";

/* Route: /multi-agent-review (Configure-run flow, AC-10/11/12). Thin route
   entry — the view, its picker logic, styles, and i18n are colocated under
   _components/ConfigureRunView. */
export default function MultiAgentReviewPage() {
  return <ConfigureRunView />;
}
