"use client";

import type { useTranslations } from "next-intl";
import { Badge } from "@devdigest/ui";
import type { CiBulkUpdateResult } from "@devdigest/shared";
import { s } from "../styles";

interface BulkUpdateResultsProps {
  t: ReturnType<typeof useTranslations>;
  result: CiBulkUpdateResult;
  /** Installation id -> repo, so a row can show a readable repo name instead
      of a bare id — built from data already fetched for the installations list. */
  repoByInstallationId: Map<string, string>;
}

export function BulkUpdateResults({ t, result, repoByInstallationId }: BulkUpdateResultsProps) {
  const ok = result.results.filter((r) => r.ok).length;
  return (
    <div style={s.bulkResults} role="status" aria-live="polite">
      <div style={s.bulkResultsHeading}>
        {t("ciTab.updateOutcome", { ok, total: result.results.length })}
      </div>
      {result.results.map((r) => (
        <div key={r.installation_id} style={s.bulkResultRow}>
          <span style={s.bulkResultRepo}>
            {repoByInstallationId.get(r.installation_id) ?? r.installation_id}
          </span>
          {r.ok ? (
            <Badge icon="Check" color="var(--ok)">
              OK
            </Badge>
          ) : (
            <Badge icon="XCircle" color="var(--crit)">
              {r.error}
            </Badge>
          )}
        </div>
      ))}
    </div>
  );
}
