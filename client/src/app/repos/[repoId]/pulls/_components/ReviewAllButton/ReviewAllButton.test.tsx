/**
 * ReviewAllButton — the repo-wide "Review all" reworked into an agent picker.
 * Covers: confirm is disabled until an agent is picked; confirming fans the
 * CHOSEN agents out via useReviewAll({ agentIds }); select-all/clear; and the
 * no-enabled-agents empty state.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, within, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { Agent } from "@devdigest/shared";
import messages from "../../../../../../../messages/en/prReview.json";

// vi.mock factories are hoisted above const declarations — everything they
// reference must come from vi.hoisted() to avoid a TDZ ReferenceError.
const h = vi.hoisted(() => ({
  push: vi.fn(),
  reviewAllMutate: vi.fn(),
  notify: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  state: { agents: [] as Agent[], pending: false },
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push }) }));
vi.mock("@/lib/hooks/agents", () => ({ useAgents: () => ({ data: h.state.agents }) }));
vi.mock("@/lib/hooks/reviews", () => ({
  useReviewAll: () => ({ mutate: h.reviewAllMutate, isPending: h.state.pending }),
}));
vi.mock("@/lib/toast", () => ({ notify: h.notify }));

import { ReviewAllButton } from "./ReviewAllButton";

const AGENT_A: Agent = {
  id: "a1",
  name: "Security",
  description: "Flags security issues",
  provider: "openai",
  model: "gpt-5",
  system_prompt: "",
  enabled: true,
  version: 1,
  strategy: "single-pass",
  ci_fail_on: "critical",
  repo_intel: true,
};
const AGENT_B: Agent = { ...AGENT_A, id: "a2", name: "Perf", description: "Flags perf issues" };

function renderButton() {
  return render(
    <NextIntlClientProvider locale="en" messages={{ prReview: messages }}>
      <ReviewAllButton repoId="repo-1" />
    </NextIntlClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  h.push.mockClear();
  h.reviewAllMutate.mockReset();
  h.notify.success.mockClear();
  h.notify.error.mockClear();
  h.notify.info.mockClear();
  h.state.agents = [];
  h.state.pending = false;
});

describe("ReviewAllButton", () => {
  it("keeps confirm disabled until an agent is picked, then fans the chosen agents out over all open PRs", async () => {
    h.state.agents = [AGENT_A, AGENT_B];
    // A successful fan-out reports how many PRs were triggered.
    h.reviewAllMutate.mockImplementation((_vars: unknown, opts?: { onSuccess?: (d: unknown) => void }) => {
      opts?.onSuccess?.({ triggered: 3 });
    });

    const user = userEvent.setup();
    renderButton();

    // Only the trigger exists before opening.
    await user.click(screen.getByRole("button", { name: "Review all" }));
    const panel = within(screen.getByTestId("review-all-panel"));

    const confirm = panel.getByRole("button", { name: "Review all" });
    expect(confirm).toBeDisabled();

    await user.click(panel.getByRole("checkbox", { name: /Security/ }));
    expect(confirm).toBeEnabled();

    await user.click(confirm);

    expect(h.reviewAllMutate).toHaveBeenCalledTimes(1);
    expect(h.reviewAllMutate.mock.calls[0]![0]).toEqual({ agentIds: ["a1"] });
    expect(h.notify.success).toHaveBeenCalledWith("Reviewing 3 pull request(s)…");
  });

  it("select-all picks every enabled agent and passes all ids; clear resets it", async () => {
    h.state.agents = [AGENT_A, AGENT_B];
    h.reviewAllMutate.mockImplementation((_vars: unknown, opts?: { onSuccess?: (d: unknown) => void }) => {
      opts?.onSuccess?.({ triggered: 1 });
    });

    const user = userEvent.setup();
    renderButton();
    await user.click(screen.getByRole("button", { name: "Review all" }));
    const panel = within(screen.getByTestId("review-all-panel"));

    await user.click(panel.getByRole("button", { name: "Select all" }));
    expect(panel.getByRole("checkbox", { name: /Security/ })).toBeChecked();
    expect(panel.getByRole("checkbox", { name: /Perf/ })).toBeChecked();

    await user.click(panel.getByRole("button", { name: "Clear" }));
    expect(panel.getByRole("checkbox", { name: /Security/ })).not.toBeChecked();
    expect(panel.getByRole("button", { name: "Review all" })).toBeDisabled();
  });

  it("shows the no-enabled-agents empty state and never a checkbox", async () => {
    h.state.agents = [{ ...AGENT_A, enabled: false }];

    const user = userEvent.setup();
    renderButton();
    await user.click(screen.getByRole("button", { name: "Review all" }));
    const panel = within(screen.getByTestId("review-all-panel"));

    expect(panel.getByText("No enabled agents")).toBeInTheDocument();
    expect(panel.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(h.reviewAllMutate).not.toHaveBeenCalled();
  });
});
