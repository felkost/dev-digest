/* MetricCard — KPI tile: big value, signed delta, and an optional Sparkline. */
import React from "react";
import { Icon } from "../icons";
import { Sparkline } from "./Sparkline";

export function MetricCard({
  label,
  value,
  delta,
  color,
  trend,
  suffix,
  invertColor,
}: {
  label: string;
  value: React.ReactNode;
  delta?: number;
  color?: string;
  trend?: number[];
  suffix?: string;
  /** Flips the delta color mapping (up → var(--crit), down → var(--ok)) for
   *  metrics where an increase is bad (e.g. cost). Numeric value and arrow
   *  direction are unaffected. Default false keeps the existing "up is good"
   *  mapping (e.g. recall). */
  invertColor?: boolean;
}) {
  const up = (delta ?? 0) > 0;
  const flat = delta === 0;
  const isBad = invertColor ? up : !up;
  const dc = flat ? "var(--text-muted)" : isBad ? "var(--crit)" : "var(--ok)";
  const DeltaIcon = flat ? Icon.Slash : up ? Icon.ArrowUp : Icon.ArrowDown;
  return (
    <div
      style={{
        flex: 1,
        background: "var(--bg-elevated)",
        border: "1px solid var(--border)",
        borderRadius: 9,
        padding: 18,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: "var(--text-muted)",
            letterSpacing: "0.03em",
          }}
        >
          {label}
        </span>
        {trend && <Sparkline data={trend} color={color || "var(--accent)"} w={56} h={20} />}
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 12 }}>
        <span className="tnum" style={{ fontSize: 32, fontWeight: 700, letterSpacing: "-0.02em" }}>
          {value}
          {suffix && <span style={{ fontSize: 18, color: "var(--text-muted)" }}>{suffix}</span>}
        </span>
        {delta != null && (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 2,
              fontSize: 13,
              fontWeight: 600,
              color: dc,
            }}
          >
            <DeltaIcon size={12} />
            <span className="tnum">{Math.abs(delta).toFixed(2)}</span>
          </span>
        )}
      </div>
    </div>
  );
}
