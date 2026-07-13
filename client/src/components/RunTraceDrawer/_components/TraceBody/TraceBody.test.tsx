import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { RunTrace, FindingRecord } from "@devdigest/shared";
import messages from "../../../../../messages/en/runs.json"; // apps/web/messages/en/runs.json

import { TraceBody } from "./TraceBody";

afterEach(cleanup);

const BASE_TRACE: RunTrace = {
  config: { agent: "Security", version: "1", provider: "openai", model: "gpt-4.1", pr: 482, source: "local" },
  stats: { duration_ms: 8200, tokens_in: 12000, tokens_out: 1500, findings: 2, grounding: "2/2 passed", cost_usd: 0.0042 },
  prompt_assembly: { system: "You are a reviewer.", skills: "### skill", memory: null, specs: "spec-0 text", user: "Review PR #482" },
  tool_calls: [],
  raw_output: '{"verdict":"request_changes"}',
  memory_pulled: [],
  specs_read: [],
  context_documents: [
    { path: "specs/invariants.md", token_size: 128, status: "injected", skip_reason: null },
    { path: "docs/removed.md", token_size: 0, status: "skipped", skip_reason: "file not found in clone" },
  ],
  log: [],
};

const FINDINGS: FindingRecord[] = [];

function renderWithIntl(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ runs: messages }}>
      {ui}
    </NextIntlClientProvider>,
  );
}

describe("TraceBody — context documents section (AC-15, AC-16)", () => {
  it("renders both an injected and a skipped context document, with the skip reason visible", () => {
    renderWithIntl(<TraceBody trace={BASE_TRACE} findings={FINDINGS} />);

    // Injected document: path + token count + injected badge.
    expect(screen.getByText("specs/invariants.md")).toBeInTheDocument();
    expect(screen.getByText("128 tokens")).toBeInTheDocument();
    expect(screen.getByText("injected")).toBeInTheDocument();

    // Skipped document: path + skip reason + skipped badge.
    expect(screen.getByText("docs/removed.md")).toBeInTheDocument();
    expect(screen.getByText("file not found in clone")).toBeInTheDocument();
    expect(screen.getByText("skipped")).toBeInTheDocument();

    // "open full text" affordance (AC-15) — hint pointing at the Prompt
    // assembly section, since at least one doc was injected.
    expect(
      screen.getByText(/Open the Prompt assembly section below/i),
    ).toBeInTheDocument();
  });

  it("shows the empty state and no open-full-text hint when no documents were attached to the run", () => {
    const trace: RunTrace = { ...BASE_TRACE, context_documents: [] };
    renderWithIntl(<TraceBody trace={trace} findings={FINDINGS} />);

    expect(
      screen.getByText("No project context documents were attached to this run."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Open the Prompt assembly section below/i)).not.toBeInTheDocument();
  });
});

describe("TraceBody — cost breakdown section (per-block tokens, cache, boilerplate, map-reduce)", () => {
  it("shows the unavailable message when cost_report is absent (a pre-cost-surgery run) — never a fabricated 0", () => {
    renderWithIntl(<TraceBody trace={BASE_TRACE} findings={FINDINGS} />);

    expect(
      screen.getByText(
        "Cost breakdown unavailable for this run (predates cost-surgery instrumentation).",
      ),
    ).toBeInTheDocument();
  });

  it("renders per-block tokens (biggest first), cache info, boilerplate exclusion, and map-reduce chunks when cost_report is present", () => {
    const trace: RunTrace = {
      ...BASE_TRACE,
      cost_report: {
        block_token_counts: [
          { block: "system", tokens: 400 },
          { block: "user", tokens: 9000 },
          { block: "specs", tokens: "unavailable" },
        ],
        cached_input_tokens: 3500,
        cache_control_applied: true,
        excluded_boilerplate_files: ["pnpm-lock.yaml", "dist/bundle.js"],
        excluded_boilerplate_tokens: 842,
        map_reduce_threshold_tokens: 12000,
        map_reduce_chunk_count: 3,
      },
    };
    renderWithIntl(<TraceBody trace={trace} findings={FINDINGS} />);

    // Per-block tokens: labels reuse the Prompt assembly vocabulary, and the
    // biggest block (the diff, mapped to "user") renders first in the DOM.
    const blockLabels = screen.getAllByText(/^(System|User \/ diff \(dynamic\)|Project context \(dynamic\))$/);
    expect(blockLabels[0]).toHaveTextContent("User / diff (dynamic)");
    expect(screen.getByText("9000 tokens")).toBeInTheDocument();
    expect(screen.getByText("400 tokens")).toBeInTheDocument();
    // The 'unavailable' block shows "—", never a fabricated 0.
    expect(screen.getByText("—")).toBeInTheDocument();

    // Cache.
    expect(screen.getByText("3500 tokens")).toBeInTheDocument();
    expect(screen.getByText("Yes")).toBeInTheDocument();

    // Boilerplate exclusion — the same "excluded N files, -X tokens" story
    // the server already logs (run-executor.ts).
    expect(screen.getByText(/2 files excluded/)).toBeInTheDocument();
    expect(screen.getByText(/−842 tokens/)).toBeInTheDocument();
    expect(screen.getByText("pnpm-lock.yaml")).toBeInTheDocument();
    expect(screen.getByText("dist/bundle.js")).toBeInTheDocument();

    // Map-reduce.
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("12000 tokens")).toBeInTheDocument();
  });

  it("shows 'single-pass' when map_reduce_chunk_count is 1, not an empty chunk table", () => {
    const trace: RunTrace = {
      ...BASE_TRACE,
      cost_report: {
        block_token_counts: [],
        cached_input_tokens: null,
        cache_control_applied: false,
        excluded_boilerplate_files: [],
        excluded_boilerplate_tokens: 0,
        map_reduce_threshold_tokens: null,
        map_reduce_chunk_count: 1,
      },
    };
    renderWithIntl(<TraceBody trace={trace} findings={FINDINGS} />);

    expect(screen.getByText("Single-pass — no map-reduce for this run.")).toBeInTheDocument();
    expect(screen.getByText("No boilerplate files excluded from this run.")).toBeInTheDocument();
  });
});
