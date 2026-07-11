import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { Agent, CiAgentSurface, CiBulkUpdateResult, CiInstallation } from "@devdigest/shared";
import agentsMessages from "../../../../../../../../messages/en/agents.json";
import ciMessages from "../../../../../../../../messages/en/ci.json";

// ---- Mocks ------------------------------------------------------------------

let surface: CiAgentSurface | undefined;
let surfaceLoading = false;

const updateMutate = vi.fn();
// Wrapping the hook itself in a `vi.fn()` (not just its returned `mutate`)
// lets the AC-42 test assert the hook function was actually invoked — proof
// CITab calls the SAME `@/lib/hooks/agents` `useUpdateAgent` that
// ConfigTab.tsx uses, not a parallel reimplementation that merely happens to
// shape-match `{ mutate, isPending, isSuccess, data }`.
const useUpdateAgentSpy = vi.fn(() => ({
  mutate: updateMutate,
  isPending: false,
  isSuccess: false,
  data: undefined,
}));

const bulkUpdateMutate = vi.fn();
let bulkUpdateIsPending = false;
let bulkUpdateData: CiBulkUpdateResult | undefined;

const disconnectMutate = vi.fn();
let disconnectIsPending = false;

vi.mock("@/lib/hooks/agents", () => ({
  useUpdateAgent: () => useUpdateAgentSpy(),
}));

vi.mock("@/lib/hooks/ci", () => ({
  useCiSurface: () => ({ data: surface, isLoading: surfaceLoading }),
  useBulkUpdateCi: () => ({ mutate: bulkUpdateMutate, isPending: bulkUpdateIsPending, data: bulkUpdateData }),
  useDisconnectCi: () => ({ mutate: disconnectMutate, isPending: disconnectIsPending }),
  // Not exercised by these tests (ExportWizard's own suite covers them), but
  // CITab conditionally mounts ExportWizard, which imports these — provide
  // inert stubs so opening the wizard never crashes.
  useExportCiPreview: () => ({
    mutate: vi.fn(),
    isPending: false,
    isSuccess: false,
    isError: false,
    data: undefined,
    error: undefined,
  }),
  useExportCi: () => ({
    mutate: vi.fn(),
    isPending: false,
    isSuccess: false,
    isError: false,
    data: undefined,
    error: undefined,
  }),
}));

vi.mock("@/lib/hooks/core", () => ({
  useRepos: () => ({ data: [] }),
}));

import { CITab } from "./CITab";

function renderWithIntl(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ agents: agentsMessages, ci: ciMessages }}>
      {ui}
    </NextIntlClientProvider>,
  );
}

const AGENT: Agent = {
  id: "ag1",
  name: "Security Reviewer",
  description: "Flags secrets and injection",
  provider: "openai",
  model: "gpt-4.1",
  system_prompt: "You are a security reviewer.",
  output_schema: null,
  strategy: "single-pass",
  ci_fail_on: "critical",
  repo_intel: true,
  enabled: true,
  version: 1,
};

function makeInstallation(overrides: Partial<CiInstallation> = {}): CiInstallation {
  return {
    id: "inst1",
    agent_id: "ag1",
    repo: "acme/payments-api",
    target_type: "gha",
    installed_at: "2026-07-01T00:00:00.000Z",
    slug: "security-reviewer",
    workflow_version: 2,
    disconnected_at: null,
    triggers: ["opened", "synchronize"],
    post_as: "github_review",
    latest_run_status: "succeeded",
    latest_run_at: "2026-07-10T20:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  surface = undefined;
  surfaceLoading = false;
  bulkUpdateIsPending = false;
  bulkUpdateData = undefined;
  disconnectIsPending = false;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("CITab", () => {
  it("renders an installation row with repo, target, status, and workflow version", () => {
    surface = {
      installations: [makeInstallation()],
      active_count: 1,
      last_7_days: { runs: 4, findings: 9, cost_usd: 1.23 },
    };
    renderWithIntl(<CITab agent={AGENT} />);

    expect(screen.getByText("acme/payments-api")).toBeInTheDocument();
    expect(screen.getByText("GitHub Actions")).toBeInTheDocument();
    // The per-repo badge is DEPLOYMENT health ("Succeeded"), not the last review
    // run's outcome — its existence proves the export PR was created.
    expect(screen.getByText("Succeeded")).toBeInTheDocument();
    expect(screen.getByText("Active in 1 repos")).toBeInTheDocument();
  });

  it("hides disconnected installations from the active list (AC-14) but keeps active ones", () => {
    surface = {
      installations: [
        makeInstallation(),
        makeInstallation({
          id: "inst-gone",
          repo: "acme/legacy-service",
          disconnected_at: "2026-07-10T22:42:52.000Z",
        }),
      ],
      // active_count already excludes the disconnected one (server-computed).
      active_count: 1,
      last_7_days: { runs: 4, findings: 9, cost_usd: 1.23 },
    };
    renderWithIntl(<CITab agent={AGENT} />);

    expect(screen.getByText("acme/payments-api")).toBeInTheDocument();
    // A disconnected installation must NOT render as an active row — after
    // disconnect it drops out of the CI tab (its run history stays on the CI
    // Runs page). This guards the AC-14 regression where it lingered as a
    // full, still-disconnectable row.
    expect(screen.queryByText("acme/legacy-service")).not.toBeInTheDocument();
    expect(screen.getByText("Active in 1 repos")).toBeInTheDocument();
  });

  it("shows a green 'Succeeded' deployment badge even when the last review run failed (run outcomes live on CI Runs, not here)", () => {
    // Even when the most recent review run FAILED, the per-repo badge must stay
    // a green "Succeeded": the badge is deployment health (the export PR was
    // created — `upsertPublished` is the last step of `exportInstallation`),
    // never the run outcome. This guards the regression where a failed review
    // run made a correctly-installed repo look broken on the agent's CI tab.
    surface = {
      installations: [makeInstallation({ latest_run_status: "failed" })],
      active_count: 1,
      last_7_days: { runs: 1, findings: 0, cost_usd: null },
    };
    renderWithIntl(<CITab agent={AGENT} />);

    // No run-outcome badge ("Failed"/"Findings"/"No findings") is rendered here.
    expect(screen.queryByText("Failed")).not.toBeInTheDocument();
    // Badge sets `color` as its own inline style (see client/insights.md's
    // 2026-07-03/2026-07-06 entries on why `.style.color` is the reliable read).
    const badge = screen.getByText("Succeeded");
    expect(badge.style.color).toBe("var(--ok)");
  });

  it("shows the empty state when there are no installations", () => {
    surface = { installations: [], active_count: 0, last_7_days: { runs: 0, findings: 0, cost_usd: null } };
    renderWithIntl(<CITab agent={AGENT} />);

    expect(screen.getByText("Not connected to any repository yet.")).toBeInTheDocument();
    // No "Update CI config" button without at least one installation.
    expect(screen.queryByRole("button", { name: "Update CI config" })).not.toBeInTheDocument();
  });

  it("Fail CI on control calls the same useUpdateAgent mutation ConfigTab uses", () => {
    surface = { installations: [], active_count: 0, last_7_days: { runs: 0, findings: 0, cost_usd: null } };
    renderWithIntl(<CITab agent={AGENT} />);

    // The only `useUpdateAgent` this test file provides is the mocked
    // `@/lib/hooks/agents` export that ConfigTab.tsx also imports from —
    // asserting the spy fired proves CITab calls that identical shared hook,
    // not a local/parallel reimplementation (AC-42).
    expect(useUpdateAgentSpy).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(screen.getByRole("button", { name: "Block on any finding" }));

    expect(updateMutate).toHaveBeenCalledWith({ id: "ag1", patch: { ci_fail_on: "any" } });
  });

  it("Disconnect asks for confirmation and only calls useDisconnectCi when confirmed", () => {
    surface = {
      installations: [makeInstallation()],
      active_count: 1,
      last_7_days: { runs: 0, findings: 0, cost_usd: null },
    };
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderWithIntl(<CITab agent={AGENT} />);

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(confirmSpy).toHaveBeenCalled();
    expect(disconnectMutate).not.toHaveBeenCalled();

    confirmSpy.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(disconnectMutate).toHaveBeenCalledWith("inst1");
  });

  it("Update CI config calls useBulkUpdateCi and renders the per-installation outcome", () => {
    surface = {
      installations: [makeInstallation(), makeInstallation({ id: "inst2", repo: "acme/billing-worker" })],
      active_count: 2,
      last_7_days: { runs: 0, findings: 0, cost_usd: null },
    };
    renderWithIntl(<CITab agent={AGENT} />);

    fireEvent.click(screen.getByRole("button", { name: "Update CI config" }));
    expect(bulkUpdateMutate).toHaveBeenCalled();

    bulkUpdateData = {
      results: [
        { installation_id: "inst1", ok: true, pr_url: "https://github.com/acme/payments-api/pull/9", error: null },
        { installation_id: "inst2", ok: false, pr_url: null, error: "GitHub commit failed" },
      ],
    };
    renderWithIntl(<CITab agent={AGENT} />);
    expect(screen.getByText("1 of 2 installations updated")).toBeInTheDocument();
    expect(screen.getByText("GitHub commit failed")).toBeInTheDocument();
    // A succeeded installation links to the PR that carries the update (that PR
    // is what makes the new config actually land), not a dead-end "OK".
    const prLink = screen.getByRole("link", { name: "View PR" });
    expect(prLink).toHaveAttribute("href", "https://github.com/acme/payments-api/pull/9");
  });

  it("opens the Export Wizard modal when Add to CI is clicked", () => {
    surface = { installations: [], active_count: 0, last_7_days: { runs: 0, findings: 0, cost_usd: null } };
    renderWithIntl(<CITab agent={AGENT} />);

    fireEvent.click(screen.getByRole("button", { name: "Add to CI" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
