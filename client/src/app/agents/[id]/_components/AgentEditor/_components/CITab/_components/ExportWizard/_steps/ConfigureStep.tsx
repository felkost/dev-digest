"use client";

import type { useTranslations } from "next-intl";
import { Badge, Chip, FormField, Icon } from "@devdigest/ui";
import type { CiExportInput } from "@devdigest/shared";
import { s } from "../styles";

export type PostAs = CiExportInput["post_as"];

const TRIGGER_OPTIONS = ["opened", "synchronize", "reopened"] as const;

export const POST_AS_VALUES: readonly PostAs[] = ["github_review", "pr_comment", "none"];
const POST_AS_LABEL_KEY: Record<PostAs, string> = {
  github_review: "exportWizard.postAs.githubReview",
  pr_comment: "exportWizard.postAs.prComment",
  none: "exportWizard.postAs.none",
};

interface ConfigureStepProps {
  t: ReturnType<typeof useTranslations>;
  triggers: string[];
  postAs: PostAs;
  onTriggerToggle: (trigger: string, checked: boolean) => void;
  onPostAsChange: (v: string) => void;
}

export function ConfigureStep({ t, triggers, postAs, onTriggerToggle, onPostAsChange }: ConfigureStepProps) {
  return (
    <div style={s.stepBody}>
      <FormField label={t("exportWizard.triggerLabel")}>
        <div style={s.pillRow}>
          {TRIGGER_OPTIONS.map((trig) => {
            const on = triggers.includes(trig);
            return (
              <Chip key={trig} active={on} onClick={() => onTriggerToggle(trig, !on)} icon={on ? "Check" : undefined}>
                pull_request:{trig}
              </Chip>
            );
          })}
        </div>
      </FormField>

      <FormField label={t("exportWizard.postResultsLabel")}>
        <div role="radiogroup" style={s.radioGroup}>
          {POST_AS_VALUES.map((v) => {
            const on = postAs === v;
            return (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => onPostAsChange(v)}
                style={{ ...s.radioItem, ...(on ? s.radioItemActive : {}) }}
              >
                <span style={{ ...s.radioDot, ...(on ? s.radioDotActive : {}) }}>
                  {on && <span style={s.radioDotInner} />}
                </span>
                <span style={s.radioLabel}>{t(POST_AS_LABEL_KEY[v])}</span>
                {v === "github_review" && (
                  <Badge color="var(--accent-text)" bg="var(--accent-bg)">
                    {t("exportWizard.recommended")}
                  </Badge>
                )}
              </button>
            );
          })}
        </div>
      </FormField>

      <div style={s.infoBox}>
        <Icon.Info size={15} style={s.infoIcon} />
        <span>{t.rich("exportWizard.failCiInfo", { b: (chunks) => <b>{chunks}</b> })}</span>
      </div>
    </div>
  );
}
