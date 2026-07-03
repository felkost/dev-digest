import type { CSSProperties } from "react";

export const s = {
  wrap: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 10,
  } satisfies CSSProperties,

  body: {
    fontSize: 13,
    color: "var(--text-secondary)",
    lineHeight: 1.55,
    margin: 0,
  } satisfies CSSProperties,

  list: {
    listStyle: "none",
    margin: 0,
    padding: 0,
    display: "flex",
    flexDirection: "column" as const,
    gap: 2,
  } satisfies CSSProperties,

  row: {
    display: "flex",
    alignItems: "flex-start",
    gap: 10,
    padding: "8px 0",
    borderBottom: "1px solid var(--border)",
  } satisfies CSSProperties,

  index: {
    fontSize: 11,
    fontWeight: 700,
    color: "var(--text-muted)",
    width: 18,
    flexShrink: 0,
    paddingTop: 1,
  } satisfies CSSProperties,

  rowMain: {
    flex: 1,
    display: "flex",
    flexDirection: "column" as const,
    gap: 3,
  } satisfies CSSProperties,

  path: {
    fontSize: 12.5,
    fontWeight: 600,
    color: "var(--text-primary)",
  } satisfies CSSProperties,

  rationale: {
    fontSize: 12,
    color: "var(--text-muted)",
    lineHeight: 1.5,
    margin: 0,
  } satisfies CSSProperties,
} as const;
