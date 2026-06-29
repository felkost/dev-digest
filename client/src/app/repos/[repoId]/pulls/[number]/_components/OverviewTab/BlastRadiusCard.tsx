"use client";

import React from "react";
import { Icon } from "@devdigest/ui";
import type { PrBrief } from "@devdigest/shared";
import { SymbolImpact } from "./SymbolImpact";
import { s } from "./styles";

export function BlastRadiusCard({ brief }: { brief: PrBrief }) {
  const { blast, history } = brief;
  const [priorOpen, setPriorOpen] = React.useState(false);

  const totalCallers = blast.downstream.reduce((sum, d) => sum + d.callers.length, 0);
  const totalEndpoints = blast.downstream.reduce((sum, d) => sum + d.endpoints_affected.length, 0);
  const totalCrons = blast.downstream.reduce((sum, d) => sum + d.crons_affected.length, 0);
  const priorCount = history.history.length;

  return (
    <div style={s.card}>
      <div style={s.cardHeader}>
        <Icon.Zap size={12} />
        Blast radius
      </div>
      <div style={s.cardBody}>
        {/* Stats row */}
        <div style={s.statsRow}>
          <span style={s.statItem}>
            <Icon.Code size={12} />
            <span style={s.statCount}>{blast.changed_symbols.length}</span> symbols
          </span>
          <span style={s.statItem}>
            <Icon.ArrowRight size={12} />
            <span style={s.statCount}>{totalCallers}</span> callers
          </span>
          <span style={s.statItem}>
            <Icon.Globe size={12} />
            <span style={s.statCount}>{totalEndpoints}</span> endpoints
          </span>
          <span style={s.statItem}>
            <Icon.Clock size={12} />
            <span style={s.statCount}>{totalCrons}</span> cron
          </span>
          <span style={s.toggleRow}>
            <button type="button" style={s.toggleBtn(true)}>Tree</button>
            <button type="button" style={s.toggleBtn(false)}>Graph</button>
          </span>
        </div>

        {/* Symbol tree */}
        <div style={s.treeWrap}>
          {blast.downstream.map((impact, idx) => (
            <SymbolImpact key={idx} impact={impact} />
          ))}
        </div>

        {/* Prior PRs collapsible */}
        {priorCount > 0 && (
          <div>
            <button
              type="button"
              style={s.priorPrsToggle}
              aria-expanded={priorOpen}
              onClick={() => setPriorOpen((o) => !o)}
            >
              <Icon.GitPullRequest size={12} />
              Prior PRs touching these files
              <span
                style={{
                  marginLeft: 4,
                  background: "var(--bg-surface)",
                  border: "1px solid var(--border)",
                  borderRadius: 10,
                  padding: "0 6px",
                  fontSize: 11,
                }}
              >
                {priorCount}
              </span>
              <Icon.ChevronDown
                size={12}
                style={{
                  marginLeft: "auto",
                  transform: priorOpen ? "rotate(180deg)" : "none",
                  transition: "transform .15s",
                }}
              />
            </button>
            {priorOpen &&
              history.history.map((h, i) => (
                <div key={i} style={s.priorPrItem}>
                  <div style={s.priorPrTitle}>#{h.pr_number} {h.title}</div>
                  <div style={s.priorPrMeta}>
                    <span>{h.author}</span>
                    <span>merged {new Date(h.merged_at).toLocaleDateString()}</span>
                    <span>{h.files_overlap.length} shared file{h.files_overlap.length !== 1 ? "s" : ""}</span>
                  </div>
                  {h.notes && (
                    <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                      {h.notes}
                    </div>
                  )}
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
