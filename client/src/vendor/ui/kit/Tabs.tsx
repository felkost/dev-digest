import React from "react";
import { Icon } from "../icons";
import { type TabDef } from "./types";

export function Tabs({
  tabs,
  value,
  onChange,
  pad = "0 28px",
}: {
  tabs: TabDef[];
  value: string;
  onChange: (k: string) => void;
  pad?: string;
}) {
  return (
    <div style={{ display: "flex", gap: 2, padding: pad, borderBottom: "1px solid var(--border)" }}>
      {tabs.map((t) => {
        const k = typeof t === "string" ? t : t.key;
        const label = typeof t === "string" ? t : t.label;
        const icon = typeof t === "object" ? t.icon : undefined;
        // Optional per-tab accent (e.g. a persona color) — falls back to the
        // default accent so every existing caller that doesn't set it is
        // unaffected. Unlike the active/inactive text color, the icon keeps
        // its own accent color even when the tab isn't selected.
        const tabColor = typeof t === "object" ? t.color : undefined;
        const on = value === k;
        const I = icon ? Icon[icon] : null;
        return (
          <button
            key={k}
            onClick={() => onChange(k)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "12px 16px",
              border: "none",
              background: "transparent",
              borderBottom: "2px solid " + (on ? (tabColor ?? "var(--accent)") : "transparent"),
              marginBottom: -1,
              cursor: "pointer",
              fontSize: 14,
              fontWeight: on ? 600 : 500,
              color: on ? "var(--text-primary)" : "var(--text-secondary)",
            }}
          >
            {I && <I size={14} style={{ color: tabColor ?? (on ? "var(--accent)" : "var(--text-muted)") }} />}
            {label}
            {typeof t === "object" && t.count != null && (
              <span className="tnum" style={{ fontSize: 12, color: "var(--text-muted)" }}>
                {t.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
