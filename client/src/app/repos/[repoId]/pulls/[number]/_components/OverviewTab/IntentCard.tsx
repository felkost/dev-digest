"use client";

import { Icon } from "@devdigest/ui";
import type { Intent } from "@devdigest/shared";
import { s } from "./styles";

interface IntentCardProps {
  intent: Intent;
}

export function IntentCard({ intent }: IntentCardProps) {
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
      </div>
    </div>
  );
}
