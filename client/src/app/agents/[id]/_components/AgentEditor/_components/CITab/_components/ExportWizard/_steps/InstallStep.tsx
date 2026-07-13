"use client";

import type { useTranslations } from "next-intl";
import { Badge, Icon } from "@devdigest/ui";
import type { CiExport } from "@devdigest/shared";
import { s } from "../styles";

/** External help target for the "Need help?" link on the Install step. */
const SETUP_DOCS_URL = "https://docs.github.com/actions/security-guides/using-secrets-in-github-actions";

interface InstallStepProps {
  t: ReturnType<typeof useTranslations>;
  conflict: string | null;
  installResult: CiExport | null;
  repoLabel: string;
  fileCount: number;
}

export function InstallStep({ t, conflict, installResult, repoLabel, fileCount }: InstallStepProps) {
  return (
    <div style={s.stepBody}>
      {conflict && (
        <div role="alert" style={s.conflictBox}>
          {conflict}
        </div>
      )}
      {installResult ? (
        // Success view — just the opened PR link. The secret reminder lives in
        // the generated PR body (which the user reviews before merge), so the
        // wizard doesn't repeat it here. The secret VALUE is never echoed back.
        <div style={s.installResult}>
          {installResult.pr_url && (
            <div style={s.installResultRow}>
              <a href={installResult.pr_url} target="_blank" rel="noreferrer">
                {installResult.pr_url}
              </a>
            </div>
          )}
        </div>
      ) : (
        <>
          <div style={s.installChoicePrimary}>
            <div style={s.installChoiceHeader}>
              <Icon.GitPullRequest size={16} />
              {t("exportWizard.installCardTitle")}
              <Badge color="var(--accent-text)" bg="var(--accent-bg)" style={{ marginLeft: "auto" }}>
                {t("exportWizard.recommended")}
              </Badge>
            </div>
            <div style={s.installCardBody}>
              {t("exportWizard.installCardBody", { repo: repoLabel, count: fileCount })}
            </div>
          </div>

          <div style={s.installChoiceZip}>
            <span style={s.installZipTitle}>
              <Icon.Copy size={15} />
              {t("exportWizard.copyZipTitle")}
            </span>
            <span style={s.installZipHint}>{t("exportWizard.copyZipHint")}</span>
          </div>

          <div style={s.installDocs}>
            {t("exportWizard.installHelp")}{" "}
            <a href={SETUP_DOCS_URL} target="_blank" rel="noreferrer" style={s.installDocsLink}>
              {t("exportWizard.installDocsLink")}
            </a>
          </div>
        </>
      )}
    </div>
  );
}
