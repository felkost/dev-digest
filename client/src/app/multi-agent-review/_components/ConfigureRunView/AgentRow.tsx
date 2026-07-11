/* AgentRow — one checkbox row in the Configure-run flow's agent picker
   (AC-1): icon, name, one-line summary, and this agent's own pre-run
   estimate (AC-6/AC-7). Split out of ConfigureRunView to keep that
   container under the component-size guideline. */
"use client";

import { Checkbox, Icon } from "@devdigest/ui";
import { useTranslations } from "next-intl";
import type { Agent, AgentEstimate } from "@devdigest/shared";
import { formatCost } from "@/lib/format";
import { formatDurationMs } from "@/app/multi-agent-review/format";

export function AgentRow({
  agent,
  estimate,
  checked,
  onToggle,
}: {
  agent: Agent;
  estimate: AgentEstimate | undefined;
  checked: boolean;
  onToggle: () => void;
}) {
  const t = useTranslations("multi-agent-review.configureRun");
  const noHistory = !estimate || estimate.sample_size === 0 || estimate.avg_duration_ms == null;

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px" }}>
      <Checkbox
        checked={checked}
        onChange={onToggle}
        label={
          <span style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
            <Icon.Cpu size={16} style={{ color: "var(--text-muted)", marginTop: 2, flexShrink: 0 }} />
            <span style={{ minWidth: 0 }}>
              <span style={{ display: "block", fontWeight: 600, fontSize: 13.5, color: "var(--text-primary)" }}>
                {agent.name}
              </span>
              <span style={{ display: "block", fontSize: 12.5, color: "var(--text-secondary)" }}>
                {agent.description}
              </span>
              <span className="tnum" style={{ display: "block", fontSize: 11.5, color: "var(--text-muted)", marginTop: 2 }}>
                {noHistory
                  ? t("noHistory")
                  : t("estimateEach", {
                      duration: formatDurationMs(estimate!.avg_duration_ms),
                      cost: formatCost(estimate!.avg_cost_usd),
                    })}
              </span>
            </span>
          </span>
        }
      />
    </div>
  );
}
