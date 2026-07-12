"use client";

import type { useTranslations } from "next-intl";
import { Badge, FormField, SelectInput } from "@devdigest/ui";
import type { CiTarget, Repo } from "@devdigest/shared";
import { s } from "../styles";

/** Only GitHub Actions is a functional target in v1 (AC-33) — the rest are
    shown, visibly disabled, to communicate the reserved vocabulary. */
const TARGETS: readonly { key: CiTarget; enabled: boolean }[] = [
  { key: "gha", enabled: true },
  { key: "circle", enabled: false },
  { key: "jenkins", enabled: false },
  { key: "cli", enabled: false },
];

interface TargetStepProps {
  t: ReturnType<typeof useTranslations>;
  repos: Repo[] | undefined;
  repoId: string | null;
  onRepoChange: (id: string) => void;
}

export function TargetStep({ t, repos, repoId, onRepoChange }: TargetStepProps) {
  return (
    <div style={s.stepBody}>
      <FormField label={t("exportWizard.repoLabel")} hint={t("exportWizard.repoHint")}>
        {repos && repos.length > 0 ? (
          <SelectInput
            value={repoId ?? ""}
            onChange={onRepoChange}
            options={repos.map((r) => ({ value: r.id, label: r.full_name }))}
          />
        ) : (
          <div style={s.noRepoHint}>{t("ciTab.noRepo")}</div>
        )}
      </FormField>
      <div style={s.targetGrid}>
        {TARGETS.map((tg) => (
          <button
            key={tg.key}
            type="button"
            disabled={!tg.enabled}
            style={tg.enabled ? s.targetCardActive : s.targetCardDisabled}
          >
            <div style={s.targetCardHeader}>
              <span>{t(`exportWizard.targets.${tg.key}`)}</span>
              {tg.enabled && <Badge color="var(--ok)">{t("exportWizard.recommended")}</Badge>}
            </div>
            <div style={s.targetCardDesc}>{t(`exportWizard.targets.${tg.key}Desc`)}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
