import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { Agent, CiExportPreview, CiFile, Repo } from "@devdigest/shared";
import { ApiError } from "@/lib/api";
import ciMessages from "../../../../../../../../../../messages/en/ci.json";

// ---- Fixtures ----------------------------------------------------------------

const WORKFLOW_PATH = ".github/workflows/devdigest-review.yml";
const WORKFLOW_CONTENTS = "name: DevDigest Review\non: pull_request\n";

function defaultFiles(): CiFile[] {
  return [
    { path: ".devdigest/agents/security-reviewer.yaml", contents: "name: Security Reviewer\n", editable: false },
    { path: ".devdigest/memory.jsonl", contents: "", editable: false },
    { path: WORKFLOW_PATH, contents: WORKFLOW_CONTENTS, editable: true },
    { path: ".devdigest/runner/index.js", contents: "// bundle contents\n", editable: false },
  ];
}

// default_branch is deliberately NOT "main" — regression coverage for the bug
// where the wizard sent a hardcoded `base: "main"` regardless of the
// selected repo's real default branch (server-side branch creation 404s for
// any repo whose default branch differs, e.g. "develop"/"master").
const REPOS: Repo[] = [
  {
    id: "repo1",
    workspace_id: "ws1",
    owner: "acme",
    name: "payments-api",
    full_name: "acme/payments-api",
    default_branch: "develop",
    clone_path: null,
    last_polled_at: null,
    created_by: null,
  },
];

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

// ---- Mocks ---------------------------------------------------------------

type PreviewState = {
  isPending: boolean;
  isSuccess: boolean;
  isError: boolean;
  data?: CiExportPreview;
  error?: unknown;
};
let previewState: PreviewState = { isPending: false, isSuccess: false, isError: false };
/** Controls what the next `previewMutate()` call resolves to. Reset in beforeEach. */
let previewBehavior: "success" | "conflict" = "success";

const previewMutate = vi.fn(() => {
  if (previewBehavior === "conflict") {
    previewState = {
      isPending: false,
      isSuccess: false,
      isError: true,
      error: new ApiError(
        'acme/payments-api already has DevDigest installed for the "Security Reviewer" agent. ' +
          "Disconnect it from this repository first, or choose another repository.",
        409,
      ),
    };
  } else {
    previewState = { isPending: false, isSuccess: true, isError: false, data: { files: defaultFiles() } };
  }
});

const exportMutate = vi.fn(
  (_input: unknown, opts?: { onSuccess?: (d: unknown) => void; onSettled?: () => void }) => {
    // Only reset the in-flight flag — do NOT call onSuccess here, so the real
    // download/PR-result rendering path (and its jszip/Blob usage) never runs
    // in this suite; these tests only assert on the call arguments.
    opts?.onSettled?.();
  },
);

vi.mock("@/lib/hooks/ci", () => ({
  useExportCiPreview: () => ({ mutate: previewMutate, ...previewState }),
  useExportCi: () => ({ mutate: exportMutate, isPending: false, isSuccess: false, isError: false }),
}));

vi.mock("@/lib/hooks/core", () => ({
  useRepos: () => ({ data: REPOS }),
}));

import { ExportWizard } from "./ExportWizard";

function renderWithIntl(ui: React.ReactElement) {
  return render(<NextIntlClientProvider locale="en" messages={{ ci: ciMessages }}>{ui}</NextIntlClientProvider>);
}

beforeEach(() => {
  previewState = { isPending: false, isSuccess: false, isError: false };
  previewBehavior = "success";
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ExportWizard", () => {
  it("Target step: only GitHub Actions is a selectable target", () => {
    renderWithIntl(<ExportWizard agent={AGENT} onClose={vi.fn()} />);

    expect(screen.getByRole("button", { name: /GitHub Actions/ })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: /CircleCI/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Jenkins/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Generic CLI/ })).toBeDisabled();

    // Disabled targets are also non-advancing: clicking them never triggers a
    // preview fetch or moves the wizard off the Target step (AC-33) — native
    // `disabled` buttons don't invoke their (non-existent, here) click handler.
    fireEvent.click(screen.getByRole("button", { name: /CircleCI/ }));
    fireEvent.click(screen.getByRole("button", { name: /Jenkins/ }));
    fireEvent.click(screen.getByRole("button", { name: /Generic CLI/ }));
    expect(previewMutate).not.toHaveBeenCalled();
    expect(screen.getByText("Target repository")).toBeInTheDocument();
  });

  it("Preview step: lists the memory file even though empty, and never lists the runner bundle", () => {
    renderWithIntl(<ExportWizard agent={AGENT} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(previewMutate).toHaveBeenCalledTimes(1);
    expect(screen.getByText(".devdigest/memory.jsonl")).toBeInTheDocument();
    expect(screen.queryByText(".devdigest/runner/index.js")).not.toBeInTheDocument();
  });

  it("Preview step: a 409 conflict renders inline and blocks advancing", () => {
    previewBehavior = "conflict";
    renderWithIntl(<ExportWizard agent={AGENT} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByText(/already has DevDigest installed/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();

    // The disabled Continue button can't move the wizard forward — Configure
    // and Install are never reached from a blocked Preview (AC-13).
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.queryByText("Trigger")).not.toBeInTheDocument();
    expect(screen.queryByText("Open a PR with these files")).not.toBeInTheDocument();
    expect(screen.getByText(/already has DevDigest installed/)).toBeInTheDocument();
  });

  it("an edited workflow textarea survives a Configure change, and preview is not re-called", () => {
    renderWithIntl(<ExportWizard agent={AGENT} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" })); // Target -> Preview
    expect(previewMutate).toHaveBeenCalledTimes(1);

    const textarea = screen.getByRole("textbox");
    expect(textarea).toHaveValue(WORKFLOW_CONTENTS);
    fireEvent.change(textarea, { target: { value: "name: Edited Workflow\n" } });
    expect(textarea).toHaveValue("name: Edited Workflow\n");

    fireEvent.click(screen.getByRole("button", { name: "Continue" })); // Preview -> Configure
    fireEvent.click(screen.getByRole("button", { name: /pull_request:opened/ })); // toggle a trigger pill

    expect(previewMutate).toHaveBeenCalledTimes(1); // no re-fetch after the edit

    // The other Configure control (post-as radio group) goes through a separate
    // handler (`onPostAsChange`) that shares the same sticky guard — verify
    // that code path too, not just the trigger pill's.
    fireEvent.click(screen.getByRole("radio", { name: /PR comment/ }));
    expect(previewMutate).toHaveBeenCalledTimes(1); // still no re-fetch

    fireEvent.click(screen.getByRole("button", { name: "Back" })); // Configure -> Preview
    expect(screen.getByRole("textbox")).toHaveValue("name: Edited Workflow\n");
  });

  it("Install step: both buttons call useExportCi with the same params, differing only by action", () => {
    renderWithIntl(<ExportWizard agent={AGENT} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" })); // -> Preview
    fireEvent.click(screen.getByRole("button", { name: "Continue" })); // -> Configure
    fireEvent.click(screen.getByRole("button", { name: "Continue" })); // -> Install

    fireEvent.click(screen.getByRole("button", { name: /Download files/ }));
    fireEvent.click(screen.getByRole("button", { name: "Install" }));

    expect(exportMutate).toHaveBeenCalledTimes(2);
    const [filesArgs] = exportMutate.mock.calls[0]! as [Record<string, unknown>];
    const [installArgs] = exportMutate.mock.calls[1]! as [Record<string, unknown>];

    expect(filesArgs.action).toBe("files");
    expect(installArgs.action).toBe("open_pr");
    expect(filesArgs.repo).toBe("acme/payments-api");
    expect(filesArgs.repo).toBe(installArgs.repo);
    expect(filesArgs.triggers).toEqual(installArgs.triggers);
    expect(filesArgs.post_as).toBe(installArgs.post_as);

    // Regression: `base` must come from the selected repo's real
    // `default_branch` (here "develop"), never a hardcoded "main".
    expect(filesArgs.base).toBe("develop");
    expect(installArgs.base).toBe("develop");
  });

  it("Install step: a successful open_pr export shows the PR link but NEVER the OpenRouter secret", () => {
    // Regression guard against the credential leak: the Install step must show
    // the opened PR link + the secret's NAME only, never its VALUE. The mock
    // response even includes a hostile `secret_value` (which the real server no
    // longer returns) to prove the UI ignores it outright. Runs onSuccess for
    // the "open_pr" action only — "files" triggers `downloadArchive`, which
    // needs jsdom's missing `URL.createObjectURL` (client/insights.md, 2026-07-10).
    exportMutate.mockImplementationOnce(
      (_input: unknown, opts?: { onSuccess?: (d: unknown) => void; onSettled?: () => void }) => {
        opts?.onSuccess?.({
          installation: {
            id: "inst1",
            agent_id: "ag1",
            repo: "acme/payments-api",
            target_type: "gha",
            installed_at: "2026-07-10T00:00:00.000Z",
            slug: "security-reviewer",
            workflow_version: 1,
            disconnected_at: null,
            triggers: ["opened", "synchronize"],
            post_as: "github_review",
            latest_run_status: null,
          },
          files: defaultFiles(),
          pr_url: "https://github.com/acme/payments-api/pull/12",
          // Hostile field — the real server never sends this; the UI must ignore it.
          secret_value: "sk-or-v1-abc123",
        });
        opts?.onSettled?.();
      },
    );

    renderWithIntl(<ExportWizard agent={AGENT} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" })); // -> Preview
    fireEvent.click(screen.getByRole("button", { name: "Continue" })); // -> Configure
    fireEvent.click(screen.getByRole("button", { name: "Continue" })); // -> Install
    fireEvent.click(screen.getByRole("button", { name: "Install" }));

    expect(screen.getByText("https://github.com/acme/payments-api/pull/12")).toBeInTheDocument();
    // The secret value must not reach the DOM, and no copy-secret affordance exists.
    expect(screen.queryByText("sk-or-v1-abc123")).not.toBeInTheDocument();
    expect(screen.queryByText("Secret value")).not.toBeInTheDocument();
  });
});
