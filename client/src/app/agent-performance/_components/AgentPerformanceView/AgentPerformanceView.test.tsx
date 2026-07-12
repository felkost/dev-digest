/**
 * AgentPerformanceView — KPI/donut/table container.
 * `useAgentPerformance` is mocked directly (matches the established
 * hooks-module-mocking convention, e.g. CiRunsView.test.tsx) — this file
 * verifies the view's own render/sort/navigation logic against controllable
 * fixtures, not a live `GET /agents/performance` response.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { AgentPerf, AgentPerfRow } from "@devdigest/shared";
import agentPerformanceMessages from "../../../../../messages/en/agentPerformance.json";
import shellMessages from "../../../../../messages/en/shell.json";

// ---- Mocks -----------------------------------------------------------------

vi.mock("@/components/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const routerPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush }),
}));

const useAgentPerformanceMock = vi.fn();
vi.mock("@/lib/hooks/agent-performance", () => ({
  useAgentPerformance: (...args: unknown[]) => useAgentPerformanceMock(...args),
}));

import { AgentPerformanceView } from "./AgentPerformanceView";

function renderWithIntl() {
  return render(
    <NextIntlClientProvider locale="en" messages={{ agentPerformance: agentPerformanceMessages, shell: shellMessages }}>
      <AgentPerformanceView />
    </NextIntlClientProvider>,
  );
}

function makeRow(overrides: Partial<AgentPerfRow> = {}): AgentPerfRow {
  return {
    agent_id: "ag-a",
    agent_name: "Agent A",
    provider: "openai",
    model: "gpt-4.1",
    runs: 5,
    findings_total: 10,
    accepted: 8,
    dismissed: 1,
    accept_rate: 0.9,
    dismiss_rate: 0.1,
    avg_findings_per_run: 2,
    total_cost_usd: 1,
    avg_cost_usd: 0.2,
    avg_latency_ms: 1200,
    last_run_at: "2026-07-10T00:00:00.000Z",
    findings_by_severity: { CRITICAL: 1, WARNING: 2, SUGGESTION: 7 },
    cost_trend: [0.1, 0.2, 0.3],
    ...overrides,
  };
}

const AGENT_A = makeRow();
const AGENT_B = makeRow({
  agent_id: "ag-b",
  agent_name: "Agent B",
  runs: 20,
  accept_rate: 0.5,
  total_cost_usd: 5,
  cost_trend: [1, 2, 3],
});
const AGENT_ZERO = makeRow({
  agent_id: "ag-zero",
  agent_name: "Agent Zero",
  runs: 0,
  findings_total: 0,
  accepted: 0,
  dismissed: 0,
  accept_rate: null,
  dismiss_rate: null,
  avg_findings_per_run: null,
  total_cost_usd: null,
  avg_cost_usd: null,
  avg_latency_ms: null,
  last_run_at: null,
  findings_by_severity: { CRITICAL: 0, WARNING: 0, SUGGESTION: 0 },
  cost_trend: [],
});

function makePerf(overrides: Partial<AgentPerf> = {}): AgentPerf {
  return {
    summary: {
      total_runs_all_time: 25,
      total_cost_usd_30d: 6,
      cost_delta_usd_30d: 1.5,
      avg_accept_rate_pct_30d: 72,
      most_active_agent: { agent_id: "ag-b", agent_name: "Agent B", runs_30d: 20 },
    },
    agents: [AGENT_A, AGENT_B, AGENT_ZERO],
    cost_by_agent: [
      { label: "Agent A", value: 1 },
      { label: "Agent B", value: 5 },
    ],
    cost_by_model: [{ label: "gpt-4.1", value: 6 }],
    ...overrides,
  };
}

function mockPerf(data: AgentPerf | undefined, opts: { isLoading?: boolean; isError?: boolean } = {}) {
  useAgentPerformanceMock.mockReturnValue({
    data,
    isLoading: opts.isLoading ?? false,
    isError: opts.isError ?? false,
  });
}

afterEach(() => {
  cleanup();
  routerPush.mockClear();
  useAgentPerformanceMock.mockReset();
});

describe("AgentPerformanceView", () => {
  it("shows skeleton placeholders while loading (AC-9)", () => {
    mockPerf(undefined, { isLoading: true });
    const { container } = renderWithIntl();
    expect(container.querySelectorAll(".skeleton").length).toBeGreaterThan(0);
    expect(screen.queryByText("Agent A")).not.toBeInTheDocument();
  });

  it("shows a load-error message with no retry control on fetch failure (AC-8)", () => {
    mockPerf(undefined, { isError: true });
    renderWithIntl();
    expect(screen.getByText("Could not load agent performance.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
  });

  it("shows the dedicated empty state when no agent has any recorded run (AC-7)", () => {
    mockPerf(
      makePerf({
        summary: {
          total_runs_all_time: 0,
          total_cost_usd_30d: null,
          cost_delta_usd_30d: null,
          avg_accept_rate_pct_30d: null,
          most_active_agent: null,
        },
        agents: [],
        cost_by_agent: [],
        cost_by_model: [],
      }),
    );
    renderWithIntl();
    expect(screen.getByText("No agent runs yet")).toBeInTheDocument();
    expect(screen.getByText("Run a review (manually) to populate per-agent performance.")).toBeInTheDocument();
    expect(screen.queryByText("Total runs")).not.toBeInTheDocument();
  });

  it("renders a row per agent including a zero-run agent, with accept-rate shown as unavailable, never 0% (AC-3)", () => {
    mockPerf(makePerf());
    renderWithIntl();
    expect(screen.getByTestId("agent-perf-row-ag-zero")).toBeInTheDocument();
    const zeroRow = screen.getByTestId("agent-perf-row-ag-zero");
    expect(zeroRow).toHaveTextContent("—");
    expect(zeroRow).not.toHaveTextContent("0%");
  });

  it("clicking an agent row navigates to that agent's Stats tab (AC-5)", async () => {
    mockPerf(makePerf());
    const user = userEvent.setup();
    renderWithIntl();

    await user.click(screen.getByTestId("agent-perf-row-ag-a"));
    expect(routerPush).toHaveBeenCalledWith("/agents/ag-a?tab=stats");
  });

  it("selecting a sort dimension reorders rows client-side with no additional hook/fetch call (AC-4)", async () => {
    mockPerf(makePerf());
    const user = userEvent.setup();
    renderWithIntl();

    const initialOrder = screen.getAllByTestId(/^agent-perf-row-/).map((el) => el.getAttribute("data-testid"));
    expect(initialOrder).toEqual(["agent-perf-row-ag-a", "agent-perf-row-ag-b", "agent-perf-row-ag-zero"]);

    // Open the sort SelectInput and choose "runs".
    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByRole("button", { name: "runs" }));

    const reordered = screen.getAllByTestId(/^agent-perf-row-/).map((el) => el.getAttribute("data-testid"));
    expect(reordered).toEqual(["agent-perf-row-ag-b", "agent-perf-row-ag-a", "agent-perf-row-ag-zero"]);

    // The hook is never called with the sort dimension (or any argument) — the
    // reorder is purely local state over the already-fetched `agents` array,
    // never a re-parameterized fetch.
    expect(useAgentPerformanceMock.mock.calls.every((call) => call.length === 0)).toBe(true);
  });

  it("renders a null-value cost segment (AC-28) as an unavailable legend row, not $0.00", () => {
    mockPerf(
      makePerf({
        cost_by_agent: [
          { label: "Agent A", value: 1 },
          { label: "Agent C", value: null },
        ],
      }),
    );
    renderWithIntl();
    expect(screen.getByText("Agent C")).toBeInTheDocument();
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
  });
});
