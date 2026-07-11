/* RunOnPrMenu — the Agent Editor's top-right "Run Review" action. A dropdown
   of the active repo's open pull requests; picking one STARTS a run of THIS
   (already-fixed) agent on that PR and navigates to the live run page
   (/multi-agent-review/:id), where the agent's column streams its progress —
   exactly like the per-PR Run Review (MultiAgentPicker). So the member doesn't
   just land on a static PR page: they watch the reviewer actually run.

   Uses the multi-agent-run endpoint with a single agent id (that flow already
   supports "exactly one agent"); this is what gives the per-agent live column.

   Strings are intentionally hardcoded English to match this page (agents/[id]),
   which does not use next-intl for its own labels. */
"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { Button, Dropdown } from "@devdigest/ui";
import { useActiveRepo } from "@/lib/repo-context";
import { usePulls } from "@/lib/hooks";
import { useStartMultiAgentRun } from "@/lib/hooks/multi-agent-review";
import { notify } from "@/lib/toast";

/** Open PRs carry a derived review status; everything else is merged/closed
   (mirrors the PR-list page's own OPEN_STATUSES set). */
const OPEN_STATUSES = new Set(["needs_review", "reviewed", "stale"]);

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export function RunOnPrMenu({ agentId, agentName }: { agentId: string; agentName: string }) {
  const router = useRouter();
  const { activeRepo } = useActiveRepo();
  const { data: pulls, isLoading } = usePulls(activeRepo?.id);
  const start = useStartMultiAgentRun();

  const openPrs = (pulls ?? []).filter((p) => p.id && OPEN_STATUSES.has(p.status));

  const runOnPr = (prId: string) => {
    start.mutate(
      { prId, agentIds: [agentId] },
      {
        // Navigate to the live run page — its per-agent column streams this
        // reviewer's progress. That navigation IS the feedback (no toast).
        onSuccess: (res) => router.push(`/multi-agent-review/${res.multi_agent_run_id}`),
        onError: () => notify.error(`Couldn't start ${agentName}. Please try again.`),
      },
    );
  };

  const items: React.ComponentProps<typeof Dropdown>["items"] = !activeRepo
    ? [{ label: "No repository connected", muted: true }]
    : isLoading
      ? [{ label: "Loading pull requests…", muted: true }]
      : openPrs.length === 0
        ? [{ label: "No open pull requests", muted: true }]
        : openPrs.map((p) => ({
            label: `#${p.number}  ${truncate(p.title, 40)}`,
            icon: "GitPullRequest",
            onClick: () => runOnPr(p.id!),
          }));

  return (
    <Dropdown
      width={340}
      align="right"
      trigger={
        <Button
          kind="secondary"
          size="sm"
          icon="Sparkles"
          iconRight="ChevronDown"
          loading={start.isPending}
        >
          Run Review
        </Button>
      }
      items={items}
    />
  );
}
