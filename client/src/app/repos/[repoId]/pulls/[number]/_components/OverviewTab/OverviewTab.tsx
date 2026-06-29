"use client";

import React from "react";
import { SectionLabel, Icon } from "@devdigest/ui";
import type { ReviewRecord } from "@devdigest/shared";
import { VerdictBanner } from "../VerdictBanner";
import { usePrBrief } from "@/lib/hooks/reviews";
import { IntentCard } from "./IntentCard";
import { BlastRadiusCard } from "./BlastRadiusCard";
import { s } from "./styles";

interface OverviewTabProps {
  prBody: string | null | undefined;
  prId: string | null | undefined;
  runs?: ReviewRecord[];
  costUsd?: number | null;
}

export function OverviewTab({ prBody, prId, runs = [], costUsd }: OverviewTabProps) {
  const { data: brief } = usePrBrief(prId);

  const latest = runs[0] ?? null;
  const blockers = latest
    ? latest.findings.filter((f) => f.severity === "CRITICAL" && !f.dismissed_at).length
    : 0;

  return (
    <>
      {/* PR Brief: VerdictBanner from most recent review */}
      {latest?.verdict && (
        <section>
          <SectionLabel icon="FileText">PR Brief</SectionLabel>
          <VerdictBanner
            verdict={latest.verdict}
            summary={latest.summary}
            score={latest.score}
            findingsCount={latest.findings.length}
            blockers={blockers}
            costUsd={costUsd}
          />
        </section>
      )}

      {/* Intent + Blast Radius cards — populated by seeded demo data or future pipeline */}
      {brief ? (
        <div style={s.cardGrid}>
          <IntentCard brief={brief} />
          <BlastRadiusCard brief={brief} />
        </div>
      ) : latest?.verdict ? (
        <div style={s.cardGrid}>
          {(["Intent", "Blast radius"] as const).map((label) => (
            <div
              key={label}
              style={{
                ...s.card,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
                minHeight: 120,
                color: "var(--text-muted)",
                fontSize: 13,
              }}
            >
              <Icon.Clock size={18} style={{ opacity: 0.4 }} />
              <span><strong>{label}</strong> analysis not generated for this PR.</span>
            </div>
          ))}
        </div>
      ) : null}

      {/* Original PR description */}
      {prBody && (
        <section>
          <SectionLabel icon="MessageSquare">Description</SectionLabel>
          <div style={s.descriptionBox}>{prBody}</div>
        </section>
      )}
    </>
  );
}
