"use client";

import React from "react";
import { useParams } from "next/navigation";
import { MultiAgentResultsView } from "./_components/MultiAgentResultsView";

/* Route: /multi-agent-review/:runId — the results page (AC-14: always this
   page for an existing run, regardless of entry point). "use client" at the
   page level via useParams(), matching every other repos/[repoId]/...
   /agents/[id] page's established pattern in this codebase. Wrapped in
   Suspense because the Tabs view renders the reused FindingCard, which
   calls useSearchParams() internally — Next.js requires a Suspense boundary
   around any subtree using that hook (same reason pulls/[number]/page.tsx
   wraps its content component). */
export default function MultiAgentRunPage() {
  const params = useParams<{ runId: string }>();
  return (
    <React.Suspense>
      <MultiAgentResultsView runId={params.runId} />
    </React.Suspense>
  );
}
