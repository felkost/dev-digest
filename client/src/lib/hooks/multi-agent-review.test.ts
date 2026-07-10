/**
 * Multi-agent review hooks — useAgentEstimates / useStartMultiAgentRun /
 * useMultiAgentRun. Hermetic: `../api` is fully mocked, no running server.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../api", () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

import { api } from "../api";
import { useAgentEstimates, useStartMultiAgentRun, useMultiAgentRun } from "./multi-agent-review";

function wrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    queryClient,
    Wrapper: ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client: queryClient }, children),
  };
}

beforeEach(() => {
  vi.mocked(api.get).mockReset();
  vi.mocked(api.post).mockReset();
});

describe("useAgentEstimates", () => {
  it("fetches /pulls/:id/agent-estimates and returns the array", async () => {
    const estimates = [
      { agent_id: "a1", avg_duration_ms: 12000, avg_cost_usd: 0.05, sample_size: 3 },
      { agent_id: "a2", avg_duration_ms: null, avg_cost_usd: null, sample_size: 0 },
    ];
    vi.mocked(api.get).mockResolvedValueOnce(estimates);
    const { Wrapper } = wrapper();

    const { result } = renderHook(() => useAgentEstimates("pr-1"), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.get).toHaveBeenCalledWith("/pulls/pr-1/agent-estimates");
    expect(result.current.data).toEqual(estimates);
  });

  it("does not fetch when prId is null/undefined", () => {
    const { Wrapper } = wrapper();
    renderHook(() => useAgentEstimates(null), { wrapper: Wrapper });
    expect(api.get).not.toHaveBeenCalled();
  });
});

describe("useStartMultiAgentRun", () => {
  it("POSTs { agentIds } to /pulls/:id/multi-agent-run", async () => {
    const response = {
      multi_agent_run_id: "group-1",
      pr_id: "pr-1",
      runs: [
        { run_id: "run-1", agent_id: "a1" },
        { run_id: "run-2", agent_id: "a2" },
      ],
    };
    vi.mocked(api.post).mockResolvedValueOnce(response);
    const { Wrapper } = wrapper();

    const { result } = renderHook(() => useStartMultiAgentRun(), { wrapper: Wrapper });

    result.current.mutate({ prId: "pr-1", agentIds: ["a1", "a2"] });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.post).toHaveBeenCalledWith("/pulls/pr-1/multi-agent-run", { agentIds: ["a1", "a2"] });
    expect(result.current.data).toEqual(response);
  });

  it("invalidates reviews / pr-runs / pr-active-runs for the started PR on success, same as useRunReview", async () => {
    const response = {
      multi_agent_run_id: "group-1",
      pr_id: "pr-1",
      runs: [{ run_id: "run-1", agent_id: "a1" }],
    };
    vi.mocked(api.post).mockResolvedValueOnce(response);
    const { Wrapper, queryClient } = wrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useStartMultiAgentRun(), { wrapper: Wrapper });

    result.current.mutate({ prId: "pr-1", agentIds: ["a1"] });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["reviews", "pr-1"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["pr-runs", "pr-1"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["pr-active-runs", "pr-1"] });
  });
});

describe("useMultiAgentRun", () => {
  it("fetches /multi-agent-runs/:id and returns the composed run", async () => {
    const run = {
      id: "group-1",
      pr_id: "pr-1",
      pr_number: 42,
      ran_at: "2026-07-09T00:00:00Z",
      agent_count: 2,
      total_duration_ms: 5000,
      total_cost_usd: 0.1,
      columns: [
        { run_id: "run-1", agent_id: "a1", agent_name: "A1", provider: "openai", model: "gpt-5", status: "done", verdict: "approve", score: 90, summary: "ok", duration_ms: 5000, cost_usd: 0.1, findings: [] },
        { run_id: "run-2", agent_id: "a2", agent_name: "A2", provider: "openai", model: "gpt-5", status: "done", verdict: "approve", score: 80, summary: "ok", duration_ms: 4000, cost_usd: 0.05, findings: [] },
      ],
      conflicts: [],
    };
    vi.mocked(api.get).mockResolvedValueOnce(run);
    const { Wrapper } = wrapper();

    const { result } = renderHook(() => useMultiAgentRun("group-1"), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.get).toHaveBeenCalledWith("/multi-agent-runs/group-1");
    expect(result.current.data).toEqual(run);
  });

  it("does not fetch when groupId is null/undefined", () => {
    const { Wrapper } = wrapper();
    renderHook(() => useMultiAgentRun(null), { wrapper: Wrapper });
    expect(api.get).not.toHaveBeenCalled();
  });

  it("re-polls every 4000ms while some column is 'running' and stops once all are settled", async () => {
    vi.useFakeTimers();
    try {
      const runningRun = {
        id: "group-1",
        pr_id: "pr-1",
        pr_number: 42,
        ran_at: "2026-07-09T00:00:00Z",
        agent_count: 2,
        total_duration_ms: 1000,
        total_cost_usd: null,
        columns: [
          { run_id: "run-1", agent_id: "a1", agent_name: "A1", provider: "openai", model: "gpt-5", status: "done", verdict: "approve", score: 90, summary: "ok", duration_ms: 1000, cost_usd: 0.02, findings: [] },
          { run_id: "run-2", agent_id: "a2", agent_name: "A2", provider: null, model: null, status: "running", verdict: null, score: null, summary: null, duration_ms: null, cost_usd: null, findings: [] },
        ],
        conflicts: [],
      };
      const settledRun = {
        ...runningRun,
        total_duration_ms: 2000,
        total_cost_usd: 0.07,
        columns: [
          runningRun.columns[0],
          { ...runningRun.columns[1], status: "done", verdict: "approve", score: 70, summary: "ok", duration_ms: 2000, cost_usd: 0.05 },
        ],
      };
      vi.mocked(api.get)
        .mockResolvedValueOnce(runningRun)
        .mockResolvedValueOnce(settledRun);

      const { Wrapper } = wrapper();
      renderHook(() => useMultiAgentRun("group-1"), { wrapper: Wrapper });

      // Flush the initial fetch (queryFn resolves on a microtask).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(api.get).toHaveBeenCalledTimes(1);

      // A column is still 'running' → the poll interval fires a refetch.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4000);
      });
      expect(api.get).toHaveBeenCalledTimes(2);

      // Every column is now settled → no further refetch, even after another interval.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4000);
      });
      expect(api.get).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
