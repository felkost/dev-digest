"use client";

import { Icon } from "@devdigest/ui";
import { useTranslations } from "next-intl";
import type { Intent, Risks, Risk } from "@devdigest/shared";
import { s } from "./styles";

interface IntentCardProps {
  intent: Intent;
  /** Optional — seed briefs carry risks; live intent does not. Section hidden when absent/empty. */
  risks?: Risks | null;
}

/** Icon per risk kind — matches the design chips (shield / package / zap). */
function riskIcon(kind: string) {
  const k = kind.toLowerCase();
  if (k.includes("sec") || k.includes("auth")) return Icon.Shield;
  if (k.includes("dep")) return Icon.Boxes;
  if (k.includes("perf") || k.includes("latency")) return Icon.Zap;
  return Icon.AlertTriangle;
}

function RiskChip({ risk }: { risk: Risk }) {
  const RiskIcon = riskIcon(risk.kind);
  return (
    <span style={s.riskChip("var(--text-secondary)")} title={risk.explanation}>
      <RiskIcon size={12} />
      {risk.title}
    </span>
  );
}

export function IntentCard({ intent, risks }: IntentCardProps) {
  const t = useTranslations("brief");
  const riskList = risks?.risks ?? [];

  return (
    <div style={s.card}>
      <div style={s.cardHeader}>
        <Icon.Target size={12} />
        {t("block.intent")}
      </div>
      <div style={s.cardBody}>
        <blockquote style={s.intentQuote}>"{intent.intent}"</blockquote>

        <div style={{ display: "flex", gap: 20 }}>
          {intent.in_scope.length > 0 && (
            <div style={{ ...s.scopeSection, flex: 1 }}>
              <div style={s.scopeHeader("var(--ok)")}>
                <Icon.Check size={11} />
                {t("inScope")}
              </div>
              {intent.in_scope.map((item, i) => (
                <div key={i} style={s.scopeItem(false)}>
                  <span style={s.scopeBullet}>·</span>
                  {item}
                </div>
              ))}
            </div>
          )}

          {intent.out_of_scope.length > 0 && (
            <div style={{ ...s.scopeSection, flex: 1 }}>
              <div style={s.scopeHeader("var(--text-muted)")}>
                <Icon.X size={11} />
                {t("outOfScope")}
              </div>
              {intent.out_of_scope.map((item, i) => (
                <div key={i} style={s.scopeItem(true)}>
                  <span style={s.scopeBullet}>·</span>
                  {item}
                </div>
              ))}
            </div>
          )}
        </div>

        {riskList.length > 0 && (
          <>
            <div style={s.intentDivider} />
            <div>
              <div style={s.riskAreasHeader}>
                <Icon.AlertTriangle size={11} />
                {t("riskAreas")}
              </div>
              <div style={s.riskGrid}>
                {riskList.map((risk, i) => (
                  <RiskChip key={i} risk={risk} />
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
