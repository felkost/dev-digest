import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { EvalCaseListItem } from "@devdigest/shared";
import agentsMessages from "../../../../../../../../../../messages/en/agents.json";
import { ApiError } from "@/lib/api";

// ---- Mocks -----------------------------------------------------------------

const createCaseMutate = vi.fn();
let createCaseIsPending = false;
const updateCaseMutate = vi.fn();
let updateCaseIsPending = false;

vi.mock("@/lib/hooks/eval", () => ({
  useCreateEvalCase: () => ({ mutate: createCaseMutate, isPending: createCaseIsPending }),
  useUpdateEvalCase: () => ({ mutate: updateCaseMutate, isPending: updateCaseIsPending }),
}));

import { CaseEditor } from "./CaseEditor";

function renderWithIntl(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ agents: agentsMessages }}>
      {ui}
    </NextIntlClientProvider>,
  );
}

const EXISTING_CASE: EvalCaseListItem = {
  id: "case-existing",
  owner_id: "ag1",
  name: "Existing case",
  source: "manual",
  source_finding_id: null,
  source_pr_number: null,
  input_diff: "@@ -1,2 +1,2 @@\n-old\n+new",
  expected_output: [{ type: "must_find", file: "a.ts", line_start: 1, line_end: 2 }],
  last_run_status: "never_run",
  last_run_summary: null,
  notes: "existing notes",
};

afterEach(() => {
  cleanup();
  createCaseMutate.mockClear();
  createCaseIsPending = false;
  updateCaseMutate.mockClear();
  updateCaseIsPending = false;
});

describe("CaseEditor — save validation error surfacing (AC-7/AC-8)", () => {
  it("surfaces the server's validation error inline on save failure, without closing the editor", async () => {
    const onClose = vi.fn();
    createCaseMutate.mockImplementation((_input, opts) => {
      opts?.onError?.(new ApiError("Diff fragment must reference at least one file", 400));
    });
    const user = userEvent.setup();
    renderWithIntl(<CaseEditor agentId="ag1" onClose={onClose} />);

    await user.type(screen.getByPlaceholderText("Paste a unified diff fragment…"), "not a real diff");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(screen.getByRole("alert")).toHaveTextContent("Diff fragment must reference at least one file");
    // Editor must stay open on failure.
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("closes the editor on successful save", async () => {
    const onClose = vi.fn();
    createCaseMutate.mockImplementation((_input, opts) => {
      opts?.onSuccess?.();
    });
    const user = userEvent.setup();
    renderWithIntl(<CaseEditor agentId="ag1" onClose={onClose} />);

    await user.type(screen.getByPlaceholderText("Paste a unified diff fragment…"), "@@ -1,2 +1,2 @@\n-a\n+b");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows a client-side pre-check message when the diff fragment is empty, without calling the mutation", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderWithIntl(<CaseEditor agentId="ag1" onClose={onClose} />);

    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(createCaseMutate).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});

describe("CaseEditor — edit mode (edit-in-place)", () => {
  it("pre-fills the diff and notes from initialCase, and Save calls update (not create) with the case's id", async () => {
    const onClose = vi.fn();
    updateCaseMutate.mockImplementation((_input, opts) => {
      opts?.onSuccess?.();
    });
    const user = userEvent.setup();
    renderWithIntl(<CaseEditor agentId="ag1" initialCase={EXISTING_CASE} onClose={onClose} />);

    // Pre-filled from initialCase.
    expect(screen.getByDisplayValue("Existing case")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Paste a unified diff fragment…")).toHaveValue(EXISTING_CASE.input_diff);
    expect(screen.getByDisplayValue("existing notes")).toBeInTheDocument();
    expect(screen.getByText("Edit eval case")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(createCaseMutate).not.toHaveBeenCalled();
    expect(updateCaseMutate).toHaveBeenCalledOnce();
    const [arg] = updateCaseMutate.mock.calls[0] as [{ caseId: string; input: Record<string, unknown> }, unknown];
    expect(arg.caseId).toBe("case-existing");
    expect(arg.input).toMatchObject({ name: "Existing case", input_diff: EXISTING_CASE.input_diff, notes: "existing notes" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("surfaces the server's validation error inline on the update path too, without closing the editor", async () => {
    const onClose = vi.fn();
    updateCaseMutate.mockImplementation((_input, opts) => {
      opts?.onError?.(new ApiError("Diff fragment must reference at least one file", 422));
    });
    const user = userEvent.setup();
    renderWithIntl(<CaseEditor agentId="ag1" initialCase={EXISTING_CASE} onClose={onClose} />);

    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(screen.getByRole("alert")).toHaveTextContent("Diff fragment must reference at least one file");
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("CaseEditor — expectation-type select is interactive (regression)", () => {
  // Guards against re-wrapping the custom SelectInput in a <label>: a click would
  // synthetically re-fire on the first dropdown <button> (React flushes the
  // open-state re-render synchronously mid-click for discrete events), silently
  // selecting option[0] ("must find") and closing the list before it can be seen.
  it("opens the dropdown on click without hijacking the value to the first option", async () => {
    const user = userEvent.setup();
    renderWithIntl(
      <CaseEditor
        agentId="ag1"
        initialCase={{
          ...EXISTING_CASE,
          expected_output: [{ type: "must_not_flag", file: "a.ts", line_start: 1, line_end: 2 }],
        }}
        onClose={vi.fn()}
      />,
    );

    const trigger = screen.getByRole("combobox");
    expect(trigger).toHaveTextContent("must not flag");

    await user.click(trigger);

    // The dropdown actually opened (the other option is now a clickable button)…
    const mustFindOption = screen.getByRole("button", { name: "must find" });
    expect(mustFindOption).toBeInTheDocument();
    // …and the click did NOT silently flip the value to option[0].
    expect(trigger).toHaveTextContent("must not flag");

    // Explicitly picking the other option updates the value.
    await user.click(mustFindOption);
    expect(screen.getByRole("combobox")).toHaveTextContent("must find");
  });
});
