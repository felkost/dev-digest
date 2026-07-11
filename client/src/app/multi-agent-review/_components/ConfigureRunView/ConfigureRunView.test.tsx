/**
 * ConfigureRunView — Configure-run flow. Covers the AC-11 PR-gate (agent
 * picker stays inert with an explicit prompt until a PR is chosen) and the
 * AC-12 confirm → start → navigate flow. Hooks are mocked; no QueryClient
 * or running server needed.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import messages from "../../../../../messages/en/multi-agent-review.json";

vi.mock("@/components/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/lib/repo-context", () => ({
  useActiveRepo: () => ({ repoId: "repo-1", activeRepo: { id: "repo-1", full_name: "acme/widgets" } }),
}));

const REPOS = [{ id: "repo-1", full_name: "acme/widgets", default_branch: "main", clone_path: null, last_polled_at: null, created_by: null, workspace_id: "w1" }];
const PULLS = [
  { id: "pr-1", number: 10, title: "Add feature", author: "alice", branch: "b1", base: "main", head_sha: "sha1", additions: 1, deletions: 1, files_count: 1, status: "open" },
  { id: "pr-2", number: 11, title: "Fix bug", author: "bob", branch: "b2", base: "main", head_sha: "sha2", additions: 1, deletions: 1, files_count: 1, status: "open" },
];
const AGENTS = [
  { id: "a1", name: "Security", description: "Flags security issues", provider: "openai", model: "gpt-5", system_prompt: "", enabled: true, version: 1, strategy: "single-pass", ci_fail_on: "critical", repo_intel: true },
  { id: "a2", name: "Perf", description: "Flags perf issues", provider: "openai", model: "gpt-5", system_prompt: "", enabled: true, version: 1, strategy: "single-pass", ci_fail_on: "critical", repo_intel: true },
];
const ESTIMATES = [
  { agent_id: "a1", avg_duration_ms: 5000, avg_cost_usd: 0.05, sample_size: 3 },
  { agent_id: "a2", avg_duration_ms: null, avg_cost_usd: null, sample_size: 0 },
];

vi.mock("@/lib/hooks", () => ({
  useRepos: () => ({ data: REPOS, isLoading: false }),
  usePulls: () => ({ data: PULLS, isLoading: false }),
  useAgents: () => ({ data: AGENTS, isLoading: false }),
}));

const startMutate = vi.fn();
let startIsPending = false;

vi.mock("@/lib/hooks/multi-agent-review", () => ({
  useAgentEstimates: (prId: string | null) => ({ data: prId ? ESTIMATES : undefined }),
  useStartMultiAgentRun: () => ({ mutate: startMutate, isPending: startIsPending }),
}));

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

import { ConfigureRunView } from "./ConfigureRunView";

afterEach(() => {
  cleanup();
  startMutate.mockClear();
  startIsPending = false;
  push.mockClear();
});

function renderView() {
  return render(
    <NextIntlClientProvider locale="en" messages={{ "multi-agent-review": messages }}>
      <ConfigureRunView />
    </NextIntlClientProvider>,
  );
}

async function selectPr(user: ReturnType<typeof userEvent.setup>, label: string) {
  const combos = screen.getAllByRole("combobox");
  // Repository combobox first, pull-request combobox second (DOM order).
  await user.click(combos[1]!);
  await user.click(screen.getByText(label));
}

describe("ConfigureRunView — Configure-run flow", () => {
  it("keeps the agent picker inert with an explicit prompt until a PR is chosen (AC-11)", () => {
    renderView();
    expect(screen.getByText("Choose a pull request first — the agent picker becomes available once you have.")).toBeInTheDocument();
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  });

  it("reveals the agent checkboxes once a PR is chosen", async () => {
    const user = userEvent.setup();
    renderView();
    await selectPr(user, "#10 · Add feature");
    expect(screen.getAllByRole("checkbox")).toHaveLength(AGENTS.length);
  });

  it("shows a no-history marker for an agent with sample_size 0 (AC-7)", async () => {
    const user = userEvent.setup();
    renderView();
    await selectPr(user, "#10 · Add feature");
    expect(screen.getByText("no history")).toBeInTheDocument();
  });

  it("keeps the confirm action disabled until at least one agent is selected (AC-4)", async () => {
    const user = userEvent.setup();
    renderView();
    await selectPr(user, "#10 · Add feature");
    expect(screen.getByRole("button", { name: /Start multi-agent run/ })).toBeDisabled();
  });

  it("confirm starts the run and navigates to its results page (AC-3/AC-12)", async () => {
    startMutate.mockImplementation((_input, opts) => {
      opts.onSuccess({ multi_agent_run_id: "group-1", pr_id: "pr-1", runs: [] });
    });
    const user = userEvent.setup();
    renderView();
    await selectPr(user, "#10 · Add feature");
    await user.click(screen.getByRole("checkbox", { name: /Security/ }));
    await user.click(screen.getByRole("button", { name: /Start multi-agent run/ }));

    expect(startMutate).toHaveBeenCalledWith(
      { prId: "pr-1", agentIds: ["a1"] },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
    expect(push).toHaveBeenCalledWith("/multi-agent-review/group-1");
  });
});
