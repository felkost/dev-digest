"use client";

import React from "react";
import { Icon } from "@devdigest/ui";
import type { DownstreamImpact } from "@devdigest/shared";
import { s } from "./styles";

function httpMethod(ep: string) {
  const m = ep.match(/^(GET|POST|PUT|PATCH|DELETE|HEAD)\s+/);
  return m ? { method: m[1]!, path: ep.slice(m[1]!.length + 1) } : { method: null, path: ep };
}

export function SymbolImpact({ impact }: { impact: DownstreamImpact }) {
  const [expanded, setExpanded] = React.useState(true);

  return (
    <div>
      <button
        type="button"
        style={{ ...s.symbolRow, cursor: "pointer", background: "none", border: "none", width: "100%", textAlign: "left" }}
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
      >
        <Icon.ChevronRight
          size={12}
          style={{
            color: "var(--text-muted)",
            transform: expanded ? "rotate(90deg)" : "none",
            transition: "transform .1s",
            flexShrink: 0,
          }}
        />
        <span style={s.symbolName}>{impact.symbol}</span>
        <span style={s.callerCount}>
          {impact.callers.length} caller{impact.callers.length !== 1 ? "s" : ""}
        </span>
      </button>
      {expanded && (
        <>
          <div style={s.callerLines}>
            {impact.callers.map((c, i) => (
              <span key={i} style={s.callerLine}>
                <Icon.CornerDownRight size={10} style={{ color: "var(--border)" }} />
                {c.file}:{c.line}
              </span>
            ))}
          </div>
          {impact.endpoints_affected.length > 0 && (
            <div style={s.endpointBadgeRow}>
              {impact.endpoints_affected.map((ep, i) => {
                const { method, path } = httpMethod(ep);
                return method ? (
                  <span key={i} style={s.httpBadge(method)}>
                    {method} {path}
                  </span>
                ) : (
                  <span key={i} style={s.httpBadge("OTHER")}>{ep}</span>
                );
              })}
            </div>
          )}
          {impact.crons_affected.length > 0 && (
            <div style={s.endpointBadgeRow}>
              {impact.crons_affected.map((cr, i) => (
                <span key={i} style={s.cronBadge}>
                  <Icon.Clock size={9} />
                  {cr}
                </span>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
