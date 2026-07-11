import type { Container } from '../../platform/container.js';
import type { AgentRow } from '../../db/rows.js';
import { reviewPullRequest, classifyIntent } from '@devdigest/reviewer-core';
import type { Provider } from '@devdigest/shared';
import { NotFoundError, ValidationError } from '../../platform/errors.js';
import { parseUnifiedDiff } from '../../adapters/git/diff-parser.js';
import * as t from '../../db/schema.js';
import { EvalRepository } from './repository.js';
import {
  aggregateCitationAccuracy,
  aggregatePrecision,
  aggregateRecall,
  casePassed,
  computeAgentSnapshot,
  computeCitationAccuracy,
  intentCasePassed,
  riskBriefCasePassed,
  scoreCase,
  scoreIntentCase,
  scoreRiskBriefCase,
} from './scoring.js';
import { expectationsFromJson, expectedIntentFromJson, expectedRiskBriefFromJson, formatErrorMessage } from './helpers.js';
import { resolveRoutedFeatureModel } from '../../platform/feature-models.js';
import { loadPromptTemplate, renderTemplate } from '../../platform/prompts.js';
// `generateRiskBriefNarrative` lives in `platform/risk-brief.ts` (not
// `modules/reviews`) precisely so this module can reuse the risk-brief
// pipeline's ONE structured LLM call verbatim without a forbidden
// `modules/eval` → `modules/reviews` cross-import (R6, see
// `server/src/modules/AGENTS.md`).
import { generateRiskBriefNarrative } from '../../platform/risk-brief.js';

/**
 * System-prompt template filename for the risk-brief narrative pipeline —
 * mirrors `modules/reviews/brief-generator.ts`'s own (unexported)
 * `RISK_BRIEF_SYSTEM_PROMPT_PATH` constant/value exactly. Kept as a literal
 * duplicate of the FILENAME only (not the prompt TEXT — that stays loaded
 * live via `loadPromptTemplate`, never copy-pasted) because the source
 * constant isn't exported and this module may not reach into another
 * module's internals even for a re-export (R6). If that filename ever
 * changes, update both copies.
 */
const RISK_BRIEF_SYSTEM_PROMPT_TEMPLATE = 'risk-brief.system.md';

type EvalCaseRow = typeof t.evalCases.$inferSelect;
type EvalBatchRow = typeof t.evalBatches.$inferSelect;
type EvalRunInsert = typeof t.evalRuns.$inferInsert;

/**
 * Minimal structured logger (pino-compatible) — kept LOCAL to this module
 * rather than imported from `reviews/run-executor.js`'s identically-shaped
 * `Logger` type, per module import isolation (R6): a module may import only
 * its own files, `@devdigest/shared`, `platform/container`, `db/schema`, and
 * `_shared/` — never another module's internals, even type-only.
 */
export type Logger = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
  debug: (obj: unknown, msg?: string) => void;
};

/** Concurrency cap for case-runs within one batch — mirrors `reviews/routes.ts`'s
 *  `review-all` `scheduleNext()` pattern (2/min rate limit is enforced at the route). */
const CONCURRENCY = 3;

/** Outcome of running a single case, kept in-memory until the batch is sealed. */
interface CaseRunOutcome {
  caseRow: EvalCaseRow;
  status: 'passed' | 'failed' | 'error';
  scoreResult: ReturnType<typeof scoreCase> | null;
  keptFindingsCount: number | null;
  droppedFindingsCount: number | null;
  citationAccuracy: number | null;
  costUsd: number | null;
  durationMs: number;
  actualFindingsCount: number;
}

/**
 * EvalRunOrchestrator — runs a batch of eval cases against an agent's CURRENT
 * configuration, using the SAME `reviewPullRequest()` call type the real
 * review pipeline uses (AC-13 — zero new LLM call sites). Kept separate from
 * `service.ts` to stay under the ~300-line sub-plugin threshold documented in
 * `server/insights.md`.
 */
export class EvalRunOrchestrator {
  private repo: EvalRepository;

  constructor(private container: Container) {
    this.repo = new EvalRepository(container.db);
  }

  /**
   * Resolve the run target (agent + kind + target cases) and insert the
   * batch row, synchronously — fast enough to answer within a normal request
   * (AC-9's 202 flow). The actual case fan-out is kicked off separately via
   * `executeBatch()`, detached from the request/response cycle.
   *
   * Batch kind: `caseIds` omitted or equal to the full case set → 'full';
   * a strict, non-empty subset → 'calibration' (AC-11, AC-14). A single-case
   * case set run as `[thatOneCase]` is NOT a strict subset (it equals the full
   * set), so it naturally resolves to 'full'.
   *
   * `caseIds` is deduped via `Set` before classification (#7) — `[A, A]`
   * against a 2-case set must NOT resolve to 'full' just because the
   * (duplicate-inflated) input length happens to match. Unknown/foreign case
   * ids are silently dropped by the `allCases.filter()` below; if that leaves
   * ZERO resolved target cases (all ids unknown, or a zero-case agent runs
   * a "full" batch), this throws — no zero-run batch may be inserted or enter
   * the trend.
   */
  async startBatch(
    workspaceId: string,
    agentId: string,
    caseIds?: string[],
  ): Promise<{ batch: EvalBatchRow; agent: AgentRow; skillBodies: string[]; targetCases: EvalCaseRow[] }> {
    const agent = await this.container.agentsRepo.getById(workspaceId, agentId);
    if (!agent) throw new NotFoundError('Agent not found');

    const allCases = await this.repo.listCases(workspaceId, agentId);
    const allCaseIds = new Set(allCases.map((c) => c.id));

    const dedupedCaseIds = caseIds ? Array.from(new Set(caseIds)) : undefined;

    const targetCases = dedupedCaseIds
      ? allCases.filter((c) => dedupedCaseIds.includes(c.id))
      : allCases;

    if (targetCases.length === 0) {
      throw new ValidationError(
        dedupedCaseIds
          ? 'No valid case ids resolved for this agent (unknown ids or none belong to this agent)'
          : 'Agent has no eval cases to run',
      );
    }

    const isFullSet =
      !dedupedCaseIds ||
      (dedupedCaseIds.length === allCaseIds.size && dedupedCaseIds.every((id) => allCaseIds.has(id)));
    const kind: 'full' | 'calibration' = isFullSet ? 'full' : 'calibration';

    // ---- Resolve the agent's current config (system prompt, ordered enabled
    // skills, model, provider) — same lookup shape run-executor.ts uses, via
    // the already-exposed container.agentsRepo facade (no reviews/ import).
    const linkedSkills = await this.container.agentsRepo.linkedSkills(agent.id);
    const skillBodies = linkedSkills.filter((l) => l.skill.enabled).map((l) => l.skill.body);

    const agentSnapshot = computeAgentSnapshot({
      systemPrompt: agent.systemPrompt,
      skills: skillBodies,
      model: agent.model,
      provider: agent.provider,
    });

    // ---- Insert the batch row up front. `status: null` until every case-run
    // completes and the aggregate is sealed below — never leave this readable
    // as a finished batch before it actually is (mirrors run-executor.ts's
    // `runCompleted` guard idea, applied to a single upfront insert + one
    // terminal update instead of two competing completion writers).
    const batch = await this.repo.insertBatch({
      workspaceId,
      agentId,
      kind,
      status: null,
      agentSnapshot,
      // Frozen copy of the host agent's CURRENT system prompt at run time
      // (AC-23) — populated for every batch (single run, calibration, and
      // run-all fan-out) since this is the ONE insertBatch call site.
      systemPromptSnapshot: agent.systemPrompt,
    });

    return { batch, agent, skillBodies, targetCases };
  }

  /**
   * Fan out the case runs for a batch already inserted by `startBatch()` and
   * seal its aggregate metrics. Intended to be called DETACHED from the
   * request/response cycle (AC-9) — callers must pass a logger that survives
   * past the response (a `req.log.child({...})` taken BEFORE responding, per
   * the `review-all` fire-and-forget precedent in `reviews/routes.ts` and
   * `server/insights.md`'s "recycled req.log" entry) and must not await this
   * from within the route handler.
   */
  async executeBatch(
    batch: EvalBatchRow,
    agent: AgentRow,
    skillBodies: string[],
    targetCases: EvalCaseRow[],
    log?: Logger,
  ): Promise<{ status: 'clean' | 'degraded' | null }> {
    const outcomes: CaseRunOutcome[] = [];
    let anyError = false;

    await this.runWithConcurrencyCap(targetCases, CONCURRENCY, async (caseRow) => {
      const outcome = await this.runOneCase(agent, skillBodies, caseRow, batch.id, batch.workspaceId).catch(async (err: unknown) => {
        log?.error({ err, caseId: caseRow.id, batchId: batch.id }, 'eval: unexpected case-run failure');
        // `runOneCase` itself never throws (its own try/catch always resolves
        // with a CaseRunOutcome) — reaching here means the failure happened
        // BEFORE/AROUND its own persistence (e.g. a synchronous throw before
        // the try block), so no eval_runs row exists for this case yet.
        // Persist one now so the batch's degraded cause is still visible in
        // the UI drill-down, not just in this log line.
        await this.repo
          .insertRun({
            caseId: caseRow.id,
            batchId: batch.id,
            actualOutput: null,
            pass: null,
            recall: null,
            precision: null,
            citationAccuracy: null,
            durationMs: 0,
            costUsd: null,
            matchedCount: null,
            expectedCount: null,
            errorMessage: formatErrorMessage(err),
          } satisfies EvalRunInsert)
          .catch(() => undefined);

        return {
          caseRow,
          status: 'error' as const,
          scoreResult: null,
          keptFindingsCount: null,
          droppedFindingsCount: null,
          citationAccuracy: null,
          costUsd: null,
          durationMs: 0,
          actualFindingsCount: 0,
        } satisfies CaseRunOutcome;
      });
      if (outcome.status === 'error') anyError = true;
      outcomes.push(outcome);
    });

    // ---- Aggregate metrics ONLY from successfully-scored cases (AC-16).
    const scoredResults = outcomes
      .map((o) => o.scoreResult)
      .filter((r): r is NonNullable<typeof r> => r !== null);

    const recall = scoredResults.length ? aggregateRecall(scoredResults) : null;
    const precision = scoredResults.length ? aggregatePrecision(scoredResults) : null;

    // Pooled citation accuracy (#13, AC-22): sum(kept)/sum(kept+dropped)
    // across the batch's scored cases — NOT an average of each case's ratio.
    const citationCounts = outcomes
      .filter((o) => o.keptFindingsCount !== null && o.droppedFindingsCount !== null)
      .map((o) => ({ keptCount: o.keptFindingsCount!, droppedCount: o.droppedFindingsCount! }));
    const citationAccuracy = citationCounts.length ? aggregateCitationAccuracy(citationCounts) : null;

    const totalCost = outcomes.reduce((sum, o) => sum + (o.costUsd ?? 0), 0);
    const costUsd = outcomes.some((o) => o.costUsd !== null) ? totalCost : null;

    // Seal EVERY batch — full AND calibration — with a real clean/degraded
    // status. Calibration was previously sealed as `null`, but the client keys
    // run-completion off `status != null` (it polls batch-detail while status
    // is null, per hooks/eval.ts). A null-sealed calibration batch therefore
    // looked like it never finished: single-case ("Run case" / per-row ▷) runs
    // appeared to hang forever, the pending state never cleared, and the case
    // list / trend were never invalidated. Safe because the "Calibration" UI
    // label comes from `kind` (BatchHistoryTable) and the trend/KPI queries
    // filter by `kind='full'` (repository.ts) — a non-null status here never
    // leaks a calibration batch into the trend (AC-28) nor changes its pill.
    const status: 'clean' | 'degraded' = anyError ? 'degraded' : 'clean';

    await this.repo.updateBatchAggregate(batch.id, {
      recall,
      precision,
      citationAccuracy,
      costUsd,
      status,
    });

    return { status };
  }

  /**
   * Fan out `executeBatch(...)` across MULTIPLE already-started batches (one
   * per agent, from `EvalService.startRunAll`'s per-agent `startBatch` calls),
   * bounded at `concurrency` (default `CONCURRENCY = 3`, AC-13) — reuses the
   * SAME bounded-worker-pool (`runWithConcurrencyCap`) `executeBatch` itself
   * is built on, so the concurrency-cap algorithm is never duplicated at a
   * second call site. Intended to be called DETACHED from the request/
   * response cycle, exactly like a single `executeBatch` call (AC-9/AC-12).
   */
  async runManyBatchesWithCap(
    started: { batch: EvalBatchRow; agent: AgentRow; skillBodies: string[]; targetCases: EvalCaseRow[] }[],
    concurrency: number = CONCURRENCY,
    log?: Logger,
  ): Promise<void> {
    await this.runWithConcurrencyCap(started, concurrency, async (item) => {
      await this.executeBatch(item.batch, item.agent, item.skillBodies, item.targetCases, log);
    });
  }

  /**
   * Convenience wrapper for callers that want the OLD synchronous
   * start+run+seal behavior in one call (e.g. tests) — awaits the full
   * fan-out before returning. Routes must NOT use this (AC-9) — use
   * `startBatch()` + detached `executeBatch()` instead.
   */
  async runBatch(workspaceId: string, agentId: string, caseIds?: string[]) {
    const { batch, agent, skillBodies, targetCases } = await this.startBatch(workspaceId, agentId, caseIds);
    const { status } = await this.executeBatch(batch, agent, skillBodies, targetCases);
    return { batchId: batch.id, kind: batch.kind, status };
  }

  /**
   * Run one case's review + score it; never throws — runtime failures are
   * captured as an 'error' outcome so the rest of the batch proceeds
   * (AC-15/16). WS6 (Step 12): dispatches to a dedicated method per
   * `caseRow.caseKind` — the `'review_finding'` branch below (the historical
   * default, `?? 'review_finding'` defensive against pre-WS6/legacy rows) is
   * UNCHANGED from before WS6.
   */
  private async runOneCase(
    agent: AgentRow,
    skillBodies: string[],
    caseRow: EvalCaseRow,
    batchId: string,
    workspaceId: string,
  ): Promise<CaseRunOutcome> {
    const kind = caseRow.caseKind ?? 'review_finding';
    if (kind === 'intent') return this.runOneIntentCase(agent, caseRow, batchId, workspaceId);
    if (kind === 'risk_brief_narrative') return this.runOneRiskBriefCase(agent, caseRow, batchId, workspaceId);

    const start = Date.now();
    const expectations = expectationsFromJson(caseRow.expectedOutput);

    try {
      const llm = await this.container.llm(agent.provider as Provider);
      const diff = parseUnifiedDiff(caseRow.inputDiff ?? '');

      const outcome = await reviewPullRequest({
        systemPrompt: agent.systemPrompt,
        model: agent.model,
        diff,
        llm,
        strategy: agent.strategy,
        ...(skillBodies.length ? { skills: skillBodies } : {}),
        sessionId: `eval:${batchId}:${caseRow.id}`,
      });

      const keptFindings = outcome.review.findings.map((f) => ({
        file: f.file,
        startLine: f.start_line,
        endLine: f.end_line,
      }));

      const scoreResult = scoreCase(expectations, keptFindings);
      const keptFindingsCount = outcome.review.findings.length;
      const droppedFindingsCount = outcome.dropped.length;
      const citationAccuracy = computeCitationAccuracy(keptFindingsCount, droppedFindingsCount);
      const durationMs = Date.now() - start;
      const status: 'passed' | 'failed' = casePassed(scoreResult) ? 'passed' : 'failed';

      // Per-run precision uses the SAME clamped formula as the batch aggregate
      // (N1) — mustNotFlagViolations is already capped at findingsCount by
      // scoreCase, but Math.max(0, ...) is defense-in-depth against underflow
      // at this single-case granularity too.
      const runPrecision =
        scoreResult.findingsCount === 0
          ? null
          : Math.max(0, (scoreResult.findingsCount - scoreResult.mustNotFlagViolations) / scoreResult.findingsCount);

      await this.repo.insertRun({
        caseId: caseRow.id,
        batchId,
        actualOutput: outcome.review.findings,
        pass: status === 'passed',
        recall: scoreResult.mustFindTotal === 0 ? null : scoreResult.mustFindMatched / scoreResult.mustFindTotal,
        precision: runPrecision,
        citationAccuracy,
        durationMs,
        costUsd: outcome.costUsd,
        // Persisted at WRITE time (#4) — the drill-down view reads these
        // instead of re-scoring against the case's CURRENT expected_output.
        matchedCount: scoreResult.mustFindMatched,
        expectedCount: scoreResult.mustFindTotal,
      } satisfies EvalRunInsert);

      return {
        caseRow,
        status,
        scoreResult,
        keptFindingsCount,
        droppedFindingsCount,
        citationAccuracy,
        costUsd: outcome.costUsd,
        durationMs,
        actualFindingsCount: outcome.review.findings.length,
      };
    } catch (err) {
      // Per-case runtime failure (provider error/timeout) — distinct from a
      // deterministic scored failure (AC-15). Record it and let the batch
      // continue; the batch itself is marked 'degraded' by the caller.
      const durationMs = Date.now() - start;
      await this.repo
        .insertRun({
          caseId: caseRow.id,
          batchId,
          actualOutput: null,
          pass: null,
          recall: null,
          precision: null,
          citationAccuracy: null,
          durationMs,
          costUsd: null,
          matchedCount: null,
          expectedCount: null,
          errorMessage: formatErrorMessage(err),
        } satisfies EvalRunInsert)
        .catch(() => undefined);

      return {
        caseRow,
        status: 'error',
        scoreResult: null,
        keptFindingsCount: null,
        droppedFindingsCount: null,
        citationAccuracy: null,
        costUsd: null,
        durationMs,
        actualFindingsCount: 0,
      };
    }
  }

  /**
   * Run a single `intent`-kind eval case (WS6, Step 12): classify the case's
   * stored PR-like metadata via the SAME `classifyIntent()` cheap-tier
   * pre-pass production uses (`run-executor.ts`), routed through
   * `resolveRoutedFeatureModel` exactly like `risk_brief` below, then score
   * the result against the case's `{ in_scope, out_of_scope }` expectations
   * (`scoreIntentCase`/`intentCasePassed`). Never throws — same never-throw
   * contract as the `review_finding` branch above; a runtime failure
   * (provider error/timeout, malformed `expected_output`) is caught and
   * turned into an 'error' outcome so the rest of the batch proceeds.
   *
   * `recall` REUSE (documented once here, applies identically to
   * `runOneRiskBriefCase` below): intent cases have no must_find/
   * must_not_flag concept, so `precision`/`citationAccuracy` stay `null` on
   * the persisted run — the generic `recall` column is reused to carry this
   * case kind's own `matched/total` ratio instead, so the Case Editor's
   * existing "recall X%" read path keeps working without a new column.
   */
  private async runOneIntentCase(
    agent: AgentRow,
    caseRow: EvalCaseRow,
    batchId: string,
    workspaceId: string,
  ): Promise<CaseRunOutcome> {
    const start = Date.now();

    try {
      const meta = (caseRow.inputMeta as { title?: string; body?: string; filesSummary?: string } | null) ?? {};
      const title = meta.title ?? caseRow.name;
      const body = meta.body ?? '';
      const filesSummary = meta.filesSummary ?? this.deriveFilesSummary(caseRow);

      const { provider, model } = await resolveRoutedFeatureModel(
        this.container,
        workspaceId,
        'review_intent',
        'intent',
        agent.provider as Provider,
      );
      const llm = await this.container.llm(provider);

      const classifyResult = await classifyIntent({
        title,
        body,
        filesSummary,
        llm,
        model,
        sessionId: `eval:${batchId}:${caseRow.id}`,
      });
      // Same destructure shape `run-executor.ts` uses at its own classifyIntent
      // call site — strips the token/cost accounting fields, leaving the plain
      // `Intent` shape (`intent`/`in_scope`/`out_of_scope`) for scoring/storage.
      // (`tokensIn`/`tokensOut` are intentionally unused here — only `costUsd`
      // is persisted; `noUnusedLocals` is off in this project's tsconfig.)
      const { tokensIn: _tokensInUnused, tokensOut: _tokensOutUnused, costUsd, ...intent } = classifyResult;

      const expected = expectedIntentFromJson(caseRow.expectedOutput);
      const scoreResult = scoreIntentCase(intent, expected);
      const passed = intentCasePassed(scoreResult, caseRow.passingThreshold ?? undefined);
      const durationMs = Date.now() - start;

      await this.repo.insertRun({
        caseId: caseRow.id,
        batchId,
        actualOutput: intent,
        pass: passed,
        recall: scoreResult.total === 0 ? null : scoreResult.matched / scoreResult.total,
        precision: null,
        citationAccuracy: null,
        durationMs,
        costUsd,
        matchedCount: scoreResult.matched,
        expectedCount: scoreResult.total,
      } satisfies EvalRunInsert);

      return {
        caseRow,
        status: passed ? 'passed' : 'failed',
        scoreResult: null,
        keptFindingsCount: null,
        droppedFindingsCount: null,
        citationAccuracy: null,
        costUsd,
        durationMs,
        actualFindingsCount: 0,
      };
    } catch (err) {
      const durationMs = Date.now() - start;
      await this.repo
        .insertRun({
          caseId: caseRow.id,
          batchId,
          actualOutput: null,
          pass: null,
          recall: null,
          precision: null,
          citationAccuracy: null,
          durationMs,
          costUsd: null,
          matchedCount: null,
          expectedCount: null,
          errorMessage: formatErrorMessage(err),
        } satisfies EvalRunInsert)
        .catch(() => undefined);

      return {
        caseRow,
        status: 'error',
        scoreResult: null,
        keptFindingsCount: null,
        droppedFindingsCount: null,
        citationAccuracy: null,
        costUsd: null,
        durationMs,
        actualFindingsCount: 0,
      };
    }
  }

  /**
   * Run a single `risk_brief_narrative`-kind eval case (WS6, Step 12):
   * generate the SAME structured risk-brief narrative production uses
   * (`generateRiskBriefNarrative`, reused directly per this file's top-level
   * cross-module-import note — never a duplicated LLM call), then score it
   * against the case's `{ key_points }` expectations
   * (`scoreRiskBriefCase`/`riskBriefCasePassed`). The `input` string is built
   * DIRECTLY from `caseRow.inputDiff` — `BriefGeneratorService.generate`'s
   * full live-PR fact-gathering pipeline (blast radius, context docs, prior
   * findings) is deliberately SKIPPED here; the stored diff alone is a
   * proportionate eval input for scoring the narrative pipeline's prompt/
   * model behavior. Never throws — same never-throw contract as the other
   * two branches.
   */
  private async runOneRiskBriefCase(
    agent: AgentRow,
    caseRow: EvalCaseRow,
    batchId: string,
    workspaceId: string,
  ): Promise<CaseRunOutcome> {
    const start = Date.now();

    try {
      const { provider, model } = await resolveRoutedFeatureModel(
        this.container,
        workspaceId,
        'risk_brief',
        'summary',
        agent.provider as Provider,
      );
      const llm = await this.container.llm(provider);

      // Same loader MECHANISM `brief-generator.ts`'s own (unexported)
      // `loadSystemPrompt()` uses (`loadPromptTemplate` + `renderTemplate`) —
      // never a duplicated copy of the prompt TEXT. A missing template file
      // throws ENOENT here, caught by this method's own try/catch below
      // (unlike `brief-generator.ts`, which degrades to an inline
      // placeholder — an eval run failing loudly on a missing prompt file is
      // preferable to silently scoring against placeholder text).
      const template = await loadPromptTemplate(RISK_BRIEF_SYSTEM_PROMPT_TEMPLATE);
      const systemPrompt = renderTemplate(template, {});

      const input = caseRow.inputDiff ?? '';
      const result = await generateRiskBriefNarrative(llm, model, systemPrompt, input);

      const expected = expectedRiskBriefFromJson(caseRow.expectedOutput);
      const scoreResult = scoreRiskBriefCase(result.data, expected.key_points);
      const passed = riskBriefCasePassed(scoreResult, caseRow.passingThreshold ?? undefined);
      const durationMs = Date.now() - start;

      await this.repo.insertRun({
        caseId: caseRow.id,
        batchId,
        actualOutput: result.data,
        pass: passed,
        recall: scoreResult.total === 0 ? null : scoreResult.matched / scoreResult.total,
        precision: null,
        citationAccuracy: null,
        durationMs,
        costUsd: result.costUsd,
        matchedCount: scoreResult.matched,
        expectedCount: scoreResult.total,
      } satisfies EvalRunInsert);

      return {
        caseRow,
        status: passed ? 'passed' : 'failed',
        scoreResult: null,
        keptFindingsCount: null,
        droppedFindingsCount: null,
        citationAccuracy: null,
        costUsd: result.costUsd,
        durationMs,
        actualFindingsCount: 0,
      };
    } catch (err) {
      const durationMs = Date.now() - start;
      await this.repo
        .insertRun({
          caseId: caseRow.id,
          batchId,
          actualOutput: null,
          pass: null,
          recall: null,
          precision: null,
          citationAccuracy: null,
          durationMs,
          costUsd: null,
          matchedCount: null,
          expectedCount: null,
          errorMessage: formatErrorMessage(err),
        } satisfies EvalRunInsert)
        .catch(() => undefined);

      return {
        caseRow,
        status: 'error',
        scoreResult: null,
        keptFindingsCount: null,
        droppedFindingsCount: null,
        citationAccuracy: null,
        costUsd: null,
        durationMs,
        actualFindingsCount: 0,
      };
    }
  }

  /**
   * Fallback `filesSummary` for an `intent`-kind case whose `inputMeta`
   * doesn't carry one: first try `caseRow.inputFiles` (jsonb; may hold a
   * plain array of file path strings or `{ path, ... }` objects, depending on
   * how the case was authored), else derive one from the case's OWN stored
   * diff — always present/valid per `createCaseManual`'s own diff-parses-to-
   * at-least-one-file validation — using the same shape (`path
   * (+additions/-deletions)` + `@@` hunk headers) `run-executor.ts`'s
   * `buildFilesSummary` builds for the production intent pre-pass,
   * reimplemented locally per module isolation (R6 — cannot import
   * `reviews/run-executor.ts`).
   */
  private deriveFilesSummary(caseRow: EvalCaseRow): string {
    if (Array.isArray(caseRow.inputFiles) && caseRow.inputFiles.length > 0) {
      const paths = caseRow.inputFiles
        .map((f) => (typeof f === 'string' ? f : (f as { path?: unknown })?.path))
        .filter((p): p is string => typeof p === 'string' && p.length > 0);
      if (paths.length > 0) return paths.join('\n');
    }

    const diff = parseUnifiedDiff(caseRow.inputDiff ?? '');
    return diff.files
      .map((f) => {
        const hunkHeaders = f.hunks
          .map((h) => `  @@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`)
          .join('\n');
        return `${f.path} (+${f.additions}/-${f.deletions})${hunkHeaders ? '\n' + hunkHeaders : ''}`;
      })
      .join('\n\n');
  }

  /** Bounded-concurrency map over `items`, awaiting all before returning
   *  (unlike `reviews/routes.ts`'s fire-and-forget `scheduleNext` — this
   *  orchestrator must resolve only once every case-run has settled, so the
   *  batch aggregate is computed from complete data). */
  private async runWithConcurrencyCap<T>(
    items: T[],
    concurrency: number,
    fn: (item: T) => Promise<void>,
  ): Promise<void> {
    let head = 0;
    const workers: Promise<void>[] = [];
    const runNext = async (): Promise<void> => {
      while (head < items.length) {
        const item = items[head++]!;
        await fn(item);
      }
    };
    const workerCount = Math.min(concurrency, items.length);
    for (let i = 0; i < workerCount; i++) workers.push(runNext());
    await Promise.all(workers);
  }
}
