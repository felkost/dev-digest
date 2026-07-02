import type { CSSProperties } from "react";

export const s = {
  descriptionBox: {
    border: "1px solid var(--border)",
    borderRadius: 8,
    background: "var(--bg-elevated)",
    padding: 18,
    fontSize: 14,
    color: "var(--text-secondary)",
    whiteSpace: "pre-wrap",
    lineHeight: 1.55,
  } satisfies CSSProperties,

  // Two-column grid for Intent + Blast Radius cards
  // alignItems defaults to "stretch" (CSS grid default) so both cells share the same height.
  // When the Blast Radius card grows (e.g. Prior PRs accordion expands), the Intent card
  // stretches to match — no JS required.
  cardGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 16,
  } satisfies CSSProperties,

  card: {
    border: "1px solid var(--border)",
    borderRadius: 10,
    background: "var(--bg-elevated)",
    overflow: "hidden",
  } satisfies CSSProperties,

  cardHeader: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "12px 16px",
    borderBottom: "1px solid var(--border)",
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.08em",
    textTransform: "uppercase" as const,
    color: "var(--text-muted)",
  } satisfies CSSProperties,

  cardBody: {
    padding: "14px 16px",
    display: "flex",
    flexDirection: "column" as const,
    gap: 14,
  } satisfies CSSProperties,

  // Intent card
  intentQuote: {
    fontSize: 14,
    fontStyle: "italic" as const,
    color: "var(--text-primary)",
    lineHeight: 1.55,
    margin: 0,
  } satisfies CSSProperties,

  scopeSection: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 6,
  } satisfies CSSProperties,

  scopeHeader: (color: string): CSSProperties => ({
    display: "flex",
    alignItems: "center",
    gap: 5,
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color,
    marginBottom: 2,
  }),

  scopeItem: (muted: boolean): CSSProperties => ({
    display: "flex",
    alignItems: "flex-start",
    gap: 7,
    fontSize: 13,
    color: muted ? "var(--text-muted)" : "var(--text-secondary)",
    lineHeight: 1.4,
  }),

  scopeBullet: {
    color: "var(--text-muted)",
    flexShrink: 0,
    lineHeight: 1.4,
  } satisfies CSSProperties,

  intentDivider: {
    borderTop: "1px solid var(--border)",
    margin: "2px 0",
  } satisfies CSSProperties,

  riskAreasHeader: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: "0.08em",
    textTransform: "uppercase" as const,
    color: "var(--text-muted)",
    marginBottom: 8,
  } satisfies CSSProperties,

  riskChip: (color: string): CSSProperties => ({
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    fontSize: 12,
    color: "var(--text-secondary)",
    background: "var(--bg-surface)",
    border: `1px solid var(--border)`,
    borderRadius: 6,
    padding: "4px 10px",
  }),

  riskGrid: {
    display: "flex",
    flexWrap: "wrap" as const,
    gap: 8,
  } satisfies CSSProperties,

  // Blast Radius card
  statsRow: {
    display: "flex",
    gap: 16,
    alignItems: "center",
    flexWrap: "wrap" as const,
  } satisfies CSSProperties,

  statItem: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    fontSize: 12,
    color: "var(--text-secondary)",
  } satisfies CSSProperties,

  statCount: {
    fontWeight: 700,
    color: "var(--text-primary)",
  } satisfies CSSProperties,

  toggleRow: {
    marginLeft: "auto",
    display: "flex",
    gap: 4,
  } satisfies CSSProperties,

  toggleBtn: (active: boolean): CSSProperties => ({
    padding: "3px 10px",
    fontSize: 11,
    fontWeight: 600,
    borderRadius: 5,
    border: "1px solid var(--border)",
    background: active ? "var(--bg-surface)" : "transparent",
    color: active ? "var(--text-primary)" : "var(--text-muted)",
    cursor: "pointer",
  }),

  // Symbol tree
  treeWrap: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 2,
  } satisfies CSSProperties,

  symbolRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "5px 0",
    borderBottom: "1px solid var(--border)",
  } satisfies CSSProperties,

  symbolName: {
    fontFamily: "var(--font-mono, monospace)",
    fontSize: 13,
    fontWeight: 600,
    color: "var(--text-primary)",
    flex: 1,
  } satisfies CSSProperties,

  callerCount: {
    fontSize: 11,
    color: "var(--text-muted)",
    marginLeft: "auto",
    flexShrink: 0,
  } satisfies CSSProperties,

  callerLines: {
    paddingLeft: 22,
    display: "flex",
    flexDirection: "column" as const,
    gap: 3,
    marginBottom: 6,
  } satisfies CSSProperties,

  callerLine: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontSize: 11,
    color: "var(--text-muted)",
    fontFamily: "var(--font-mono, monospace)",
  } satisfies CSSProperties,

  // Endpoint capsule (globe + `METHOD /path` monospace) — always blue: the
  // color encodes TYPE (HTTP endpoint), not severity. Cron uses the amber
  // cronBadge below. Pure repo-intel read; no findings involved.
  httpBadge: (): CSSProperties => ({
    display: "inline-flex",
    alignItems: "center",
    fontSize: 10,
    fontWeight: 700,
    fontFamily: "var(--font-mono, monospace)",
    padding: "2px 7px",
    borderRadius: 4,
    border: "1px solid rgba(59,130,246,0.35)",
    background: "rgba(59,130,246,0.12)",
    color: "#60a5fa",
  }),

  cronBadge: {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    fontSize: 10,
    fontWeight: 700,
    fontFamily: "var(--font-mono, monospace)",
    padding: "2px 7px",
    borderRadius: 4,
    border: "1px solid rgba(245,158,11,0.35)",
    background: "rgba(245,158,11,0.12)",
    color: "var(--warn)",
  } satisfies CSSProperties,

  endpointBadgeRow: {
    paddingLeft: 22,
    display: "flex",
    flexWrap: "wrap" as const,
    gap: 5,
    marginBottom: 4,
  } satisfies CSSProperties,

  // Prior PRs section
  priorPrsToggle: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "10px 0 4px",
    cursor: "pointer",
    fontSize: 12,
    color: "var(--text-muted)",
    fontWeight: 600,
    borderTop: "1px solid var(--border)",
    userSelect: "none" as const,
    background: "none",
    border: "none",
    width: "100%",
    textAlign: "left" as const,
  } satisfies CSSProperties,

  priorPrItem: {
    padding: "6px 0",
    borderBottom: "1px solid var(--border)",
    display: "flex",
    flexDirection: "column" as const,
    gap: 2,
  } satisfies CSSProperties,

  priorPrTitleRow: {
    display: "flex",
    alignItems: "center",
    gap: 6,
  } satisfies CSSProperties,

  priorPrBullet: {
    width: 6,
    height: 6,
    borderRadius: "50%",
    background: "var(--text-muted)",
    flexShrink: 0,
    opacity: 0.6,
  } satisfies CSSProperties,

  priorPrNumber: {
    fontSize: 12,
    fontWeight: 700,
    color: "#60a5fa",
    fontFamily: "var(--font-mono, monospace)",
    flexShrink: 0,
  } satisfies CSSProperties,

  priorPrTitle: {
    fontSize: 12,
    color: "var(--text-primary)",
    fontWeight: 600,
  } satisfies CSSProperties,

  priorPrMeta: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontSize: 11,
    color: "var(--text-muted)",
    paddingLeft: 12,
  } satisfies CSSProperties,

  priorPrAvatar: (color: string): CSSProperties => ({
    width: 14,
    height: 14,
    borderRadius: "50%",
    background: color,
    color: "#fff",
    fontSize: 9,
    fontWeight: 700,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    textTransform: "lowercase" as const,
  }),

  priorPrNotes: {
    fontSize: 11,
    color: "var(--text-muted)",
    marginTop: 2,
    paddingLeft: 12,
    lineHeight: 1.5,
  } satisfies CSSProperties,

  inlineCode: {
    fontFamily: "var(--font-mono, monospace)",
    fontSize: 10,
    color: "#60a5fa",
    background: "rgba(59,130,246,0.1)",
    border: "1px solid rgba(59,130,246,0.25)",
    borderRadius: 4,
    padding: "0 4px",
  } satisfies CSSProperties,

  // Degraded badge in card header (subtle amber warning)
  degradedBadge: {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    fontSize: 10,
    fontWeight: 600,
    padding: "2px 7px",
    borderRadius: 4,
    background: "rgba(245,158,11,0.12)",
    color: "var(--warn)",
    marginLeft: "auto",
    cursor: "default",
  } satisfies CSSProperties,

  // "+N more" muted row after callers list
  callerMore: {
    paddingLeft: 22,
    fontSize: 11,
    color: "var(--text-muted)",
    fontStyle: "italic" as const,
    marginBottom: 4,
  } satisfies CSSProperties,
} as const;
