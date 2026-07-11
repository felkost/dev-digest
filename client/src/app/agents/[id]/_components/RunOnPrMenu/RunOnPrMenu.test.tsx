/**
 * RunOnPrMenu — the Agent Editor's "Run Review" reworked into a dropdown of
 * the active repo's open PRs. Covers: picking a PR STARTS a run of THIS agent
 * on it (useStartMultiAgentRun({ prId, agentIds: [agentId] })) and navigates to
 * the live run page (/multi-agent-review/:id); the no-open-PRs and no-repo
 * empty rows; closed/merged PRs are excluded.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// vi.mock factories are hoisted above const declarations — everything they
// reference must come from vi.hoisted() to avoid a TDZ ReferenceError.
const h = vi.hoisted(() => ({
  push: vi.fn(),
  startMutate: vi.fn(),
  notify: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  state: {
    activeRepo: { id: "repo-1" } as { id: string } | null,
    pulls: [] as Array<{ id: string; number: number; title: string; status: string }>,
    loading: false,
  },
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push }) }));
vi.mock("@/lib/repo-context", () => ({ useActiveRepo: () => ({ activeRepo: h.state.activeRepo }) }));
vi.mock("@/lib/hooks", () => ({ usePulls: () => ({ data: h.state.pulls, isLoading: h.state.loading }) }));
vi.mock("@/lib/hooks/multi-agent-review", () => ({
  useStartMultiAgentRun: () => ({ mutate: h.startMutate, isPending: false }),
}));
vi.mock("@/lib/toast", () => ({ notify: h.notify }));

import { RunOnPrMenu } from "./RunOnPrMenu";

afterEach(() => {
  cleanup();
  h.push.mockClear();
  h.startMutate.mockReset();
  h.notify.success.mockClear();
  h.notify.error.mockClear();
  h.state.activeRepo = { id: "repo-1" };
  h.state.pulls = [];
  h.state.loading = false;
});

describe("RunOnPrMenu", () => {
  it("lists only open PRs and, on pick, starts this agent on that PR then navigates to the live run page", async () => {
    h.state.pulls = [
      { id: "pr-12", number: 12, title: "Fix the login bug", status: "needs_review" },
      { id: "pr-9", number: 9, title: "Old merged work", status: "merged" }, // excluded
    ];
    h.startMutate.mockImplementation((_vars: unknown, opts?: { onSuccess?: (d: unknown) => void }) => {
      opts?.onSuccess?.({ multi_agent_run_id: "grp-1", runs: [] });
    });

    const user = userEvent.setup();
    render(<RunOnPrMenu agentId="agent-1" agentName="Security" />);

    await user.click(screen.getByRole("button", { name: "Run Review" }));

    // Open PR is offered; the merged one is not.
    expect(screen.getByRole("button", { name: /Fix the login bug/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Old merged work/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Fix the login bug/ }));

    expect(h.startMutate).toHaveBeenCalledTimes(1);
    expect(h.startMutate.mock.calls[0]![0]).toEqual({ prId: "pr-12", agentIds: ["agent-1"] });
    expect(h.push).toHaveBeenCalledWith("/multi-agent-review/grp-1");
  });

  it("shows an empty row when the active repo has no open PRs", async () => {
    h.state.pulls = [{ id: "pr-9", number: 9, title: "Merged", status: "merged" }];

    const user = userEvent.setup();
    render(<RunOnPrMenu agentId="agent-1" agentName="Security" />);
    await user.click(screen.getByRole("button", { name: "Run Review" }));

    expect(screen.getByText("No open pull requests")).toBeInTheDocument();
    expect(h.startMutate).not.toHaveBeenCalled();
  });

  it("shows a no-repository row when no repo is active", async () => {
    h.state.activeRepo = null;

    const user = userEvent.setup();
    render(<RunOnPrMenu agentId="agent-1" agentName="Security" />);
    await user.click(screen.getByRole("button", { name: "Run Review" }));

    expect(screen.getByText("No repository connected")).toBeInTheDocument();
  });
});
