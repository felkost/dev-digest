import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { Agent, AgentStatsDetail } from "@devdigest/shared";
import agentsMessages from "../../../../../../../../messages/en/agents.json";

// ---- Mocks -----------------------------------------------------------------

let statsData: AgentStatsDetail | undefined;
let statsIsLoading = false;
let statsIsError = false;

vi.mock("@/lib/hooks/agents", () => ({
  useAgentStatsDetail: () => ({ data: statsData, isLoading: statsIsLoading, isError: statsIsError }),
}));

// Per the task spec: mock the shared RunTraceDrawer wholesale — StatsTab's
// own job is only to pass the right props and mount it on row click.
const drawerCalls: Array<{ runId: string; agentName?: string | null; prNumber?: number | null }> = [];
vi.mock("@/components/RunTraceDrawer", () => ({
  __esModule: true,
  default: ({
    runId,
    agentName,
    prNumber,
    onClose,
  }: {
    runId: string;
    agentName?: string | null;
    prNumber?: number | null;
    onClose: () => void;
  }) => {
    drawerCalls.push({ runId, agentName, prNumber });
    return (
      <div data-testid="run-trace-drawer">
        drawer:{runId}
        <button type="button" onClick={onClose}>
          close
        </button>
      </div>
    );
  },
}));

import { StatsTab } from "./StatsTab";

function renderWithIntl(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ agents: agentsMessages }}>
      {ui}
    </NextIntlClientProvider>,
  );
}

const AGENT: Agent = {
  id: "ag1",
  name: "Security Reviewer",
  description: "Flags secrets and injection",
  provider: "openai",
  model: "gpt-4.1",
  system_prompt: "You are a security reviewer.",
  output_schema: null,
  strategy: "single-pass",
  ci_fail_on: "critical",
  repo_intel: true,
  enabled: true,
  version: 1,
};

function makeStats(overrides: Partial<AgentStatsDetail> = {}): AgentStatsDetail {
  return {
    agent_id: "ag1",
    agent_name: "Security Reviewer",
    runs: 5,
    findings_total: 12,
    accepted: 6,
    dismissed: 2,
    pending: 4,
    accept_rate: 0.75,
    dismiss_rate: 0.25,
    avg_findings_per_run: 2.4,
    total_cost_usd: 1.23,
    avg_cost_usd: 0.25,
    avg_latency_ms: 4200,
    findings_by_severity: { CRITICAL: 1, WARNING: 5, SUGGESTION: 6 },
    trend: [],
    cost_delta_usd_30d: 0.05,
    weekly_findings_by_severity: [
      { week_start: "2026-06-01T00:00:00.000Z", CRITICAL: 1, WARNING: 2, SUGGESTION: 3 },
    ],
    most_used_skills: [{ id: "sk1", name: "Security basics", usage_estimate: 4 }],
    memory_pulled_summary: [],
    run_history: [
      { run_id: "r1", ran_at: "2026-07-01T00:00:00.000Z", status: "done", cost_usd: 0.1, findings_count: 2, pr_number: 42 },
    ],
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  statsData = undefined;
  statsIsLoading = false;
  statsIsError = false;
  drawerCalls.length = 0;
});

describe("StatsTab", () => {
  it("shows loading skeletons while stats load (AC-19)", () => {
    statsIsLoading = true;
    renderWithIntl(<StatsTab agent={AGENT} />);

    expect(screen.getByTestId("stats-loading")).toBeInTheDocument();
    expect(screen.queryByText("No runs yet")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows an error message with no retry control on fetch failure (AC-18)", () => {
    statsIsError = true;
    renderWithIntl(<StatsTab agent={AGENT} />);

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Could not load stats")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
  });

  it("shows a dedicated empty state when the agent has zero runs ever, not zeroed charts (AC-17)", () => {
    statsData = makeStats({ runs: 0 });
    renderWithIntl(<StatsTab agent={AGENT} />);

    expect(screen.getByText("No runs yet")).toBeInTheDocument();
    expect(screen.getByText("Run this agent on a PR to start collecting stats.")).toBeInTheDocument();
    // The full-tab empty state replaces everything else — no run-history table.
    expect(screen.queryByText("Run history")).not.toBeInTheDocument();
  });

  it("renders a dedicated empty state for most-pulled memory, never an empty chart shape (AC-14)", () => {
    statsData = makeStats({ memory_pulled_summary: [] });
    renderWithIntl(<StatsTab agent={AGENT} />);

    expect(screen.getByText("No memory pulls recorded yet.")).toBeInTheDocument();
  });

  it("renders the most-used skills ranked list when data is present, labeled as an approximation", () => {
    statsData = makeStats();
    renderWithIntl(<StatsTab agent={AGENT} />);

    expect(screen.getByText("Security basics")).toBeInTheDocument();
    expect(screen.getAllByText("Approximate").length).toBeGreaterThan(0);
  });

  it("clicking a run-history row opens the RunTraceDrawer with the run id (AC-16)", async () => {
    statsData = makeStats();
    const user = userEvent.setup();
    renderWithIntl(<StatsTab agent={AGENT} />);

    expect(screen.queryByTestId("run-trace-drawer")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("stats-run-row-r1"));

    expect(screen.getByTestId("run-trace-drawer")).toBeInTheDocument();
    expect(drawerCalls).toEqual([{ runId: "r1", agentName: "Security Reviewer", prNumber: 42 }]);
  });

  it("closing the drawer unmounts it", async () => {
    statsData = makeStats();
    const user = userEvent.setup();
    renderWithIntl(<StatsTab agent={AGENT} />);

    await user.click(screen.getByTestId("stats-run-row-r1"));
    expect(screen.getByTestId("run-trace-drawer")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "close" }));
    expect(screen.queryByTestId("run-trace-drawer")).not.toBeInTheDocument();
  });

  it("renders a muted dash instead of a fabricated accept-rate ring when accept_rate is null", () => {
    statsData = makeStats({ accept_rate: null });
    renderWithIntl(<StatsTab agent={AGENT} />);

    expect(screen.getByText("—")).toBeInTheDocument();
  });
});
