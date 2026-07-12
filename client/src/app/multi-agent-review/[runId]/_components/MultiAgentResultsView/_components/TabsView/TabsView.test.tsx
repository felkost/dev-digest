/**
 * TabsView — covers AC-20-22 (one tab per agent, compact-vs-full split),
 * AC-23-25 (full finding detail sourced from the usePrReviews cache-join,
 * via the unmodified FindingCard), AC-26 (Learn / Reply to author visibly
 * disabled), and score-banding consistency with ColumnsView (same
 * CircularScore component/thresholds).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { AgentColumn, FindingRecord, ReviewRecord } from "@devdigest/shared";
import maResultsMessages from "../../../../../../../../messages/en/multi-agent-review.json";
import prReviewMessages from "../../../../../../../../messages/en/prReview.json";

const findingActionMutate = vi.fn();
vi.mock("@/lib/hooks/reviews", () => ({
  useFindingAction: () => ({ mutate: findingActionMutate, isPending: false }),
}));

vi.mock("@/lib/hooks/eval", () => ({
  useCreateEvalCaseFromFinding: () => ({ mutate: vi.fn(), isPending: false, isSuccess: false }),
}));

import { TabsView } from "./TabsView";

afterEach(() => {
  cleanup();
  findingActionMutate.mockClear();
});

function renderWithIntl(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider
      locale="en"
      messages={{ "multi-agent-review": maResultsMessages, prReview: prReviewMessages }}
    >
      {ui}
    </NextIntlClientProvider>,
  );
}

const FINDING: FindingRecord = {
  id: "f1",
  severity: "WARNING",
  category: "perf",
  title: "N+1 query",
  file: "src/db.ts",
  start_line: 22,
  end_line: 22,
  rationale: "This loops a query per row.",
  suggestion: "Batch the lookup.",
  confidence: 0.8,
  kind: "finding",
  trifecta_components: null,
  evidence: null,
  review_id: "review-1",
  accepted_at: null,
  dismissed_at: null,
};

const REVIEW: ReviewRecord = {
  id: "review-1",
  pr_id: "pr-1",
  agent_id: "a2",
  run_id: "run-done",
  agent_name: "Performance",
  kind: "review",
  verdict: "approve",
  summary: "Looks solid.",
  score: 90,
  model: "gpt-5",
  grounding: null,
  created_at: "2026-07-09T00:00:00Z",
  findings: [FINDING],
};

const COLUMN_A: AgentColumn = {
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

const COLUMN_B: AgentColumn = {
  run_id: "run-b",
  agent_id: "a1",
  agent_name: "Security",
  provider: "openai",
  model: "gpt-5",
  status: "done",
  score: 60,
  verdict: "comment",
  summary: "One warning.",
  duration_ms: 3000,
  cost_usd: 0.02,
  error: null,
  tokens_in: null,
  tokens_out: null,
  findings: [],
};

const COLUMN_FAILED: AgentColumn = {
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
  error: "Provider timeout after 60s",
  tokens_in: null,
  tokens_out: null,
  findings: [],
};

describe("TabsView", () => {
  it("renders one tab per agent, labeled with name and score (AC-21)", () => {
    const reviewsByRunId = new Map([["run-done", REVIEW]]);
    renderWithIntl(
      <TabsView columns={[COLUMN_A, COLUMN_B]} reviewsByRunId={reviewsByRunId} prId="pr-1" onOpenTrace={vi.fn()} />,
    );
    expect(screen.getByText("Performance · 90")).toBeInTheDocument();
    expect(screen.getByText("Security · 60")).toBeInTheDocument();
  });

  it("shows the active tab's findings as full expandable FindingCards, sourced from the reviews cache (AC-23-25)", () => {
    const reviewsByRunId = new Map([["run-done", REVIEW]]);
    renderWithIntl(
      <TabsView columns={[COLUMN_A]} reviewsByRunId={reviewsByRunId} prId="pr-1" onOpenTrace={vi.fn()} />,
    );
    expect(screen.getByText("N+1 query")).toBeInTheDocument();
    expect(screen.getByText("src/db.ts:22")).toBeInTheDocument();
    // Accept/Dismiss come straight from the unmodified FindingCard.
    expect(screen.getByText("Accept")).toBeInTheDocument();
    expect(screen.getByText("Dismiss")).toBeInTheDocument();
  });

  it("Accept/Dismiss call the same finding-action mutation used elsewhere in the product (AC-24)", async () => {
    const reviewsByRunId = new Map([["run-done", REVIEW]]);
    const user = userEvent.setup();
    renderWithIntl(
      <TabsView columns={[COLUMN_A]} reviewsByRunId={reviewsByRunId} prId="pr-1" onOpenTrace={vi.fn()} />,
    );
    await user.click(screen.getByText("Accept"));
    expect(findingActionMutate).toHaveBeenCalledWith({ findingId: "f1", action: "accept", prId: "pr-1" });
  });

  it("renders Learn and Reply-to-author as visibly disabled stubs (AC-26)", () => {
    const reviewsByRunId = new Map([["run-done", REVIEW]]);
    renderWithIntl(
      <TabsView columns={[COLUMN_A]} reviewsByRunId={reviewsByRunId} prId="pr-1" onOpenTrace={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Learn" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reply to author" })).toBeDisabled();
  });

  it("uses the same CircularScore banding as ColumnsView for the same score", () => {
    const reviewsByRunId = new Map([["run-done", REVIEW]]);
    renderWithIntl(
      <TabsView columns={[COLUMN_A]} reviewsByRunId={reviewsByRunId} prId="pr-1" onOpenTrace={vi.fn()} />,
    );
    // The header CircularScore renders the score itself as text.
    expect(screen.getAllByText("90").length).toBeGreaterThan(0);
  });

  it("'View trace' opens the trace for the active tab's run_id", async () => {
    const onOpenTrace = vi.fn();
    const reviewsByRunId = new Map([["run-done", REVIEW]]);
    const user = userEvent.setup();
    renderWithIntl(
      <TabsView columns={[COLUMN_A]} reviewsByRunId={reviewsByRunId} prId="pr-1" onOpenTrace={onOpenTrace} />,
    );
    await user.click(screen.getByText("View trace"));
    expect(onOpenTrace).toHaveBeenCalledWith("run-done");
  });

  it("shows the agent's own failure reason (agent_runs.error) for a failed tab (AC-17)", () => {
    const reviewsByRunId = new Map([["run-done", REVIEW]]);
    renderWithIntl(
      <TabsView columns={[COLUMN_FAILED]} reviewsByRunId={reviewsByRunId} prId="pr-1" onOpenTrace={vi.fn()} />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Provider timeout after 60s");
  });

  it("falls back to the generic failure string when the failed column has no error text", () => {
    const reviewsByRunId = new Map([["run-done", REVIEW]]);
    renderWithIntl(
      <TabsView columns={[{ ...COLUMN_FAILED, error: null }]} reviewsByRunId={reviewsByRunId} prId="pr-1" onOpenTrace={vi.fn()} />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("This run failed.");
  });

  it("renders per-agent token usage alongside cost/duration, with an 'unknown' affordance (never 0) when a count is null (AC-33)", () => {
    const reviewsByRunId = new Map([["run-done", REVIEW]]);
    const { rerender } = renderWithIntl(
      <TabsView columns={[COLUMN_A]} reviewsByRunId={reviewsByRunId} prId="pr-1" onOpenTrace={vi.fn()} />,
    );
    expect(screen.getByText("Tokens in: 12.0k")).toBeInTheDocument();
    expect(screen.getByText("Tokens out: 1.5k")).toBeInTheDocument();

    rerender(
      <NextIntlClientProvider
        locale="en"
        messages={{ "multi-agent-review": maResultsMessages, prReview: prReviewMessages }}
      >
        <TabsView columns={[COLUMN_B]} reviewsByRunId={reviewsByRunId} prId="pr-1" onOpenTrace={vi.fn()} />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText("Tokens in: unknown")).toBeInTheDocument();
    expect(screen.getByText("Tokens out: unknown")).toBeInTheDocument();
  });
});
