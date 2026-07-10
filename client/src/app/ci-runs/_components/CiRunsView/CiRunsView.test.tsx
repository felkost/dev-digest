/**
 * CiRunsView — page-level empty/error states, status badges, and filter wiring.
 * Hooks (`ci`, `agents`, `core`) are mocked directly (client insights.md's
 * "mocked-API, parallel with server" convention) — `GET /ci/runs`/`POST /ci/check`
 * don't exist on the server yet (Step 11 lands later), so these tests verify
 * the view's own logic against controllable fixtures, not a live endpoint.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { CiRun } from "@devdigest/shared";
import ciMessages from "../../../../../messages/en/ci.json";

vi.mock("@/components/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const useCiRunsMock = vi.fn();
const checkMutate = vi.fn();
let checkState: { isPending: boolean; isError: boolean } = { isPending: false, isError: false };

vi.mock("@/lib/hooks/ci", () => ({
  useCiRuns: (...args: unknown[]) => useCiRunsMock(...args),
  useCiCheck: () => ({ mutate: checkMutate, isPending: checkState.isPending, isError: checkState.isError }),
}));

let agentsData: { id: string; name: string }[] = [];
vi.mock("@/lib/hooks/agents", () => ({
  useAgents: () => ({ data: agentsData }),
}));

let reposData: { id: string; full_name: string }[] = [];
vi.mock("@/lib/hooks/core", () => ({
  useRepos: () => ({ data: reposData }),
}));

import { CiRunsView } from "./CiRunsView";

function run(partial: Partial<CiRun> & { id: string }): CiRun {
  return {
    ci_installation_id: "inst-1",
    pr_number: 42,
    ran_at: "2026-07-10T10:00:00.000Z",
    status: "succeeded",
    findings_count: 2,
    critical: 0,
    warning: 1,
    suggestion: 1,
    cost_usd: 0.12,
    github_url: "https://github.com/acme/widgets/actions/runs/1",
    source: null,
    agent: "Security Reviewer",
    duration_s: 42,
    repo: "acme/widgets",
    ...partial,
  };
}

function mockRuns(runs: CiRun[], lastCheckedAt: string | null = null) {
  useCiRunsMock.mockReturnValue({
    data: { runs, last_checked_at: lastCheckedAt },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  });
}

function renderView() {
  return render(
    <NextIntlClientProvider locale="en" messages={{ ci: ciMessages }}>
      <CiRunsView />
    </NextIntlClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  useCiRunsMock.mockReset();
  checkMutate.mockClear();
  checkState = { isPending: false, isError: false };
  agentsData = [];
  reposData = [];
});

describe("CiRunsView", () => {
  it("shows the never-run state on open, then the no-match state as the user applies each filter", async () => {
    mockRuns([]);
    agentsData = [{ id: "agent-1", name: "Security Reviewer" }];
    reposData = [{ id: "repo-1", full_name: "acme/widgets" }];
    const user = userEvent.setup();
    renderView();

    // Page-open: zero runs, no filter active yet — the "never run" copy, not "no match".
    expect(screen.getByText("No CI runs yet")).toBeInTheDocument();
    expect(screen.getByText("Once you export an agent to CI, every automated review shows up here.")).toBeInTheDocument();
    // The table polls GET /ci/runs (a cheap DB read) on a fixed interval tied to
    // this page's own mount lifecycle (AC-16) — asserted once, here, rather than
    // in a separate test, since it's part of the same initial-render call.
    expect(useCiRunsMock.mock.calls.at(-1)![1]).toEqual(expect.objectContaining({ refetchInterval: 15_000 }));

    // Pick an agent — updates the query filters.
    let combos = screen.getAllByRole("combobox");
    await user.click(combos[0]!);
    await user.click(screen.getByRole("button", { name: "Security Reviewer" }));
    expect(useCiRunsMock.mock.calls.at(-1)![0]).toEqual(expect.objectContaining({ agentId: "agent-1" }));

    // Pick a repo.
    combos = screen.getAllByRole("combobox");
    await user.click(combos[1]!);
    await user.click(screen.getByRole("button", { name: "acme/widgets" }));
    expect(useCiRunsMock.mock.calls.at(-1)![0]).toEqual(
      expect.objectContaining({ agentId: "agent-1", repo: "acme/widgets" }),
    );

    // Pick a status.
    combos = screen.getAllByRole("combobox");
    await user.click(combos[2]!);
    await user.click(screen.getByRole("button", { name: "Failed" }));
    expect(useCiRunsMock.mock.calls.at(-1)![0]).toEqual(
      expect.objectContaining({ agentId: "agent-1", repo: "acme/widgets", status: "failed" }),
    );

    // Toggle the recency chip.
    await user.click(screen.getByRole("button", { name: "Last 7 days" }));
    expect(useCiRunsMock.mock.calls.at(-1)![0]).toEqual(
      expect.objectContaining({ agentId: "agent-1", repo: "acme/widgets", status: "failed", sinceDays: 7 }),
    );

    // Mocked data is still zero runs, but now a filter is active — the "no
    // match" copy replaces the initial "never run" copy.
    expect(screen.getByText("No runs match the current filters.")).toBeInTheDocument();
    expect(screen.queryByText("No CI runs yet")).not.toBeInTheDocument();
  });

  it("shows the check-failed banner while still rendering existing run rows, and gives skipped_fork its own distinct status label", () => {
    mockRuns(
      [
        run({ id: "run-1", status: "succeeded" }),
        run({ id: "run-skip", status: "skipped_fork", pr_number: 10 }),
        run({ id: "run-fail", status: "failed", pr_number: 11 }),
      ],
      "2026-07-10T10:05:00.000Z",
    );
    checkState = { isPending: false, isError: true };
    renderView();

    // Banner is additive, not a replacement — existing rows still render underneath it.
    expect(screen.getByText("Last check failed — try refreshing again.")).toBeInTheDocument();
    expect(screen.getAllByText("acme/widgets").length).toBeGreaterThan(0);

    // The check-failed banner reads distinctly from both empty states too —
    // neither the "never run" nor the "no match" copy leaks in alongside it,
    // so all 3 page-level states stay assertably different, never variations
    // of one generic message.
    expect(screen.queryByText("No CI runs yet")).not.toBeInTheDocument();
    expect(screen.queryByText("No runs match the current filters.")).not.toBeInTheDocument();

    // skipped_fork reads distinctly from failed (never conflated into one label).
    expect(screen.getByText("Skipped (fork)")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
  });
});
