import { AgentPerformanceView } from "./_components/AgentPerformanceView/AgentPerformanceView";

/* Route: /agent-performance (workspace-wide Agent Performance page — fleet
   KPI summary, cost breakdowns, per-agent table). Thin route entry — the
   view, its styles, and i18n are colocated under _components/AgentPerformanceView. */
export default function AgentPerformancePage() {
  return <AgentPerformanceView />;
}
