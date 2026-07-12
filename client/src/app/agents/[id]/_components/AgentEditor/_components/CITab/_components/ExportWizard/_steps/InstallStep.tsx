"use client";

import React from "react";
import type { useTranslations } from "next-intl";
import { Badge, Button, FormField, Icon } from "@devdigest/ui";
import type { CiExport } from "@devdigest/shared";
import { s } from "../styles";

/** External help target for the "Need help?" link on the Install step. */
const SETUP_DOCS_URL = "https://docs.github.com/actions/security-guides/using-secrets-in-github-actions";

interface InstallStepProps {
  t: ReturnType<typeof useTranslations>;
  conflict: string | null;
  installResult: (CiExport & { secret_value: string }) | null;
  repoLabel: string;
  fileCount: number;
}

export function InstallStep({ t, conflict, installResult, repoLabel, fileCount }: InstallStepProps) {
  // Copy-to-clipboard is purely local to this step's own secret display —
  // pushed down here rather than lifted to the wizard-level hook.
  const [copied, setCopied] = React.useState(false);
  const copySecret = () => {
    if (!installResult) return;
    void navigator.clipboard?.writeText(installResult.secret_value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div style={s.stepBody}>
      {conflict && (
        <div role="alert" style={s.conflictBox}>
          {conflict}
        </div>
      )}
      {installResult ? (
        <div style={s.installResult}>
          {installResult.pr_url && (
            <div style={s.installResultRow}>
              <a href={installResult.pr_url} target="_blank" rel="noreferrer">
                {installResult.pr_url}
              </a>
            </div>
          )}
          <FormField label={t("exportWizard.secretValueLabel")}>
            <div style={s.secretRow}>
              <code style={s.secretValue}>{installResult.secret_value}</code>
              <Button kind="secondary" size="sm" icon="Copy" onClick={copySecret}>
                {copied ? t("exportWizard.copied") : t("exportWizard.copySecret")}
              </Button>
            </div>
          </FormField>
          <div style={s.hint}>{t("exportWizard.secretNote", { key: "OPENROUTER_API_KEY" })}</div>
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

          <div style={s.hint}>{t("exportWizard.secretNote", { key: "OPENROUTER_API_KEY" })}</div>

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
