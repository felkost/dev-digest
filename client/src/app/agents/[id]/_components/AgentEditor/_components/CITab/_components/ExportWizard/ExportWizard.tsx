"use client";

/* ExportWizard — 4-step Export-to-CI wizard (Target → Preview → Configure →
   Install), opened from the Agent Editor's CI tab (plan Step 9). All state,
   effects, and mutation orchestration live in `useExportWizardFlow`; this
   component only composes the 4 step components + the footer from its
   return value. */

import { useTranslations } from "next-intl";
import { ExportWizardSteps, Modal } from "@devdigest/ui";
import type { Agent } from "@devdigest/shared";
import { useExportWizardFlow, type WizardStep } from "./useExportWizardFlow";
import { TargetStep } from "./_steps/TargetStep";
import { PreviewStep } from "./_steps/PreviewStep";
import { ConfigureStep } from "./_steps/ConfigureStep";
import { InstallStep } from "./_steps/InstallStep";
import { WizardFooter } from "./WizardFooter";
import { s } from "./styles";

interface ExportWizardProps {
  agent: Agent;
  onClose: () => void;
}

export function ExportWizard({ agent, onClose }: ExportWizardProps) {
  const t = useTranslations("ci");
  const flow = useExportWizardFlow(agent);

  const footer = (
    <WizardFooter
      t={t}
      step={flow.step}
      continueDisabled={flow.continueDisabled}
      pendingAction={flow.pendingAction}
      onBack={() => flow.setStep((flow.step - 1) as WizardStep)}
      onContinue={
        flow.step === 0 ? flow.handleContinueFromTarget : () => flow.setStep((flow.step + 1) as WizardStep)
      }
      onDownloadFiles={() => flow.runInstall("files")}
      onInstall={() => flow.runInstall("open_pr")}
    />
  );

  return (
    <Modal
      width={720}
      title={t("exportWizard.title")}
      subtitle={t("exportWizard.subtitle", { agentName: agent.name })}
      onClose={onClose}
      footer={footer}
    >
      <div style={s.stepsWrap}>
        <ExportWizardSteps
          step={flow.step}
          labels={[
            t("exportWizard.steps.target"),
            t("exportWizard.steps.preview"),
            t("exportWizard.steps.configure"),
            t("exportWizard.steps.install"),
          ]}
        />
      </div>

      {flow.step === 0 && (
        <TargetStep t={t} repos={flow.repos} repoId={flow.repoId} onRepoChange={flow.setRepoId} />
      )}

      {flow.step === 1 && (
        <PreviewStep
          t={t}
          isPending={flow.preview.isPending}
          isSuccess={flow.preview.isSuccess}
          conflict={flow.previewConflict}
          files={flow.preview.data?.files ?? []}
          workflowText={flow.workflowText}
          onWorkflowChange={flow.onWorkflowChange}
        />
      )}

      {flow.step === 2 && (
        <ConfigureStep
          t={t}
          triggers={flow.triggers}
          postAs={flow.postAs}
          onTriggerToggle={flow.onTriggerToggle}
          onPostAsChange={flow.onPostAsChange}
        />
      )}

      {flow.step === 3 && (
        <InstallStep
          t={t}
          conflict={flow.installConflict}
          installResult={flow.installResult}
          repoLabel={flow.selectedRepo?.full_name ?? ""}
          fileCount={flow.preview.data?.files.length ?? 0}
        />
      )}
    </Modal>
  );
}
