/**
 * ColumnsView — covers AC-16 (live status), AC-17 (failure isolation: one
 * column failing renders its reason without affecting the others' progress),
 * AC-18 (compact finding rows), AC-19 (score banding via CircularScore).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { AgentColumn } from "@devdigest/shared";
import messages from "../../../../../../../../messages/en/multi-agent-review.json";
import { ColumnsView } from "./ColumnsView";

afterEach(cleanup);

function renderWithIntl(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ "multi-agent-review": messages }}>
      {ui}
    </NextIntlClientProvider>,
  );
}

const RUNNING: AgentColumn = {
  run_id: "run-running",
  agent_id: "a1",
  agent_name: "Security",
  provider: null,
  model: null,
  status: "running",
  verdict: null,
  score: null,
  summary: null,
  duration_ms: null,
  cost_usd: null,
  error: null,
  tokens_in: null,
  tokens_out: null,
  findings: [],
};

const DONE: AgentColumn = {
  run_id: "run-done",
  agent_id: "a2",
  agent_name: "Performance",
  provider: "openai",
  model: "gpt-5",
  status: "done",
  verdict: "approve",
  score: 90,
  summary: "Looks solid.",
  duration_ms: 4200,
  cost_usd: 0.04,
  error: null,
  tokens_in: 12000,
  tokens_out: 1500,
  findings: [{ id: "f1", severity: "WARNING", category: "perf", title: "N+1 query", file: "src/db.ts", start_line: 22, kind: null }],
};

const FAILED: AgentColumn = {
  run_id: "run-failed",
  agent_id: "a3",
  agent_name: "Style",
  provider: "openai",
  model: "gpt-5",
  status: "failed",
  verdict: null,
  score: null,
  summary: null,
  duration_ms: 1200,
  cost_usd: null,
  error: null,
  tokens_in: null,
  tokens_out: null,
  findings: [],
};

describe("ColumnsView", () => {
  it("renders each agent's live status independently — a failed column never hides the others (AC-16/17)", () => {
    renderWithIntl(<ColumnsView columns={[RUNNING, DONE, FAILED]} onOpenTrace={vi.fn()} />);

    expect(within(screen.getByTestId("column-run-running")).getByText("Running")).toBeInTheDocument();
    expect(within(screen.getByTestId("column-run-done")).getByText("Done")).toBeInTheDocument();
    expect(within(screen.getByTestId("column-run-failed")).getByText("Failed")).toBeInTheDocument();

    // The failed column shows a fallback failure reason (no `error` sent for
    // this failed run) while the done column still shows its findings.
    expect(within(screen.getByTestId("column-run-failed")).getByRole("alert")).toHaveTextContent("This run failed.");
    expect(within(screen.getByTestId("column-run-done")).getByText("N+1 query")).toBeInTheDocument();
  });

  it("shows the agent's own failure reason (agent_runs.error) when the API provides one (AC-17)", () => {
    renderWithIntl(<ColumnsView columns={[{ ...FAILED, error: "Provider timeout after 60s" }]} onOpenTrace={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Provider timeout after 60s");
  });

  it("renders per-agent token usage next to cost/duration, and an 'unknown' affordance (never 0) when a count is null (AC-33)", () => {
    renderWithIntl(<ColumnsView columns={[DONE, RUNNING]} onOpenTrace={vi.fn()} />);

    const doneCol = within(screen.getByTestId("column-run-done"));
    expect(doneCol.getByText("Tokens in: 12.0k")).toBeInTheDocument();
    expect(doneCol.getByText("Tokens out: 1.5k")).toBeInTheDocument();

    const runningCol = within(screen.getByTestId("column-run-running"));
    expect(runningCol.getByText("Tokens in: unknown")).toBeInTheDocument();
    expect(runningCol.getByText("Tokens out: unknown")).toBeInTheDocument();
    expect(runningCol.queryByText(/Tokens in: 0/)).not.toBeInTheDocument();
  });

  it("renders compact finding rows as title + file:startLine (AC-18)", () => {
    renderWithIntl(<ColumnsView columns={[DONE]} onOpenTrace={vi.fn()} />);
    expect(screen.getByText("N+1 query")).toBeInTheDocument();
    expect(screen.getByText("src/db.ts:22")).toBeInTheDocument();
  });

  it("renders the score via the shared CircularScore banding (AC-19)", () => {
    renderWithIntl(<ColumnsView columns={[DONE]} onOpenTrace={vi.fn()} />);
    // CircularScore renders the numeric score as its own text node.
    expect(screen.getByText("90")).toBeInTheDocument();
  });

  it("'View trace' opens the trace for that column's run_id (AC-34)", async () => {
    const onOpenTrace = vi.fn();
    const user = userEvent.setup();
    renderWithIntl(<ColumnsView columns={[DONE]} onOpenTrace={onOpenTrace} />);
    await user.click(screen.getByText("View trace"));
    expect(onOpenTrace).toHaveBeenCalledWith("run-done");
  });
});
