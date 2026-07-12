/* WeeklyStackedBar — stacked bar chart of findings by severity per week, on Recharts. */
import React from "react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { SEV } from "../primitives/tokens";

export interface WeeklyStackedBarPoint {
  label: string;
  CRITICAL: number;
  WARNING: number;
  SUGGESTION: number;
}

export function WeeklyStackedBar({
  data,
  height = 200,
}: {
  data: WeeklyStackedBarPoint[];
  height?: number;
}) {
  const critTotal = data.reduce((sum, d) => sum + d.CRITICAL, 0);
  const warnTotal = data.reduce((sum, d) => sum + d.WARNING, 0);
  const suggTotal = data.reduce((sum, d) => sum + d.SUGGESTION, 0);
  const weekLabel = data.length === 1 ? "week" : "weeks";
  const ariaLabel = `${critTotal} critical, ${warnTotal} warning, ${suggTotal} suggestion findings over the last ${data.length} ${weekLabel}`;

  return (
    <div role="img" aria-label={ariaLabel} style={{ width: "100%", height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 14, right: 14, bottom: 8, left: -10 }}>
          <CartesianGrid stroke="var(--border)" vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 12, fill: "var(--text-muted)" }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fontSize: 12, fill: "var(--text-muted)" }} axisLine={false} tickLine={false} width={38} allowDecimals={false} />
          <Tooltip
            contentStyle={{
              background: "var(--bg-surface)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              fontSize: 12,
            }}
          />
          <Bar dataKey="CRITICAL" stackId="weekly" fill={SEV.CRITICAL.c} isAnimationActive={false} />
          <Bar dataKey="WARNING" stackId="weekly" fill={SEV.WARNING.c} isAnimationActive={false} />
          <Bar dataKey="SUGGESTION" stackId="weekly" fill={SEV.SUGGESTION.c} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
