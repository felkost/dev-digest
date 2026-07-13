/**
 * Relative time, e.g. "3m" / "2h" / "5d". No shared utility exists for this in
 * the client — every list page keeps its own copy (pulls/helpers.ts,
 * onboarding-tour's OnboardingTourView/constants.ts) — this mirrors that same,
 * already-established duplication rather than introducing a new shared util.
 */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "—";
  const m = Math.max(0, Math.round((Date.now() - then) / 60_000));
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** Absolute local timestamp → "2026-06-01 08:42" (YYYY-MM-DD HH:MM). "—" when null. */
export function absoluteTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Whole-seconds duration → "12s" / "1m 30s". Returns "—" when null/undefined. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null) return "—";
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}
