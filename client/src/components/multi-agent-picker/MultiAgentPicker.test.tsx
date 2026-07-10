/**
 * MultiAgentPicker — replaces RunReviewDropdown. Covers AC-1–5, AC-8–9:
 * zero-selected disables the confirm button, select-all/clear, the
 * zero-enabled-agents empty state, the MAX/SUM combined estimate (with one
 * selected agent missing history), and navigate-on-success (AC-3).
 *
 * Also covers 5 code-review fixes:
 *  1. onRunStart fires only after the mutation succeeds, never before; a
 *     failed mutation renders a visible inline error and keeps the panel open.
 *  2. "no history" (AC-7) is based on `sample_size === 0` — a known duration
 *     with an unknown cost is NOT "no history".
 *  3. a persistent merged-warning row renders inside the panel when
 *     `warnMerged` is true (not just the trigger's hover tooltip).
 *  4. the trigger button reflects the pending/loading state, and an outside
 *     click does not close the panel while a run is starting.
 *  5. router.push / onRunsStarted / setOpen are not called if the component
 *     unmounts while the start request is still in flight.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, within, cleanup, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { useEffect, useRef, useState } from "react";
import type { ComponentProps } from "react";
import type { Agent, AgentEstimate } from "@devdigest/shared";
import messages from "../../../messages/en/prReview.json";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

let mockAgents: Agent[] = [];
vi.mock("@/lib/hooks/agents", () => ({
  useAgents: () => ({ data: mockAgents }),
}));

let mockEstimates: AgentEstimate[] = [];
const startMutateAsync = vi.fn();
// A stateful mock of `useStartMultiAgentRun` — mirrors TanStack Query's real
// isPending/isError transitions (via component-local state) so the pending
// trigger/close-guard and inline-error tests can observe real re-renders.
// Guards its OWN state updates with a mounted-ref too (same pattern the real
// external-store-backed useMutation gets "for free" via useSyncExternalStore)
// so the unmount test isn't polluted by warnings from the mock itself.
vi.mock("@/lib/hooks/multi-agent-review", () => ({
  useAgentEstimates: (prId: string | null) => ({
    data: prId ? mockEstimates : undefined,
    isLoading: false,
  }),
  useStartMultiAgentRun: () => {
    const [isPending, setIsPending] = useState(false);
    const [isError, setIsError] = useState(false);
    const mountedRef = useRef(true);
    useEffect(() => {
      return () => {
        mountedRef.current = false;
      };
    }, []);
    const mutateAsync = async (...args: unknown[]) => {
      setIsPending(true);
      setIsError(false);
      try {
        const res = await startMutateAsync(...args);
        if (mountedRef.current) setIsPending(false);
        return res;
      } catch (err) {
        if (mountedRef.current) {
          setIsPending(false);
          setIsError(true);
        }
        throw err;
      }
    };
    return { mutateAsync, isPending, isError };
  },
}));

import { MultiAgentPicker } from "./MultiAgentPicker";

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

function renderPicker(props: Partial<ComponentProps<typeof MultiAgentPicker>> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ prReview: messages }}>
      <MultiAgentPicker prId="pr-1" {...props} />
    </NextIntlClientProvider>,
  );
}

async function openPanel(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Run Review" }));
  return within(screen.getByTestId("multi-agent-picker-panel"));
}

afterEach(() => {
  cleanup();
  push.mockClear();
  startMutateAsync.mockReset();
  mockAgents = [];
  mockEstimates = [];
});

describe("MultiAgentPicker", () => {
  it("keeps Run Review disabled until an agent is selected, then starts a grouped run and navigates to its results page (AC-3/AC-4)", async () => {
    mockAgents = [AGENT_A, AGENT_B];
    mockEstimates = [
      { agent_id: "a1", avg_duration_ms: 5000, avg_cost_usd: 0.05, sample_size: 3 },
      { agent_id: "a2", avg_duration_ms: 8000, avg_cost_usd: 0.08, sample_size: 2 },
    ];
    startMutateAsync.mockResolvedValueOnce({
      multi_agent_run_id: "group-1",
      pr_id: "pr-1",
      runs: [{ run_id: "run-1", agent_id: "a1", agent_name: "Security" }],
    });

    const user = userEvent.setup();
    renderPicker();
    const panel = await openPanel(user);

    const confirm = panel.getByRole("button", { name: "Run Review" });
    expect(confirm).toBeDisabled();

    await user.click(panel.getByRole("checkbox", { name: /Security/ }));
    expect(confirm).toBeEnabled();

    await user.click(confirm);

    expect(startMutateAsync).toHaveBeenCalledWith({ prId: "pr-1", agentIds: ["a1"] });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/multi-agent-review/group-1"));
  });

  it("select-all selects every enabled agent and clear resets the selection (AC-2)", async () => {
    mockAgents = [AGENT_A, AGENT_B];
    mockEstimates = [
      { agent_id: "a1", avg_duration_ms: 5000, avg_cost_usd: 0.05, sample_size: 3 },
      { agent_id: "a2", avg_duration_ms: 8000, avg_cost_usd: 0.08, sample_size: 2 },
    ];

    const user = userEvent.setup();
    renderPicker();
    const panel = await openPanel(user);

    await user.click(panel.getByRole("button", { name: "Select all" }));
    expect(panel.getByRole("checkbox", { name: /Security/ })).toBeChecked();
    expect(panel.getByRole("checkbox", { name: /Perf/ })).toBeChecked();
    expect(panel.getByRole("button", { name: "Run Review" })).toBeEnabled();

    await user.click(panel.getByRole("button", { name: "Clear" }));
    expect(panel.getByRole("checkbox", { name: /Security/ })).not.toBeChecked();
    expect(panel.getByRole("checkbox", { name: /Perf/ })).not.toBeChecked();
    expect(panel.getByRole("button", { name: "Run Review" })).toBeDisabled();
  });

  it("shows an explicit empty state directing to /agents when the workspace has no enabled agents (AC-5)", async () => {
    mockAgents = [{ ...AGENT_A, enabled: false }];

    const user = userEvent.setup();
    renderPicker();
    const panel = await openPanel(user);

    expect(panel.getByText("No enabled agents")).toBeInTheDocument();
    expect(panel.queryByRole("checkbox")).not.toBeInTheDocument();

    await user.click(panel.getByRole("button", { name: "Go to Agents" }));
    expect(push).toHaveBeenCalledWith("/agents");
  });

  it("computes the combined estimate as MAX duration / SUM cost and flags a missing estimate (AC-8/AC-9)", async () => {
    mockAgents = [AGENT_A, AGENT_B];
    // a1 has history; a2 has none (sample_size 0) — combined must reflect
    // only a1's numbers and flag the gap, never treat a2 as zero.
    mockEstimates = [
      { agent_id: "a1", avg_duration_ms: 5000, avg_cost_usd: 0.05, sample_size: 3 },
      { agent_id: "a2", avg_duration_ms: null, avg_cost_usd: null, sample_size: 0 },
    ];

    const user = userEvent.setup();
    renderPicker();
    const panel = await openPanel(user);

    await user.click(panel.getByRole("button", { name: "Select all" }));

    expect(
      panel.getByText("Combined estimate: ≈5.0s · $0.05 (at least one selected agent has no run history)"),
    ).toBeInTheDocument();
  });

  // ---- Bug 1: onRunStart timing + surfaced mutation errors ----------------

  it("does not fire onRunStart before the request settles, and shows an inline error + keeps the panel open when the start mutation fails", async () => {
    mockAgents = [AGENT_A];
    mockEstimates = [{ agent_id: "a1", avg_duration_ms: 5000, avg_cost_usd: 0.05, sample_size: 3 }];
    startMutateAsync.mockRejectedValueOnce(new Error("network down"));
    const onRunStart = vi.fn();
    const onRunsStarted = vi.fn();

    const user = userEvent.setup();
    renderPicker({ onRunStart, onRunsStarted });
    const panel = await openPanel(user);

    await user.click(panel.getByRole("checkbox", { name: /Security/ }));
    await user.click(panel.getByRole("button", { name: "Run Review" }));

    expect(await panel.findByTestId("multi-agent-picker-error")).toHaveTextContent(
      "Couldn’t start the review. Please try again.",
    );
    // Panel stays open on failure — no navigation, no success callbacks.
    expect(screen.getByTestId("multi-agent-picker-panel")).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
    expect(onRunStart).not.toHaveBeenCalled();
    expect(onRunsStarted).not.toHaveBeenCalled();
  });

  // ---- Bug 2: sample_size-based "no history" rule --------------------------

  it("treats a known duration with an unknown cost as history, not 'no history' — renders '—' only for the missing field (AC-7)", async () => {
    mockAgents = [AGENT_A];
    mockEstimates = [{ agent_id: "a1", avg_duration_ms: 5000, avg_cost_usd: null, sample_size: 3 }];

    const user = userEvent.setup();
    renderPicker();
    const panel = await openPanel(user);

    expect(panel.getByText("≈5.0s · —")).toBeInTheDocument();
    expect(panel.queryByText("no history")).not.toBeInTheDocument();
  });

  it("still shows 'no history' when sample_size is 0 (AC-7)", async () => {
    mockAgents = [AGENT_A];
    mockEstimates = [{ agent_id: "a1", avg_duration_ms: null, avg_cost_usd: null, sample_size: 0 }];

    const user = userEvent.setup();
    renderPicker();
    const panel = await openPanel(user);

    expect(panel.getByText("no history")).toBeInTheDocument();
  });

  // ---- Bug 3: persistent merged-warning row --------------------------------

  it("renders a persistent merged-warning row inside the panel when warnMerged is true, and omits it otherwise", async () => {
    mockAgents = [AGENT_A];
    mockEstimates = [{ agent_id: "a1", avg_duration_ms: 5000, avg_cost_usd: 0.05, sample_size: 3 }];

    const user = userEvent.setup();
    renderPicker({ warnMerged: true });
    const panel = await openPanel(user);
    expect(panel.getByTestId("multi-agent-picker-merged-warning")).toHaveTextContent(
      "Already merged — review is informational",
    );
    cleanup();

    renderPicker({ warnMerged: false });
    const panel2 = await openPanel(user);
    expect(panel2.queryByTestId("multi-agent-picker-merged-warning")).not.toBeInTheDocument();
  });

  // ---- Bug 4: pending trigger state + outside-click close guard -----------

  it("shows the trigger's pending state while starting, and does not close the panel on an outside click while pending", async () => {
    mockAgents = [AGENT_A];
    mockEstimates = [{ agent_id: "a1", avg_duration_ms: 5000, avg_cost_usd: 0.05, sample_size: 3 }];
    let resolveStart!: (v: unknown) => void;
    startMutateAsync.mockImplementationOnce(
      () => new Promise((resolve) => { resolveStart = resolve; }),
    );

    const user = userEvent.setup();
    renderPicker();
    const panel = await openPanel(user);
    await user.click(panel.getByRole("checkbox", { name: /Security/ }));

    fireEvent.click(panel.getByRole("button", { name: "Run Review" }));

    // Both the trigger and the in-panel confirm button flip to the pending
    // label while the request is in flight.
    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "Running…" })).toHaveLength(2);
    });

    // An outside click must NOT dismiss the panel while pending.
    fireEvent.mouseDown(document.body);
    expect(screen.getByTestId("multi-agent-picker-panel")).toBeInTheDocument();

    resolveStart({
      multi_agent_run_id: "group-2",
      pr_id: "pr-1",
      runs: [{ run_id: "run-1", agent_id: "a1", agent_name: "Security" }],
    });

    await waitFor(() => expect(push).toHaveBeenCalledWith("/multi-agent-review/group-2"));
  });

  // ---- Bug 5: unmount guard --------------------------------------------------

  it("does not call router.push or onRunsStarted (and does not warn) if the component unmounts while the start request is still in flight", async () => {
    mockAgents = [AGENT_A];
    mockEstimates = [{ agent_id: "a1", avg_duration_ms: 5000, avg_cost_usd: 0.05, sample_size: 3 }];
    let resolveStart!: (v: unknown) => void;
    startMutateAsync.mockImplementationOnce(
      () => new Promise((resolve) => { resolveStart = resolve; }),
    );
    const onRunsStarted = vi.fn();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const user = userEvent.setup();
    const { unmount } = renderPicker({ onRunsStarted });
    const panel = await openPanel(user);
    await user.click(panel.getByRole("checkbox", { name: /Security/ }));
    fireEvent.click(panel.getByRole("button", { name: "Run Review" }));

    unmount();

    resolveStart({
      multi_agent_run_id: "group-3",
      pr_id: "pr-1",
      runs: [{ run_id: "run-1", agent_id: "a1", agent_name: "Security" }],
    });
    // Flush the resolved promise chain past the component's unmount.
    await new Promise((r) => setTimeout(r, 0));

    expect(push).not.toHaveBeenCalled();
    expect(onRunsStarted).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();

    errorSpy.mockRestore();
  });
});
