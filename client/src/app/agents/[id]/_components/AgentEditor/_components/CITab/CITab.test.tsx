import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { Agent, CiAgentSurface, CiBulkUpdateResult, CiInstallation } from "@devdigest/shared";
// Canonical status->icon/color map (CI Runs page) — imported directly rather
// than hardcoded, so this regression test fails the moment InstallationRow
// stops actually consuming it (e.g. reverts to a local copy that drifts),
// not just when a literal string happens to go stale.
import { STATUS_META } from "@/app/ci-runs/_components/CiRunsView/constants";
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
    expect(screen.getByText("Succeeded")).toBeInTheDocument();
    expect(screen.getByText("v2")).toBeInTheDocument();
    expect(screen.getByText("Active in 1 repos")).toBeInTheDocument();
  });

  it("gives a previously-drifted status (no_findings) the exact same color as CI Runs' canonical status map", () => {
    // no_findings is one of the 3 statuses whose old, independently-duplicated
    // STATUS_STYLE map in InstallationRow.tsx had already drifted from the CI
    // Runs page's STATUS_META (different icon AND different color) — this
    // guards that specific regression, not just "a badge renders".
    surface = {
      installations: [makeInstallation({ latest_run_status: "no_findings" })],
      active_count: 1,
      last_7_days: { runs: 0, findings: 0, cost_usd: null },
    };
    renderWithIntl(<CITab agent={AGENT} />);

    const meta = STATUS_META.no_findings!;
    const badge = screen.getByText("No findings");
    // The reworked row renders status as a dot badge (matching the reference),
    // so there is no icon svg to diff anymore — but the COLOR token is still
    // the canonical drift guard: no_findings is one of the 3 statuses whose old
    // duplicated map had drifted to a different color, and Badge sets `color` as
    // its own inline style (see client/insights.md's 2026-07-03/2026-07-06
    // entries on why `.style.color` is the reliable read), so this fails the
    // moment InstallationRow stops consuming STATUS_META's color.
    expect(badge.style.color).toBe(meta.color);
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
  });

  it("opens the Export Wizard modal when Add to CI is clicked", () => {
    surface = { installations: [], active_count: 0, last_7_days: { runs: 0, findings: 0, cost_usd: null } };
    renderWithIntl(<CITab agent={AGENT} />);

    fireEvent.click(screen.getByRole("button", { name: "Add to CI" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
