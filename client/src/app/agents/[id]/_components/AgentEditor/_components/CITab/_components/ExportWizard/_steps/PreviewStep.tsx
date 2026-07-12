"use client";

import React from "react";
import type { useTranslations } from "next-intl";
import { Badge, Icon, Textarea } from "@devdigest/ui";
import type { CiFile } from "@devdigest/shared";
import { s } from "../styles";

export const WORKFLOW_PATH = ".github/workflows/devdigest-review.yml";
const RUNNER_PREFIX = ".devdigest/runner/";

interface PreviewStepProps {
  t: ReturnType<typeof useTranslations>;
  isPending: boolean;
  isSuccess: boolean;
  conflict: string | null;
  files: CiFile[];
  workflowText: string;
  onWorkflowChange: (v: string) => void;
}

export function PreviewStep({ t, isPending, isSuccess, conflict, files, workflowText, onWorkflowChange }: PreviewStepProps) {
  const visibleFiles = files.filter((f) => !f.path.startsWith(RUNNER_PREFIX));
  // Default the viewer to the workflow file (the one editable file) — matches
  // the reference, where it opens pre-selected, and keeps the editable textarea
  // in view without an extra click.
  const workflowIdx = Math.max(0, visibleFiles.findIndex((f) => f.path === WORKFLOW_PATH));
  const [selected, setSelected] = React.useState<number | null>(null);
  // Clamp instead of an effect: a re-preview may return fewer files, so the
  // previously selected index could fall out of range — clamping keeps the
  // viewer valid without a reset-on-change effect.
  const sel = Math.min(selected ?? workflowIdx, Math.max(0, visibleFiles.length - 1));
  const active = visibleFiles[sel];

  return (
    <div style={s.stepBody}>
      {isPending && <div style={s.hint}>{t("exportWizard.generating")}</div>}
      {conflict && (
        <div role="alert" style={s.conflictBox}>
          {conflict}
        </div>
      )}
      {isSuccess && active && (
        <div style={s.previewGrid}>
          <div style={s.previewList}>
            <div style={s.filesToCreate}>{t("exportWizard.filesToCreate")}</div>
            {visibleFiles.map((f, i) => (
              <button
                key={f.path}
                type="button"
                onClick={() => setSelected(i)}
                style={{ ...s.previewListItem, ...(i === sel ? s.previewListItemActive : {}) }}
              >
                <Icon.FileText size={13} style={{ flexShrink: 0, marginTop: 1 }} />
                <span style={s.previewListPath}>{f.path}</span>
              </button>
            ))}
          </div>
          <div style={s.previewViewer}>
            <div style={s.previewViewerHeader}>
              <span style={s.filePath}>{active.path}</span>
              {active.path === WORKFLOW_PATH && <Badge>{t("exportWizard.editable")}</Badge>}
            </div>
            {active.path === WORKFLOW_PATH ? (
              <Textarea value={workflowText} onChange={onWorkflowChange} rows={14} mono />
            ) : (
              <pre style={s.readonlyFile}>{active.contents || " "}</pre>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
