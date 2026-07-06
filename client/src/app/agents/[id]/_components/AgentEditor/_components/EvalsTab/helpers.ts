/* Shared display helpers for the EvalsTab and its sub-components
   (BatchHistoryTable, TrendChart, BatchCompare). Kept in one place to avoid
   the fingerprint/model unwrap logic and percentage formatting drifting
   between components (finding #11's dedupe note). */

/** The `agent_snapshot` JSONB shape persisted server-side
    (`scoring.ts`'s `AgentSnapshot`): `{ fingerprint, display: { model, ... } }`
    with `fingerprint` at the TOP level, not nested under `display`. */
interface AgentSnapshotShape {
  fingerprint?: unknown;
  display?: { model?: unknown } & Record<string, unknown>;
}

function asSnapshot(snapshot: unknown): AgentSnapshotShape | null {
  if (snapshot && typeof snapshot === "object") return snapshot as AgentSnapshotShape;
  return null;
}

/** Human-readable model name from the agent snapshot, or "—" if absent. */
export function modelLabelFrom(snapshot: unknown): string {
  const snap = asSnapshot(snapshot);
  const model = snap?.display?.model;
  return typeof model === "string" ? model : "—";
}

/** Compact "model @ fingerprint-prefix" label for the Agent Snapshot column /
    tooltip (AC-17/AC-29) — reads the TOP-level `fingerprint`, not
    `display.fingerprint` (which is always undefined and previously made this
    column silently duplicate the Model column, finding #11). */
export function snapshotLabel(snapshot: unknown): string {
  const snap = asSnapshot(snapshot);
  const model = typeof snap?.display?.model === "string" ? (snap.display.model as string) : null;
  const fingerprint = typeof snap?.fingerprint === "string" ? snap.fingerprint : null;

  if (model && fingerprint) return `${model} @ ${fingerprint.slice(0, 12)}`;
  if (fingerprint) return fingerprint.slice(0, 12);
  if (model) return model;
  return "—";
}

/** Formats a 0..1 ratio as a rounded percentage string, or "—" when null. */
export function pct(v: number | null): string {
  return v == null ? "—" : `${Math.round(v * 100)}%`;
}

/** Formats a signed delta (e.g. -0.2 → "-20%", 0.1 → "+10%"). */
export function fmtDelta(v: number): string {
  const pctVal = Math.round(v * 100);
  const sign = pctVal > 0 ? "+" : "";
  return `${sign}${pctVal}%`;
}

/** Color for a signed metric delta — positive (improvement) green, negative
    (regression) red, zero neutral. Matches the `CaseRow` status-color
    convention (`var(--ok)` / `var(--crit)` / `var(--text-muted)`). */
export function deltaColor(v: number): string {
  if (v > 0) return "var(--ok)";
  if (v < 0) return "var(--crit)";
  return "var(--text-muted)";
}
