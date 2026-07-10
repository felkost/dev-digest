"use client";

import React from "react";
import JSZip from "jszip";
import type { Agent, CiExport, CiFile } from "@devdigest/shared";
import { ApiError } from "@/lib/api";
import { useRepos } from "@/lib/hooks/core";
import { useExportCi, useExportCiPreview } from "@/lib/hooks/ci";
import { WORKFLOW_PATH } from "./_steps/PreviewStep";
import type { PostAs } from "./_steps/ConfigureStep";

export type WizardStep = 0 | 1 | 2 | 3;

async function downloadArchive(files: CiFile[]) {
  const zip = new JSZip();
  for (const f of files) zip.file(f.path, f.contents);
  const blob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "devdigest-ci.zip";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * All Export Wizard state, effects, and mutation orchestration — colocated
 * with its single consumer (`ExportWizard.tsx`), which only composes the 4
 * step components + the footer from this hook's return value.
 *
 * Preview is fetched via the no-side-effect `POST .../ci/preview` endpoint on
 * entering the Preview step and again on every Configure change — UNLESS the
 * user has already hand-edited the workflow textarea (`workflowEdited`), in
 * which case no further preview call can ever overwrite it (AC-36 holds by
 * construction: the call site simply never fires once `workflowEdited` is
 * true). Install (`POST .../export-ci`) fires only from the last step, for
 * either action ("open_pr" | "files").
 */
export function useExportWizardFlow(agent: Agent) {
  const { data: repos } = useRepos();

  const [step, setStep] = React.useState<WizardStep>(0);
  const [repoId, setRepoId] = React.useState<string | null>(null);
  const [triggers, setTriggers] = React.useState<string[]>(["opened", "synchronize"]);
  // Matches CiExportPreviewInput/CiExportInput's own zod default.
  const [postAs, setPostAs] = React.useState<PostAs>("github_review");
  const [workflowEdited, setWorkflowEdited] = React.useState(false);
  const [workflowText, setWorkflowText] = React.useState("");
  const [pendingAction, setPendingAction] = React.useState<"open_pr" | "files" | null>(null);
  const [installResult, setInstallResult] = React.useState<(CiExport & { secret_value: string }) | null>(null);

  const preview = useExportCiPreview(repoId, agent.id);
  const exportCi = useExportCi(repoId, agent.id);

  // Auto-select the first connected repo once the list loads — the dropdown
  // never accepts free text, so this is already AC-1's "validated connected
  // repo" at the UI layer (the server independently re-validates the id).
  React.useEffect(() => {
    if (repoId == null && repos && repos.length > 0) setRepoId(repos[0]!.id);
  }, [repos, repoId]);

  // Sync the shown workflow text from a fresh preview response — unless the
  // user has already started editing it (AC-36: edits are sticky).
  React.useEffect(() => {
    if (preview.data && !workflowEdited) {
      const wf = preview.data.files.find((f) => f.path === WORKFLOW_PATH);
      if (wf) setWorkflowText(wf.contents);
    }
  }, [preview.data, workflowEdited]);

  const selectedRepo = (repos ?? []).find((r) => r.id === repoId) ?? null;

  const handleContinueFromTarget = () => {
    if (!repoId) return;
    setStep(1);
    preview.mutate({ triggers, post_as: postAs });
  };

  const refreshPreviewIfUnedited = (nextTriggers: string[], nextPostAs: PostAs) => {
    if (!workflowEdited) preview.mutate({ triggers: nextTriggers, post_as: nextPostAs });
  };

  const onTriggerToggle = (trig: string, checked: boolean) => {
    const next = checked ? [...triggers, trig] : triggers.filter((x) => x !== trig);
    setTriggers(next);
    refreshPreviewIfUnedited(next, postAs);
  };

  const onPostAsChange = (v: string) => {
    const next = v as PostAs;
    setPostAs(next);
    refreshPreviewIfUnedited(triggers, next);
  };

  const onWorkflowChange = (v: string) => {
    setWorkflowText(v);
    setWorkflowEdited(true);
  };

  const runInstall = (action: "open_pr" | "files") => {
    if (!selectedRepo) return;
    setPendingAction(action);
    exportCi.mutate(
      {
        target: "gha",
        action,
        post_as: postAs,
        triggers,
        base: selectedRepo.default_branch,
        repo: selectedRepo.full_name,
        workflow_override: workflowEdited ? workflowText : undefined,
      },
      {
        onSuccess: (data) => {
          setInstallResult(data);
          if (action === "files") void downloadArchive(data.files);
        },
        onSettled: () => setPendingAction(null),
      },
    );
  };

  const previewConflict = preview.isError
    ? preview.error instanceof ApiError
      ? preview.error.message
      : String(preview.error)
    : null;
  const installConflict = exportCi.isError
    ? exportCi.error instanceof ApiError
      ? exportCi.error.message
      : String(exportCi.error)
    : null;

  const continueDisabled = step === 0 ? !repoId : !preview.isSuccess;

  return {
    step,
    setStep,
    repos,
    repoId,
    setRepoId,
    triggers,
    postAs,
    workflowText,
    pendingAction,
    installResult,
    preview,
    selectedRepo,
    handleContinueFromTarget,
    onTriggerToggle,
    onPostAsChange,
    onWorkflowChange,
    runInstall,
    previewConflict,
    installConflict,
    continueDisabled,
  };
}
