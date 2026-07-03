import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { OnboardingTourSection } from "@devdigest/shared";
import onboardingMessages from "../../../../../../../messages/en/onboarding.json";
import { FirstTasksSection } from "./FirstTasksSection";

afterEach(cleanup);

function section(tasks: OnboardingTourSection["tasks"]): OnboardingTourSection {
  return {
    kind: "first_tasks",
    title: "First tasks",
    body: "",
    diagram: null,
    entries: [],
    tasks,
    links: [],
  };
}

function renderWithIntl(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ onboarding: onboardingMessages }}>
      {ui}
    </NextIntlClientProvider>,
  );
}

describe("FirstTasksSection — complexity badge color-token traceability", () => {
  it("maps Low complexity to the --sugg token", () => {
    renderWithIntl(<FirstTasksSection section={section([{ title: "Fix typo", target_path: "README.md", complexity: "low" }])} />);
    const badge = screen.getByText("Low");
    expect(badge.style.color).toBe("var(--sugg)");
  });

  it("maps Medium complexity to the --warn token", () => {
    renderWithIntl(<FirstTasksSection section={section([{ title: "Add test", target_path: "src/x.ts", complexity: "medium" }])} />);
    const badge = screen.getByText("Medium");
    expect(badge.style.color).toBe("var(--warn)");
  });

  it("maps High complexity to the --crit token", () => {
    renderWithIntl(<FirstTasksSection section={section([{ title: "Refactor core", target_path: "src/core.ts", complexity: "high" }])} />);
    const badge = screen.getByText("High");
    expect(badge.style.color).toBe("var(--crit)");
  });

  it("renders title and target_path for each task card", () => {
    renderWithIntl(<FirstTasksSection section={section([{ title: "Fix typo", target_path: "README.md", complexity: "low" }])} />);
    expect(screen.getByText("Fix typo")).toBeInTheDocument();
    expect(screen.getByText("README.md")).toBeInTheDocument();
  });
});
