/* TraceBody — the Trace tab content: Configuration, Stats, Findings, Prompt
   assembly, Tool calls, and Raw output sections for one persisted RunTrace. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Badge } from "@devdigest/ui";
import type { RunTrace, FindingRecord } from "@devdigest/shared";
import { PROMPT_COLORS } from "../../constants";
import { formatSeconds, formatTokens } from "../../helpers";
import { formatCost } from "@/lib/format";
import { s } from "../../styles";
import { TraceSection } from "../TraceSection";
import { ToolCallRow } from "../ToolCallRow";
import { PromptBlock } from "../PromptBlock";
import { FindingsSection } from "../FindingsSection";
import { Row, Stat } from "../atoms";

/** Maps a `cost_report.block_token_counts[].block` key to the SAME i18n label
    already used for that slot in the Prompt assembly section below, so the
    two sections read as one consistent vocabulary. `pr_description` has no
    entry in Prompt assembly (that section doesn't render it), so it gets its
    own key; any future/unrecognized block key falls back to its raw name
    rather than throwing. */
const BLOCK_LABEL_KEYS: Record<string, string> = {
  system: "trace.prompt.system",
  skills: "trace.prompt.skills",
  memory: "trace.prompt.memory",
  specs: "trace.prompt.specs",
  callers: "trace.prompt.callers",
  repo_map: "trace.prompt.repoMap",
  user: "trace.prompt.user",
  pr_description: "trace.costBreakdown.perBlock.prDescription",
};

export function TraceBody({ trace, findings }: { trace: RunTrace; findings: FindingRecord[] }) {
  const t = useTranslations("runs");
  const stats = trace.stats;
  const costReport = trace.cost_report;

  // Biggest consumer first — this is what makes "diff is almost always the
  // champion" (the block mapped to 'user', which carries the PR diff) visible
  // at a glance. Entries whose count is 'unavailable' sort last (can't be
  // ranked) and are excluded from the bar-width scale below.
  const sortedBlocks = costReport
    ? [...costReport.block_token_counts].sort((a, b) => {
        const av = a.tokens === "unavailable" ? -1 : a.tokens;
        const bv = b.tokens === "unavailable" ? -1 : b.tokens;
        return bv - av;
      })
    : [];
  const maxBlockTokens = Math.max(0, ...sortedBlocks.map((b) => (b.tokens === "unavailable" ? 0 : b.tokens)));

  return (
    <>
      <TraceSection icon="Settings" title={t("trace.configuration")}>
        <div style={s.configList}>
          <Row label={t("trace.config.model")}>
            <span className="mono" style={s.configModel}>
              {trace.config.model}
            </span>
          </Row>
          <Row label={t("trace.config.provider")}>
            <span className="mono" style={s.configProvider}>
              {trace.config.provider ?? "—"}
            </span>
          </Row>
          <Row label={t("trace.config.memoryPulled")}>
            <span>{t("trace.config.items", { count: trace.memory_pulled.length })}</span>
          </Row>
          <Row label={t("trace.config.specsRead")}>
            <div style={s.specsWrap}>
              {trace.specs_read.length === 0 ? (
                <span style={s.specsNone}>{t("trace.config.none")}</span>
              ) : (
                trace.specs_read.map((sp, i) => (
                  <span key={i} className="mono" style={s.spec}>
                    {sp}
                  </span>
                ))
              )}
            </div>
          </Row>
        </div>
      </TraceSection>

      <TraceSection
        icon="Gauge"
        title={t("trace.stats")}
        right={
          <Badge color="var(--ok)" bg="var(--ok-bg)" icon="Check">
            {stats.grounding}
          </Badge>
        }
      >
        <div style={s.statsRow}>
          <Stat label={t("trace.stat.duration")} val={formatSeconds(stats.duration_ms)} />
          <Stat label={t("trace.stat.tokens")} val={formatTokens(stats.tokens_in, stats.tokens_out)} />
          <Stat label={t("trace.stat.cost")} val={formatCost(stats.cost_usd)} />
          <Stat label={t("trace.stat.findings")} val={stats.findings} />
        </div>
      </TraceSection>

      <TraceSection icon="DollarSign" title={t("trace.costBreakdown.title")}>
        {!costReport ? (
          <span style={s.costUnavailable}>{t("trace.costBreakdown.unavailable")}</span>
        ) : (
          <>
            <div style={s.costGroup}>
              <div style={s.costGroupTitle}>{t("trace.costBreakdown.perBlock.title")}</div>
              {sortedBlocks.map((b) => (
                <div key={b.block} style={s.costBlockRow}>
                  <span style={s.costBlockLabel} title={b.block}>
                    {BLOCK_LABEL_KEYS[b.block] ? t(BLOCK_LABEL_KEYS[b.block]!) : b.block}
                  </span>
                  <div style={s.costBlockTrack}>
                    {b.tokens !== "unavailable" && maxBlockTokens > 0 && (
                      <div style={s.costBlockBar((b.tokens / maxBlockTokens) * 100)} />
                    )}
                  </div>
                  <span className="tnum" style={s.costBlockValue}>
                    {b.tokens === "unavailable"
                      ? t("trace.costBreakdown.perBlock.unavailable")
                      : t("trace.contextDocs.tokens", { count: b.tokens })}
                  </span>
                </div>
              ))}
            </div>

            <div style={s.costGroup}>
              <div style={s.costGroupTitle}>{t("trace.costBreakdown.cache.title")}</div>
              <div style={s.costCacheRow}>
                <Stat
                  label={t("trace.costBreakdown.cache.cachedTokens")}
                  val={
                    costReport.cached_input_tokens == null
                      ? t("trace.costBreakdown.cache.cachedTokensUnavailable")
                      : t("trace.contextDocs.tokens", { count: costReport.cached_input_tokens })
                  }
                />
                <Stat
                  label={t("trace.costBreakdown.cache.cacheControl")}
                  val={
                    costReport.cache_control_applied
                      ? t("trace.costBreakdown.cache.yes")
                      : t("trace.costBreakdown.cache.no")
                  }
                />
              </div>
            </div>

            <div style={s.costGroup}>
              <div style={s.costGroupTitle}>{t("trace.costBreakdown.boilerplate.title")}</div>
              {costReport.excluded_boilerplate_files.length === 0 ? (
                <span style={s.costLine}>{t("trace.costBreakdown.boilerplate.none")}</span>
              ) : (
                <>
                  <span style={s.costLine}>
                    {t("trace.costBreakdown.boilerplate.excludedFiles", {
                      count: costReport.excluded_boilerplate_files.length,
                    })}
                    {", "}
                    {t("trace.costBreakdown.boilerplate.excludedTokens", {
                      count: costReport.excluded_boilerplate_tokens,
                    })}
                  </span>
                  <div style={s.costBoilerplateFiles}>
                    {costReport.excluded_boilerplate_files.map((f) => (
                      <span key={f} className="mono" style={s.costBoilerplateFile}>
                        {f}
                      </span>
                    ))}
                  </div>
                </>
              )}
            </div>

            <div style={{ ...s.costGroup, ...s.costGroupLast }}>
              <div style={s.costGroupTitle}>{t("trace.costBreakdown.mapReduce.title")}</div>
              {costReport.map_reduce_chunk_count <= 1 ? (
                <span style={s.costLine}>{t("trace.costBreakdown.mapReduce.singlePass")}</span>
              ) : (
                <div style={s.costMapReduceRow}>
                  <Stat label={t("trace.costBreakdown.mapReduce.chunks")} val={costReport.map_reduce_chunk_count} />
                  <Stat
                    label={t("trace.costBreakdown.mapReduce.threshold")}
                    val={
                      costReport.map_reduce_threshold_tokens == null
                        ? t("trace.costBreakdown.mapReduce.thresholdUnavailable")
                        : t("trace.costBreakdown.mapReduce.thresholdTokens", {
                            count: costReport.map_reduce_threshold_tokens,
                          })
                    }
                  />
                </div>
              )}
            </div>
          </>
        )}
      </TraceSection>

      <FindingsSection findings={findings} />

      <TraceSection
        icon="FileText"
        title={t("trace.contextDocs.title")}
        right={<Badge color="var(--text-muted)">{trace.context_documents.length}</Badge>}
      >
        {trace.context_documents.length === 0 ? (
          <span style={s.contextDocEmpty}>{t("trace.contextDocs.empty")}</span>
        ) : (
          trace.context_documents.map((doc, i) => (
            <div
              key={`${doc.path}-${i}`}
              style={i === trace.context_documents.length - 1 ? { ...s.contextDocRow, ...s.contextDocLastRow } : s.contextDocRow}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <span className="mono" style={s.contextDocPath} title={doc.path}>
                  {doc.path}
                </span>
                {doc.status === "skipped" && doc.skip_reason && (
                  <div style={s.contextDocSkipReason}>{doc.skip_reason}</div>
                )}
              </div>
              <span className="tnum" style={s.contextDocTokens}>
                {t("trace.contextDocs.tokens", { count: doc.token_size })}
              </span>
              {doc.status === "injected" ? (
                <Badge color="var(--ok)" bg="var(--ok-bg)" icon="Check">
                  {t("trace.contextDocs.injected")}
                </Badge>
              ) : (
                <Badge color="var(--text-muted)" icon="X">
                  {t("trace.contextDocs.skipped")}
                </Badge>
              )}
            </div>
          ))
        )}
        {trace.context_documents.some((d) => d.status === "injected") && (
          <p style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 8, marginBottom: 0 }}>
            {t("trace.contextDocs.openFullTextHint")}
          </p>
        )}
      </TraceSection>

      <TraceSection icon="FileText" title={t("trace.promptAssembly")} defaultOpen={false}>
        <PromptBlock label={t("trace.prompt.system")} text={trace.prompt_assembly.system} color={PROMPT_COLORS.system} />
        {trace.prompt_assembly.skills != null && (
          <PromptBlock label={t("trace.prompt.skills")} text={trace.prompt_assembly.skills} color={PROMPT_COLORS.skills} highlight />
        )}
        {trace.prompt_assembly.memory != null && (
          <PromptBlock label={t("trace.prompt.memory")} text={trace.prompt_assembly.memory} color={PROMPT_COLORS.memory} />
        )}
        {trace.prompt_assembly.repo_map != null && (
          <PromptBlock label={t("trace.prompt.repoMap")} text={trace.prompt_assembly.repo_map} color={PROMPT_COLORS.repoMap} />
        )}
        {trace.prompt_assembly.specs != null && (
          <PromptBlock label={t("trace.prompt.specs")} text={trace.prompt_assembly.specs} color={PROMPT_COLORS.specs} />
        )}
        {trace.prompt_assembly.callers != null && (
          <PromptBlock label={t("trace.prompt.callers")} text={trace.prompt_assembly.callers} color={PROMPT_COLORS.callers} />
        )}
        <PromptBlock label={t("trace.prompt.user")} text={trace.prompt_assembly.user} color={PROMPT_COLORS.user} />
      </TraceSection>

      <TraceSection
        icon="Wrench"
        title={t("trace.toolCalls")}
        right={<Badge color="var(--text-muted)">{trace.tool_calls.length}</Badge>}
      >
        {trace.tool_calls.length === 0 ? (
          <span style={s.noToolCalls}>{t("trace.noToolCalls")}</span>
        ) : (
          trace.tool_calls.map((tc, i) => <ToolCallRow key={i} tc={tc} />)
        )}
      </TraceSection>

      <TraceSection icon="Code" title={t("trace.rawOutput")} defaultOpen={false}>
        <pre className="mono" style={s.rawPre}>
          {trace.raw_output || "—"}
        </pre>
      </TraceSection>
    </>
  );
}
