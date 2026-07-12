/**
 * FindingsSummary — the consolidated, interactive bottom "Findings" section.
 * Covers: shown for any agent count (1..N), groups full expandable FindingCards
 * per agent with attribution, Accept/Dismiss wired to the finding-action
 * mutation, and an explicit empty state when nothing was flagged.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { AgentColumn, FindingRecord } from "@devdigest/shared";
import maMessages from "../../../../../../../../messages/en/multi-agent-review.json";
import prReviewMessages from "../../../../../../../../messages/en/prReview.json";

const findingActionMutate = vi.fn();
vi.mock("@/lib/hooks/reviews", () => ({
  useFindingAction: () => ({ mutate: findingActionMutate, isPending: false }),
}));
vi.mock("@/lib/hooks/eval", () => ({
  useCreateEvalCaseFromFinding: () => ({ mutate: vi.fn(), isPending: false, isSuccess: false }),
}));

import { FindingsSummary } from "./FindingsSummary";

afterEach(() => {
  cleanup();
  findingActionMutate.mockClear();
});

function renderWithIntl(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ "multi-agent-review": maMessages, prReview: prReviewMessages }}>
      {ui}
    </NextIntlClientProvider>,
  );
}

function finding(overrides: Partial<FindingRecord> = {}): FindingRecord {
  return {
    id: "f1",
    severity: "CRITICAL",
    category: "security",
    title: "SQL Injection",
    file: "src/db.ts",
    start_line: 12,
    end_line: 12,
    rationale: "Raw interpolation of user input.",
    suggestion: "Use a parameterized query.",
    confidence: 0.9,
    kind: "finding",
    trifecta_components: null,
    evidence: null,
    review_id: "r1",
    accepted_at: null,
    dismissed_at: null,
    ...overrides,
  };
}

function column(overrides: Partial<AgentColumn> = {}): AgentColumn {
  return {
    run_id: "run-1",
    agent_id: "a1",
    agent_name: "Security Reviewer",
    provider: "openrouter",
    model: "x",
    status: "done",
    verdict: "comment",
    score: 40,
    summary: "s",
    duration_ms: 1000,
    cost_usd: 0.01,
    error: null,
    tokens_in: 100,
    tokens_out: 50,
    findings: [{ id: "f1", severity: "CRITICAL", category: "security", title: "SQL Injection", file: "src/db.ts", start_line: 12, kind: null }],
    ...overrides,
  };
}

describe("FindingsSummary", () => {
  it("renders a single agent's finding as a collapsed card that expands to reveal Accept/Dismiss (1 agent)", async () => {
    const findingsByRun = new Map<string, FindingRecord[]>([["run-1", [finding()]]]);
    const user = userEvent.setup();
    renderWithIntl(<FindingsSummary columns={[column()]} findingsByRun={findingsByRun} prId="pr-1" />);
    expect(screen.getByText("Findings")).toBeInTheDocument();
    expect(screen.getByText("SQL Injection")).toBeInTheDocument();
    // Agent attribution header.
    expect(screen.getByText("Security Reviewer")).toBeInTheDocument();
    // Collapsed by default — Accept/Dismiss appear only after expanding the card.
    expect(screen.queryByText("Accept")).not.toBeInTheDocument();
    await user.click(screen.getByText("SQL Injection"));
    expect(screen.getByText("Accept")).toBeInTheDocument();
    expect(screen.getByText("Dismiss")).toBeInTheDocument();
  });

  it("Accept (after expanding) calls the same finding-action mutation, with this PR's id", async () => {
    const findingsByRun = new Map<string, FindingRecord[]>([["run-1", [finding()]]]);
    const user = userEvent.setup();
    renderWithIntl(<FindingsSummary columns={[column()]} findingsByRun={findingsByRun} prId="pr-1" />);
    await user.click(screen.getByText("SQL Injection"));
    await user.click(screen.getByText("Accept"));
    expect(findingActionMutate).toHaveBeenCalledWith({ findingId: "f1", action: "accept", prId: "pr-1" });
  });

  it("groups findings per agent across multiple agents, each attributed to its agent", () => {
    const security = column();
    const perf = column({ run_id: "run-2", agent_id: "a2", agent_name: "Performance Reviewer" });
    const findingsByRun = new Map<string, FindingRecord[]>([
      ["run-1", [finding()]],
      ["run-2", [finding({ id: "f2", title: "N+1 query", file: "src/api.ts", start_line: 5, severity: "WARNING", category: "perf", review_id: "r2" })]],
    ]);
    renderWithIntl(<FindingsSummary columns={[security, perf]} findingsByRun={findingsByRun} prId="pr-1" />);
    expect(screen.getByText("SQL Injection")).toBeInTheDocument();
    expect(screen.getByText("N+1 query")).toBeInTheDocument();
    expect(screen.getByText("Security Reviewer")).toBeInTheDocument();
    expect(screen.getByText("Performance Reviewer")).toBeInTheDocument();
  });

  it("renders an explicit empty state (still shows the section) when no agent flagged anything", () => {
    const findingsByRun = new Map<string, FindingRecord[]>([["run-1", []]]);
    renderWithIntl(<FindingsSummary columns={[column({ findings: [] })]} findingsByRun={findingsByRun} prId="pr-1" />);
    expect(screen.getByText("Findings")).toBeInTheDocument();
    expect(screen.getByText(/No findings from any agent/)).toBeInTheDocument();
  });

  it("ignores findings from non-done (running/failed) agents", () => {
    const running = column({ status: "running" });
    const findingsByRun = new Map<string, FindingRecord[]>([["run-1", [finding()]]]);
    renderWithIntl(<FindingsSummary columns={[running]} findingsByRun={findingsByRun} prId="pr-1" />);
    expect(screen.getByText(/No findings from any agent/)).toBeInTheDocument();
    expect(screen.queryByText("SQL Injection")).not.toBeInTheDocument();
  });
});
