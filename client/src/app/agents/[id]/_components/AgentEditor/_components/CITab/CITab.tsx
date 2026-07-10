"use client";

/* CITab — Agent Editor "CI" tab (Export-to-CI, plan Step 9). A "CI deployment"
   view: the agent's CI installations (repo, source, latest run status), a
   "Fail CI on" control that reuses ConfigTab's exact `PATCH /agents/:id`
   pattern (zero new server code, AC-42), a bulk-update action, and two entry
   points into the 4-step Export Wizard ("Add to CI" header button + the
   dashed "Add repository" row). */

import React from "react";
import { useTranslations } from "next-intl";
import { Badge, Button, FormField, Icon, SelectInput } from "@devdigest/ui";
import type { Agent, CiFailOn } from "@devdigest/shared";
import { useUpdateAgent } from "@/lib/hooks/agents";
import { useBulkUpdateCi, useCiSurface, useDisconnectCi } from "@/lib/hooks/ci";
import { CI_FAIL_ON_VALUES } from "../ConfigTab/constants";
import { ExportWizard } from "./_components/ExportWizard/ExportWizard";
import { InstallationRow } from "./_components/InstallationRow";
import { BulkUpdateResults } from "./_components/BulkUpdateResults";
import { s } from "./styles";

interface CITabProps {
  agent: Agent;
}

export function CITab({ agent }: CITabProps) {
  const t = useTranslations("ci");
  const tAgents = useTranslations("agents");
  const update = useUpdateAgent();
  const { data: surface, isLoading } = useCiSurface(agent.id);
  const bulkUpdate = useBulkUpdateCi(agent.id);
  const disconnect = useDisconnectCi(agent.id);

  const [ciFailOn, setCiFailOn] = React.useState<CiFailOn>(agent.ci_fail_on);
  // Reset local selection when switching agents (matches ConfigTab's convention).
  React.useEffect(() => {
    setCiFailOn(agent.ci_fail_on);
  }, [agent.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const [wizardOpen, setWizardOpen] = React.useState(false);

  const ciFailOnOptions = CI_FAIL_ON_VALUES.map((v) => ({
    value: v,
    label: tAgents(`config.ciFailOnOptions.${v}`),
  }));

  const onCiFailOnChange = (v: string) => {
    const next = v as CiFailOn;
    setCiFailOn(next);
    update.mutate({ id: agent.id, patch: { ci_fail_on: next } });
  };

  const handleDisconnect = (installationId: string) => {
    if (!window.confirm(t("ciTab.disconnectConfirm"))) return;
    disconnect.mutate(installationId);
  };

  const failOnControl = (
    <div style={s.failOnSection}>
      <FormField label={t("ciTab.failOnLabel")} hint={t("ciTab.failOnHint")}>
        <SelectInput value={ciFailOn} onChange={onCiFailOnChange} options={ciFailOnOptions} />
      </FormField>
    </div>
  );

  if (isLoading) {
    return <div style={s.wrap}>{failOnControl}</div>;
  }

  const installations = surface?.installations ?? [];
  const activeCount = surface?.active_count ?? 0;
  const repoByInstallationId = new Map(installations.map((i) => [i.id, i.repo]));

  return (
    <div style={s.wrap}>
      <div style={s.header}>
        <div style={s.headerLeft}>
          <h2 style={s.h2}>{t("ciTab.heading")}</h2>
          {activeCount > 0 && (
            <Badge dot color="var(--ok)" bg="var(--ok-bg)">
              {t("ciTab.activeInRepos", { count: activeCount })}
            </Badge>
          )}
        </div>
        <div style={s.headerActions}>
          {installations.length > 0 && (
            <Button
              kind="secondary"
              icon="RefreshCw"
              onClick={() => bulkUpdate.mutate()}
              loading={bulkUpdate.isPending}
              disabled={bulkUpdate.isPending}
            >
              {bulkUpdate.isPending ? t("ciTab.updating") : t("ciTab.updateConfig")}
            </Button>
          )}
          <Button kind="primary" icon="Plus" onClick={() => setWizardOpen(true)}>
            {t("ciTab.addToCi")}
          </Button>
        </div>
      </div>

      {bulkUpdate.data && (
        <BulkUpdateResults t={t} result={bulkUpdate.data} repoByInstallationId={repoByInstallationId} />
      )}

      {installations.length === 0 && <div style={s.emptyHint}>{t("ciTab.noInstallations")}</div>}

      <div style={s.list}>
        {installations.map((installation) => (
          <InstallationRow
            key={installation.id}
            t={t}
            installation={installation}
            onDisconnect={handleDisconnect}
            disconnectPending={disconnect.isPending}
          />
        ))}
        <button type="button" style={s.addRepoRow} onClick={() => setWizardOpen(true)}>
          <Icon.Plus size={15} />
          {t("ciTab.addRepository")}
        </button>
      </div>

      {failOnControl}

      {wizardOpen && <ExportWizard agent={agent} onClose={() => setWizardOpen(false)} />}
    </div>
  );
}
