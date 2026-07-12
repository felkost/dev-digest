import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { Skill, SkillStats } from "@devdigest/shared";
import skillsMessages from "../../../../../messages/en/skills.json";

// ---- Mocks -----------------------------------------------------------------

let stats: SkillStats | undefined;

vi.mock("@/lib/hooks/skills", () => ({
  useSkillStats: () => ({ data: stats, isLoading: false }),
}));

import { StatsTab } from "./StatsTab";

function renderWithIntl(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ skills: skillsMessages }}>
      {ui}
    </NextIntlClientProvider>,
  );
}

const SKILL: Skill = {
  id: "sk1",
  name: "no-mock-overuse",
  description: "Flags overuse of mocks",
  type: "rubric",
  source: "manual",
  body: "# No mock overuse",
  enabled: true,
  version: 1,
} as unknown as Skill;

function makeStats(overrides: Partial<SkillStats> = {}): SkillStats {
  return {
    used_by: 3,
    pull_frequency_pct: 42,
    accept_rate_pct: 87,
    findings_30d: 12,
    agents: [{ id: "a1", name: "General Reviewer" }],
    findings_by_category: [],
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  stats = undefined;
});

describe("StatsTab — dollar-based donut chart (AC-20, AC-21)", () => {
  it("renders currency-formatted legend values and an Estimated badge next to the panel header", () => {
    stats = makeStats({
      findings_by_category: [
        { category: "security", estimated_cost_usd: 1.23 },
        { category: "style", estimated_cost_usd: 0.5 },
      ],
    });
    renderWithIntl(<StatsTab skill={SKILL} />);

    // Panel header shows the "Estimated" badge (the ONE new i18n string).
    const heading = screen.getByText("Findings by category");
    const panel = heading.closest("div")!.parentElement as HTMLElement;
    expect(within(panel).getByText("Estimated")).toBeInTheDocument();

    // Legend renders dollar amounts, not raw counts.
    expect(within(panel).getByText("$1.23")).toBeInTheDocument();
    expect(within(panel).getByText("$0.50")).toBeInTheDocument();
    expect(within(panel).getByText("security")).toBeInTheDocument();
    expect(within(panel).getByText("style")).toBeInTheDocument();

    // Real accept-rate value flows straight through (AC-22 — no client change needed).
    expect(screen.getByText("87")).toBeInTheDocument();
  });
});

describe("StatsTab — zero findings in 30d (AC-23)", () => {
  it("shows the unchanged 'No findings yet' empty state when there are no categories", () => {
    stats = makeStats({ findings_by_category: [] });
    renderWithIntl(<StatsTab skill={SKILL} />);

    expect(screen.getByText("No findings yet")).toBeInTheDocument();
  });
});

describe("StatsTab — all-zero-cost donut (total===0, non-empty data)", () => {
  it("renders a clean legend with $0.00 rows and no broken donut arcs when every known cost is exactly $0.00", () => {
    stats = makeStats({
      findings_by_category: [
        { category: "security", estimated_cost_usd: 0 },
        { category: "style", estimated_cost_usd: 0 },
      ],
    });
    renderWithIntl(<StatsTab skill={SKILL} />);

    const heading = screen.getByText("Findings by category");
    const panel = heading.closest("div")!.parentElement as HTMLElement;

    // Legend renders cleanly — both categories show $0.00 (a KNOWN zero cost,
    // distinct from the null/unavailable "—" case above) instead of the
    // previous NaN-driven broken SVG.
    expect(within(panel).getAllByText("$0.00")).toHaveLength(2);
    expect(within(panel).getByText("security")).toBeInTheDocument();
    expect(within(panel).getByText("style")).toBeInTheDocument();

    // No arc path is emitted inside the donut's own SVG (sweep guarded to 0
    // when total===0) — no NaN ever reaches the `d` attribute. Scope to the
    // 120x120 donut svg specifically; the panel also contains unrelated
    // icon <path>s (header Tag icon, Estimated-badge Info icon).
    const donutSvg = panel.querySelector('svg[width="120"]')!;
    expect(donutSvg.querySelectorAll("path")).toHaveLength(0);
  });
});

describe("StatsTab — null estimated_cost_usd category (AC-28)", () => {
  it("keeps a null-cost category in the legend as unavailable instead of dropping it", () => {
    stats = makeStats({
      findings_by_category: [
        { category: "security", estimated_cost_usd: 2 },
        { category: "unattributed", estimated_cost_usd: null },
      ],
    });
    renderWithIntl(<StatsTab skill={SKILL} />);

    const heading = screen.getByText("Findings by category");
    const panel = heading.closest("div")!.parentElement as HTMLElement;

    // The null category is still listed — never silently vanished.
    expect(within(panel).getByText("unattributed")).toBeInTheDocument();
    expect(within(panel).getByText("—")).toBeInTheDocument();
    // The priced category still renders normally alongside it.
    expect(within(panel).getByText("security")).toBeInTheDocument();
    expect(within(panel).getByText("$2.00")).toBeInTheDocument();
  });
});
