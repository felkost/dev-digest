"use client";

/**
 * CiRunsView — cross-agent CI Runs page (/ci-runs). Shows every automated
 * review executed by the exported GitHub Actions workflow, across every agent
 * and repo, with filters + an explicit refresh.
 *
 * AC-16 ("checks only on page-open/explicit refresh, never an independent
 * schedule"): the table itself polls `GET /ci/runs` (a cheap DB read, not a
 * GitHub call) every REFRESH_INTERVAL_MS via `useCiRuns`'s own `refetchInterval`
 * option — React Query's observer lifecycle stops this automatically on
 * unmount, so no manual setInterval/visibility tracking is needed. The
 * *expensive* GitHub-calling check (`POST /ci/check`, `useCiCheck`) only ever
 * fires from the explicit Refresh button click — never automatically on mount
 * — to stay rate-limit-friendly (AC-26) and avoid an implicit "schedule".
 */

import React from "react";
import { useTranslations } from "next-intl";
import { Button, Chip, EmptyState, ErrorState, Icon, Skeleton, SelectInput } from "@devdigest/ui";
import { AppShell } from "@/components/app-shell";
import { useAgents } from "@/lib/hooks/agents";
import { useRepos } from "@/lib/hooks/core";
import { useCiRuns, useCiCheck, useClearCiRuns, type CiRunsFilters } from "@/lib/hooks/ci";
import { RECENCY_DAYS, REFRESH_INTERVAL_MS, STATUS_VALUES, STATUS_META, DEFAULT_STATUS_META } from "./constants";
import { RunRow } from "./_components/RunRow/RunRow";
import { s } from "./styles";

export function CiRunsView() {
  const t = useTranslations("ci");
  const crumb = [{ label: t("page.crumb") }];

  const [agentId, setAgentId] = React.useState("");
  const [repo, setRepo] = React.useState("");
  const [status, setStatus] = React.useState("");
  // Source is a v1-cosmetic filter: GitHub Actions is the only functional
  // export target (AC-33), so every run's source is effectively "gha". The
  // control is present to match the reference and stays honest — selecting
  // GitHub Actions shows everything; there is no other source to exclude.
  const [source, setSource] = React.useState("");
  const [recencyOn, setRecencyOn] = React.useState(false);

  const { data: agents } = useAgents();
  const { data: repos } = useRepos();

  // Plain object, not useMemo: building it is a handful of primitive reads,
  // not an expensive computation — and TanStack Query hashes queryKeys
  // structurally (not by reference), so a fresh object every render is both
  // cheap and already cache-correct.
  const filters: CiRunsFilters = {
    agentId: agentId || undefined,
    repo: repo || undefined,
    status: status || undefined,
    sinceDays: recencyOn ? RECENCY_DAYS : undefined,
  };
  const filtersActive = Boolean(agentId || repo || status || source || recencyOn);

  const { data, isLoading, isError, refetch } = useCiRuns(filters, { refetchInterval: REFRESH_INTERVAL_MS });
  const check = useCiCheck();
  const clear = useClearCiRuns();

  const runs = data?.runs ?? [];
  // Only GitHub Actions exists in v1, so any non-"gha" source selection yields
  // nothing; "" and "gha" both show every run.
  const shownRuns = source && source !== "gha" ? [] : runs;
  const lastCheckedAt = data?.last_checked_at ?? null;

  const agentOptions = [
    { value: "", label: t("runs.filters.allAgents") },
    ...(agents ?? []).map((a) => ({ value: a.id, label: a.name })),
  ];
  const repoOptions = [
    { value: "", label: t("runs.filters.allRepos") },
    ...(repos ?? []).map((r) => ({ value: r.full_name, label: r.full_name })),
  ];
  const statusOptions = [
    { value: "", label: t("runs.filters.allStatuses") },
    ...STATUS_VALUES.map((v) => ({
      value: v,
      label: t(`runs.status.${(STATUS_META[v] ?? DEFAULT_STATUS_META).labelKey}`),
    })),
  ];
  const sourceOptions = [
    { value: "", label: t("runs.filters.allSources") },
    { value: "gha", label: t("exportWizard.targets.gha") },
  ];

  return (
    <AppShell crumb={crumb}>
      <div style={s.pageHeader}>
        <div>
          <h1 style={s.pageTitle}>{t("runs.title")}</h1>
          <p style={s.pageSubtitle}>{t("runs.subtitle")}</p>
        </div>
        <div style={s.headerActions}>
          <span style={s.autoRefresh}>
            <span style={s.autoRefreshDot} />
            {t("runs.autoRefresh")}
          </span>
          {lastCheckedAt && (
            <span style={s.syncedAt}>
              {t("runs.lastChecked", { time: new Date(lastCheckedAt).toLocaleTimeString() })}
            </span>
          )}
          <Button kind="secondary" size="sm" icon="RefreshCw" onClick={() => check.mutate()} disabled={check.isPending}>
            {check.isPending ? t("runs.refreshing") : t("runs.refresh")}
          </Button>
          <Button
            kind="secondary"
            size="sm"
            icon="Trash"
            onClick={() => {
              if (window.confirm(t("runs.clearConfirm"))) clear.mutate();
            }}
            disabled={clear.isPending || runs.length === 0}
            title={t("runs.clear")}
            aria-label={t("runs.clear")}
          />
        </div>
      </div>

      <div style={s.tableCard}>
        <div style={s.filterBar}>
          <div style={s.filterItem}>
            <SelectInput value={agentId} onChange={setAgentId} options={agentOptions} mono={false} />
          </div>
          <div style={s.filterItem}>
            <SelectInput value={repo} onChange={setRepo} options={repoOptions} mono={false} />
          </div>
          <div style={s.filterItem}>
            <SelectInput value={status} onChange={setStatus} options={statusOptions} mono={false} />
          </div>
          <div style={s.filterItem}>
            <SelectInput value={source} onChange={setSource} options={sourceOptions} mono={false} />
          </div>
          <Chip active={recencyOn} onClick={() => setRecencyOn((v) => !v)} icon="Calendar">
            {t("runs.filters.last7Days")}
          </Chip>
        </div>

        {check.isError && (
          <div role="alert" style={s.checkFailedBanner}>
            <Icon.AlertTriangle size={14} />
            {t("runs.edgeCases.checkFailed")}
          </div>
        )}

        <div style={s.headRow}>
          <div>{t("runs.table.timestamp")}</div>
          <div>{t("runs.table.pullRequest")}</div>
          <div>{t("runs.table.agent")}</div>
          <div>{t("runs.table.source")}</div>
          <div>{t("runs.table.duration")}</div>
          <div>{t("runs.table.findings")}</div>
          <div>{t("runs.table.cost")}</div>
          <div>{t("runs.table.status")}</div>
          <div>{t("runs.table.trace")}</div>
        </div>

        {isLoading ? (
          <div style={s.loadingStack}>
            <Skeleton height={28} />
            <Skeleton height={28} />
            <Skeleton height={28} />
          </div>
        ) : isError ? (
          <ErrorState body={t("runs.edgeCases.checkFailed")} onRetry={() => refetch()} />
        ) : shownRuns.length === 0 ? (
          filtersActive ? (
            <EmptyState icon="GitBranch" title={t("runs.edgeCases.noMatch")} />
          ) : (
            <EmptyState icon="GitBranch" title={t("runs.emptyTitle")} body={t("runs.emptyBody")} />
          )
        ) : (
          shownRuns.map((run) => <RunRow key={run.id} run={run} />)
        )}
      </div>
    </AppShell>
  );
}
