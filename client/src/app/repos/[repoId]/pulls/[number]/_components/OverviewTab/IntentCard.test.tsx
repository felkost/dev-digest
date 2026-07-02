/**
 * IntentCard tests — design conformance:
 * scope column headers (✓ IN SCOPE / ✕ OUT OF SCOPE), middot bullets per item,
 * optional RISK AREAS chip section (rendered only when risks are provided).
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { Intent, Risks } from "@devdigest/shared";
import briefMessages from "../../../../../../../../messages/en/brief.json";
import { IntentCard } from "./IntentCard";

afterEach(cleanup);

const INTENT: Intent = {
  intent: "Add rate limiting to public API endpoints to prevent abuse.",
  in_scope: ["Add middleware for rate limiting", "Apply to /api/public/* routes"],
  out_of_scope: ["Authentication changes"],
};

const RISKS: Risks = {
  risks: [
    {
      kind: "security",
      title: "Auth surface touched",
      explanation: "Middleware runs before auth.",
      severity: "high",
      file_refs: [],
    },
    {
      kind: "dependency",
      title: "New dependency: ioredis",
      explanation: "Adds a runtime dependency.",
      severity: "medium",
      file_refs: [],
    },
  ],
};

function renderCard(risks?: Risks | null) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ brief: briefMessages }}>
      <IntentCard intent={INTENT} risks={risks} />
    </NextIntlClientProvider>,
  );
}

describe("IntentCard", () => {
  it("renders the quote and scope column headers", () => {
    renderCard();
    expect(screen.getByText(/Add rate limiting to public API endpoints/)).toBeTruthy();
    expect(screen.getByText("In scope")).toBeTruthy();
    expect(screen.getByText("Out of scope")).toBeTruthy();
  });

  it("renders scope items with middot bullets, not per-item icons", () => {
    renderCard();
    expect(screen.getByText("Add middleware for rate limiting")).toBeTruthy();
    expect(screen.getByText("Authentication changes")).toBeTruthy();
    // one middot bullet per scope item (2 in-scope + 1 out-of-scope)
    expect(screen.getAllByText("·")).toHaveLength(3);
  });

  it("renders RISK AREAS chips when risks are provided", () => {
    renderCard(RISKS);
    expect(screen.getByText("Risk areas")).toBeTruthy();
    expect(screen.getByText("Auth surface touched")).toBeTruthy();
    expect(screen.getByText("New dependency: ioredis")).toBeTruthy();
  });

  it("hides the RISK AREAS section when risks are absent or empty", () => {
    renderCard(null);
    expect(screen.queryByText("Risk areas")).toBeNull();

    cleanup();
    renderCard({ risks: [] });
    expect(screen.queryByText("Risk areas")).toBeNull();
  });
});
