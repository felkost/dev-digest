"use client";

import type { useTranslations } from "next-intl";
import { Button } from "@devdigest/ui";
import { s } from "./styles";

interface WizardFooterProps {
  t: ReturnType<typeof useTranslations>;
  step: number;
  /** Whether the "Continue" button (steps 0-2) should be disabled — the
      parent computes this per-step (repo picked vs. preview succeeded). */
  continueDisabled: boolean;
  pendingAction: "open_pr" | "files" | null;
  onBack: () => void;
  onContinue: () => void;
  onDownloadFiles: () => void;
  onInstall: () => void;
}

export function WizardFooter({
  t,
  step,
  continueDisabled,
  pendingAction,
  onBack,
  onContinue,
  onDownloadFiles,
  onInstall,
}: WizardFooterProps) {
  return (
    <div style={s.footerRow}>
      {step > 0 && (
        <Button kind="secondary" onClick={onBack}>
          {t("exportWizard.back")}
        </Button>
      )}
      <div style={{ flex: 1 }} />
      {step < 3 && (
        <Button kind="primary" onClick={onContinue} disabled={continueDisabled}>
          {t("exportWizard.continue")}
        </Button>
      )}
      {step === 3 && (
        <>
          <Button
            kind="secondary"
            icon="ArrowDown"
            onClick={onDownloadFiles}
            loading={pendingAction === "files"}
            disabled={pendingAction !== null}
          >
            {pendingAction === "files" ? t("exportWizard.downloading") : t("exportWizard.downloadArchive")}
          </Button>
          <Button
            kind="primary"
            icon="GitBranch"
            onClick={onInstall}
            loading={pendingAction === "open_pr"}
            disabled={pendingAction !== null}
          >
            {pendingAction === "open_pr" ? t("exportWizard.installing") : t("exportWizard.install")}
          </Button>
        </>
      )}
    </div>
  );
}
