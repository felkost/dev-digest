"use client";

import React from "react";
import { Icon } from "@devdigest/ui";
import type { PrBrief } from "@devdigest/shared";
import { s } from "./styles";

function riskColor(severity: string) {
  return severity === "high"
    ? "var(--crit)"
    : severity === "medium"
      ? "var(--warn)"
      : "var(--text-muted)";
}

export function IntentCard({ brief }: { brief: PrBrief }) {
  const { intent, risks } = brief;
  return (
    <div style={s.card}>
      <div style={s.cardHeader}>
        <Icon.GitBranch size={12} />
        Intent
      </div>
      <div style={s.cardBody}>
        <blockquote style={s.intentQuote}>"{intent.intent}"</blockquote>

        <div style={{ display: "flex", gap: 20 }}>
          {intent.in_scope.length > 0 && (
            <div style={{ ...s.scopeSection, flex: 1 }}>
              <div style={s.scopeHeader("var(--ok)")}>In scope</div>
              {intent.in_scope.map((item, i) => (
                <div key={i} style={s.scopeItem}>
                  <Icon.Check size={12} style={{ color: "var(--ok)", flexShrink: 0, marginTop: 2 }} />
                  {item}
                </div>
              ))}
            </div>
          )}

          {intent.out_of_scope.length > 0 && (
            <div style={{ ...s.scopeSection, flex: 1 }}>
              <div style={s.scopeHeader("var(--crit)")}>Out of scope</div>
              {intent.out_of_scope.map((item, i) => (
                <div key={i} style={s.scopeItem}>
                  <Icon.X size={12} style={{ color: "var(--crit)", flexShrink: 0, marginTop: 2 }} />
                  {item}
                </div>
              ))}
            </div>
          )}
        </div>

        {risks.risks.length > 0 && (
          <div>
            <div style={s.scopeHeader("var(--text-muted)")}>Risk areas</div>
            <div style={s.riskGrid}>
              {risks.risks.map((r, i) => {
                const c = riskColor(r.severity);
                return (
                  <span key={i} style={s.riskChip(c)}>
                    <span style={s.riskDot(c)} />
                    {r.title}
                  </span>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
