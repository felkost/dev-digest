/**
 * DisagreementSection — covers AC-32 (omitted below the 2-done threshold)
 * and AC-31 ("Show only conflicts" toggling the already-fetched `conflicts`
 * array in place, no new fetch — there is nothing to mock a fetch with here,
 * this component takes `conflicts` purely as a prop).
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { Conflict } from "@devdigest/shared";
import messages from "../../../../../../../../messages/en/multi-agent-review.json";
import { DisagreementSection } from "./DisagreementSection";

afterEach(cleanup);

function renderWithIntl(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ "multi-agent-review": messages }}>
      {ui}
    </NextIntlClientProvider>,
  );
}

const AGREEMENT: Conflict = {
  file: "src/a.ts",
  line: 10,
  title: "Agreed finding",
  takes: [
    { agent_id: "a1", persona: "Security", verdict: "WARNING", note: "n1" },
    { agent_id: "a2", persona: "Perf", verdict: "WARNING", note: "n2" },
  ],
};

const DISAGREEMENT: Conflict = {
  file: "src/b.ts",
  line: 20,
  title: "Disputed finding",
  takes: [
    { agent_id: "a1", persona: "Security", verdict: "CRITICAL", note: "flagged" },
    { agent_id: "a2", persona: "Perf", verdict: "ignored", note: "" },
  ],
};

describe("DisagreementSection", () => {
  it("is omitted entirely when fewer than 2 columns are done (AC-32)", () => {
    renderWithIntl(<DisagreementSection conflicts={[AGREEMENT, DISAGREEMENT]} doneCount={1} />);
    expect(screen.queryByText("Where agents disagree")).not.toBeInTheDocument();
    expect(screen.queryByText("Disputed finding")).not.toBeInTheDocument();
  });

  it("renders once at least 2 columns are done", () => {
    renderWithIntl(<DisagreementSection conflicts={[DISAGREEMENT]} doneCount={2} />);
    expect(screen.getByText("Where agents disagree")).toBeInTheDocument();
  });

  it("defaults to showing only disagreements, excluding full-agreement locations (AC-29/30/31)", () => {
    renderWithIntl(<DisagreementSection conflicts={[AGREEMENT, DISAGREEMENT]} doneCount={2} />);
    expect(screen.getByText("Disputed finding")).toBeInTheDocument();
    expect(screen.queryByText("Agreed finding")).not.toBeInTheDocument();
    expect(screen.getByText("did not flag")).toBeInTheDocument();
  });

  it("toggling 'Show only conflicts' off reveals agreement locations too, from the same already-fetched array (AC-31)", async () => {
    const user = userEvent.setup();
    renderWithIntl(<DisagreementSection conflicts={[AGREEMENT, DISAGREEMENT]} doneCount={2} />);
    expect(screen.queryByText("Agreed finding")).not.toBeInTheDocument();

    await user.click(screen.getByRole("switch"));

    expect(screen.getByText("Agreed finding")).toBeInTheDocument();
    expect(screen.getByText("Disputed finding")).toBeInTheDocument();
  });
});
