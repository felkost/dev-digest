/**
 * MultiAgentResultsView — covers AC-20 (Columns/Tabs toggle without
 * re-fetching or re-running anything — both views read the same
 * already-fetched `data`) and AC-34 (trace-drawer open call wiring: "View
 * trace" from a column opens the existing RunTraceDrawer with that column's
 * run_id, mocked here to avoid loading the real trace machinery).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { MultiAgentRun, ReviewRecord } from "@devdigest/shared";
import maResultsMessages from "../../../../../../messages/en/multi-agent-review.json";
import prReviewMessages from "../../../../../../messages/en/prReview.json";

vi.mock("@/components/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  useSearchParams: () => null,
}));

let runData: MultiAgentRun | undefined;
let isLoading = false;
let isError = false;
const refetch = vi.fn();

vi.mock("@/lib/hooks/multi-agent-review", () => ({
  useMultiAgentRun: () => ({ data: runData, isLoading, isError, error: null, refetch }),
}));

// The Tabs view's full finding detail is sourced from this cache (mapped
// run_id -> ReviewRecord), not from the compact AgentColumn.findings — so
// its fixture must independently carry the same finding for run-1.
const REVIEW_RUN_1: ReviewRecord = {
  id: "review-1",
  pr_id: "pr-1",
  agent_id: "a1",
  run_id: "run-1",
  agent_name: "Security",
  kind: "review",
  verdict: "approve",
  summary: "ok",
  score: 90,
  model: "gpt-5",
  grounding: null,
  created_at: "2026-07-09T00:00:00Z",
  findings: [
    {
      id: "f1",
      severity: "WARNING",
      category: "perf",
      title: "N+1 query",
      file: "src/db.ts",
      start_line: 22,
      end_line: 22,
      rationale: "This loops a query per row.",
      suggestion: null,
      confidence: 0.8,
      kind: "finding",
      trifecta_components: null,
      evidence: null,
      review_id: "review-1",
      accepted_at: null,
      dismissed_at: null,
    },
  ],
};

const refetchReviews = vi.fn();
let liveRunning = false;
vi.mock("@/lib/hooks/reviews", () => ({
  usePrReviews: () => ({ data: [REVIEW_RUN_1], refetch: refetchReviews }),
  useRunEvents: () => ({ events: [], running: liveRunning }),
  useFindingAction: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/lib/hooks/eval", () => ({
  useCreateEvalCaseFromFinding: () => ({ mutate: vi.fn(), isPending: false, isSuccess: false }),
}));

// The header joins the PR title from this existing endpoint (the frozen
// MultiAgentRun contract carries only pr_number). usePullDetail is the only
// @/lib/hooks/core import anywhere in this render tree, so a full replacement
// mock is safe.
vi.mock("@/lib/hooks/core", () => ({
  usePullDetail: () => ({ data: { number: 42, title: "Add rate limiting to public API endpoints" } }),
}));

const traceDrawerProps: Record<string, unknown>[] = [];
vi.mock("@/app/repos/[repoId]/pulls/[number]/_components/RunTraceDrawer", () => ({
  default: (props: Record<string, unknown>) => {
    traceDrawerProps.push(props);
    return <div data-testid="trace-drawer">trace for {String(props.runId)}</div>;
  },
}));

import { MultiAgentResultsView } from "./MultiAgentResultsView";

afterEach(() => {
  cleanup();
  runData = undefined;
  isLoading = false;
  isError = false;
  liveRunning = false;
  refetch.mockClear();
  refetchReviews.mockClear();
  push.mockClear();
  traceDrawerProps.length = 0;
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

function run(overrides: Partial<MultiAgentRun> = {}): MultiAgentRun {
  return {
    id: "group-1",
    pr_id: "pr-1",
    pr_number: 42,
    ran_at: "2026-07-09T00:00:00Z",
    agent_count: 2,
    total_duration_ms: 5000,
    total_cost_usd: 0.1,
    total_tokens_in: 20000,
    total_tokens_out: 3000,
    columns: [
      {
        run_id: "run-1",
        agent_id: "a1",
        agent_name: "Security",
        provider: "openai",
        model: "gpt-5",
        status: "done",
        verdict: "approve",
        score: 90,
        summary: "ok",
        duration_ms: 5000,
        cost_usd: 0.1,
        error: null,
        tokens_in: 12000,
        tokens_out: 1500,
        findings: [{ id: "f1", severity: "WARNING", category: "perf", title: "N+1 query", file: "src/db.ts", start_line: 22, kind: null }],
      },
      {
        run_id: "run-2",
        agent_id: "a2",
        agent_name: "Performance",
        provider: "openai",
        model: "gpt-5",
        status: "done",
        verdict: "approve",
        score: 80,
        summary: "ok",
        duration_ms: 4000,
        cost_usd: 0.05,
        error: null,
        tokens_in: 8000,
        tokens_out: 1500,
        findings: [],
      },
    ],
    conflicts: [],
    ...overrides,
  };
}

describe("MultiAgentResultsView", () => {
  it("shows a loading skeleton while the run is loading", () => {
    isLoading = true;
    renderWithIntl(<MultiAgentResultsView runId="group-1" />);
    expect(screen.queryByText("Columns")).not.toBeInTheDocument();
  });

  it("shows the error state with retry on load failure", async () => {
    isError = true;
    const user = userEvent.setup();
    renderWithIntl(<MultiAgentResultsView runId="group-1" />);
    expect(screen.getByText("Could not load this run")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Retry/ }));
    expect(refetch).toHaveBeenCalled();
  });

  it("defaults to the Columns view (AC-15) and switches to Tabs on the same already-fetched data, no re-fetch (AC-20)", async () => {
    runData = run();
    const user = userEvent.setup();
    renderWithIntl(<MultiAgentResultsView runId="group-1" />);

    // Columns view: compact finding row visible.
    expect(screen.getByText("N+1 query")).toBeInTheDocument();
    expect(screen.getByText("src/db.ts:22")).toBeInTheDocument();

    const fetchCallsBeforeToggle = refetch.mock.calls.length;
    await user.click(screen.getByRole("button", { name: "Tabs" }));

    // Tabs view: same finding, now as a full FindingCard (Accept/Dismiss present).
    expect(screen.getByText("N+1 query")).toBeInTheDocument();
    expect(screen.getByText("Accept")).toBeInTheDocument();
    // Toggling views is pure client-side state — no additional refetch fired.
    expect(refetch.mock.calls.length).toBe(fetchCallsBeforeToggle);
  });

  it("opens the existing RunTraceDrawer with the clicked column's run_id (AC-34)", async () => {
    runData = run();
    const user = userEvent.setup();
    renderWithIntl(<MultiAgentResultsView runId="group-1" />);

    const traceLinks = screen.getAllByText("View trace");
    await user.click(traceLinks[0]!);

    expect(screen.getByTestId("trace-drawer")).toBeInTheDocument();
    expect(traceDrawerProps.at(-1)).toMatchObject({ runId: "run-1", agentName: "Security", prNumber: 42 });
  });

  it("shows total cost as an explicit 'unknown' affordance rather than coercing null to $0 (AC-33/36)", () => {
    runData = run({ total_cost_usd: null });
    renderWithIntl(<MultiAgentResultsView runId="group-1" />);
    expect(screen.getByText(/unknown/)).toBeInTheDocument();
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
  });

  it("shows run-total token usage next to total cost/duration, and an explicit 'unknown' affordance rather than coercing null to 0 (AC-33)", () => {
    runData = run();
    renderWithIntl(<MultiAgentResultsView runId="group-1" />);
    expect(screen.getByText("Total tokens in: 20.0k")).toBeInTheDocument();
    expect(screen.getByText("Total tokens out: 3.0k")).toBeInTheDocument();
  });

  it("shows 'unknown' for run-total tokens when null, never coercing to 0 (AC-33)", () => {
    runData = run({ total_tokens_in: null, total_tokens_out: null });
    renderWithIntl(<MultiAgentResultsView runId="group-1" />);
    expect(screen.getByText("Total tokens in: unknown")).toBeInTheDocument();
    expect(screen.getByText("Total tokens out: unknown")).toBeInTheDocument();
    expect(screen.queryByText(/Total tokens in: 0/)).not.toBeInTheDocument();
  });

  it("titles the page with the feature name and shows the PR reference + title joined from usePullDetail", () => {
    runData = run();
    renderWithIntl(<MultiAgentResultsView runId="group-1" />);
    // h1 is the feature name, not "PR #N".
    expect(screen.getByRole("heading", { name: "Multi-Agent Review" })).toBeInTheDocument();
    // PR reference badge + the title from usePullDetail.
    expect(screen.getByText("#42")).toBeInTheDocument();
    expect(screen.getByText("Add rate limiting to public API endpoints")).toBeInTheDocument();
    expect(screen.getByText("2 selected agents · parallel")).toBeInTheDocument();
  });

  it("also refetches usePrReviews (not just the run poll) when the live SSE stream settles, so Tabs view picks up a newly-completed agent's findings", async () => {
    runData = run();
    liveRunning = true;
    const { rerender } = renderWithIntl(<MultiAgentResultsView runId="group-1" />);
    expect(refetch).not.toHaveBeenCalled();
    expect(refetchReviews).not.toHaveBeenCalled();

    // Running -> settled transition (mirrors the wasRunning ref pattern under test).
    liveRunning = false;
    rerender(
      <NextIntlClientProvider
        locale="en"
        messages={{ "multi-agent-review": maResultsMessages, prReview: prReviewMessages }}
      >
        <MultiAgentResultsView runId="group-1" />
      </NextIntlClientProvider>,
    );

    expect(refetch).toHaveBeenCalledTimes(1);
    expect(refetchReviews).toHaveBeenCalledTimes(1);
  });

  it("omits the disagreement section when fewer than 2 columns are done (AC-32)", () => {
    runData = run({
      columns: [
        { ...run().columns[0]!, status: "running", score: null },
        { ...run().columns[1]!, status: "running", score: null },
      ],
    });
    renderWithIntl(<MultiAgentResultsView runId="group-1" />);
    expect(screen.queryByText("Where agents disagree")).not.toBeInTheDocument();
  });
});
