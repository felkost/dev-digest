/**
 * Unit tests for EvalService + EvalRunOrchestrator (L06).
 *
 * Hermetic: no Postgres, no Docker. `EvalRepository.prototype` methods are
 * stubbed via `vi.spyOn` (per the `context-docs-service.test.ts`/
 * `blast-service.test.ts` convention of stubbing the repository layer rather
 * than hand-rolling a fake Drizzle `db`), and `container` is a plain object
 * literal exposing only the members the service/orchestrator touch
 * (`db`, `agentsRepo`, `reviewRepo`, `llm`) — mirrors `blast-service.test.ts`'s
 * `buildService` helper.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EvalService } from '../src/modules/eval/service.js';
import { EvalRepository } from '../src/modules/eval/repository.js';
import { ValidationError, NotFoundError } from '../src/platform/errors.js';
import { MockLLMProvider } from '../src/adapters/mocks.js';
import type { Container } from '../src/platform/container.js';
import type { Expectation } from '@devdigest/shared';

const WS_ID = '11111111-1111-1111-1111-111111111111';
const AGENT_ID = '22222222-2222-2222-2222-222222222222';
const PR_ID = '33333333-3333-3333-3333-333333333333';
const REVIEW_ID = '44444444-4444-4444-4444-444444444444';
const FINDING_ID = '55555555-5555-5555-5555-555555555555';

const VALID_DIFF = [
  'diff --git a/src/config.ts b/src/config.ts',
  '--- a/src/config.ts',
  '+++ b/src/config.ts',
  '@@ -10,3 +10,4 @@',
  '   port: 3000,',
  '+  stripeKey: "sk_live_xxx",',
  '   redisUrl: x,',
].join('\n');

const AGENT_ROW = {
  id: AGENT_ID,
  workspaceId: WS_ID,
  name: 'Test Agent',
  description: '',
  provider: 'openai' as const,
  model: 'gpt-4.1',
  systemPrompt: 'You are a reviewer.',
  outputSchema: null,
  strategy: 'single-pass' as const,
  ciFailOn: 'critical' as const,
  repoIntel: true,
  enabled: true,
  version: 1,
  createdBy: null,
  createdAt: new Date('2026-01-01'),
};

function makeCaseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'case-1',
    workspaceId: WS_ID,
    ownerKind: 'agent',
    ownerId: AGENT_ID,
    name: 'A case',
    inputDiff: VALID_DIFF,
    inputFiles: null,
    inputMeta: { source: 'manual' },
    expectedOutput: [] as Expectation[],
    notes: null,
    ...overrides,
  };
}

function makeBatchRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'batch-1',
    workspaceId: WS_ID,
    agentId: AGENT_ID,
    kind: 'full' as const,
    status: null,
    agentSnapshot: { fingerprint: 'x', display: {} },
    recall: null,
    precision: null,
    citationAccuracy: null,
    costUsd: null,
    ranAt: new Date('2026-01-01'),
    ...overrides,
  };
}

/** Build a minimal fake Container exposing only what the service/orchestrator use. */
function buildContainer(opts: {
  llm?: MockLLMProvider;
  linkedSkills?: { skill: { enabled: boolean; body: string }; order: number }[];
  agent?: typeof AGENT_ROW | undefined;
  findingContext?: { finding: Record<string, unknown>; review: Record<string, unknown>; pull: Record<string, unknown> } | undefined;
  prFiles?: { path: string; patch: string | null }[];
}): Container {
  const llm = opts.llm ?? new MockLLMProvider('openai', { structured: { verdict: 'comment', summary: 's', score: 80, findings: [] } });

  const container = {
    db: {} as never,
    agentsRepo: {
      getById: vi.fn().mockResolvedValue('agent' in opts ? opts.agent : AGENT_ROW),
      linkedSkills: vi.fn().mockResolvedValue(opts.linkedSkills ?? []),
    },
    reviewRepo: {
      findingContext: vi.fn().mockResolvedValue(opts.findingContext),
      getPrFiles: vi.fn().mockResolvedValue(opts.prFiles ?? []),
    },
    llm: vi.fn().mockResolvedValue(llm),
  };

  return container as unknown as Container;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Case-from-finding derivation
// ---------------------------------------------------------------------------

describe('EvalService.createCaseFromFinding', () => {
  beforeEach(() => {
    // Default: no pre-existing case for this finding (#12's idempotency
    // check runs first in createCaseFromFinding) — individual tests below
    // override this when they need to exercise the idempotent-return path.
    vi.spyOn(EvalRepository.prototype, 'findCaseBySourceFindingId').mockResolvedValue(null);
  });

  it('derives a must_find expectation from an accepted finding', async () => {
    const container = buildContainer({
      findingContext: {
        finding: {
          id: FINDING_ID,
          reviewId: REVIEW_ID,
          file: 'src/config.ts',
          startLine: 11,
          endLine: 11,
          severity: 'CRITICAL',
          category: 'security',
          title: 'Hardcoded secret',
          rationale: 'Do not hardcode secrets',
          suggestion: null,
          confidence: 0.9,
          kind: 'finding',
          acceptedAt: new Date('2026-01-01'),
          dismissedAt: null,
        },
        review: { id: REVIEW_ID, agentId: AGENT_ID, prId: PR_ID },
        pull: { id: PR_ID, workspaceId: WS_ID, number: 42 },
      },
      prFiles: [{ path: 'src/config.ts', patch: '@@ -10,3 +10,4 @@\n   port: 3000,\n+  stripeKey: "x",\n   redisUrl: x,' }],
    });

    const insertSpy = vi.spyOn(EvalRepository.prototype, 'insertCase').mockImplementation(async (data: any) => ({
      id: 'new-case',
      ...data,
    }));

    const service = new EvalService(container);
    const result = await service.createCaseFromFinding(WS_ID, FINDING_ID);

    expect(insertSpy).toHaveBeenCalledOnce();
    const insertedArg = insertSpy.mock.calls[0]![0] as any;
    expect(insertedArg.expectedOutput).toEqual([
      expect.objectContaining({ type: 'must_find', file: 'src/config.ts', line_start: 11, line_end: 11 }),
    ]);
    expect(insertedArg.inputMeta).toEqual({
      source: 'finding',
      source_finding_id: FINDING_ID,
      source_pr_number: 42,
    });
    expect(result.expected_output[0]?.type).toBe('must_find');
  });

  it('derives a must_not_flag expectation from a dismissed finding', async () => {
    const container = buildContainer({
      findingContext: {
        finding: {
          id: FINDING_ID,
          reviewId: REVIEW_ID,
          file: 'src/config.ts',
          startLine: 11,
          endLine: 11,
          severity: 'SUGGESTION',
          category: 'style',
          title: 'Minor nit',
          rationale: 'Not actually a problem',
          suggestion: null,
          confidence: 0.5,
          kind: 'finding',
          acceptedAt: null,
          dismissedAt: new Date('2026-01-01'),
        },
        review: { id: REVIEW_ID, agentId: AGENT_ID, prId: PR_ID },
        pull: { id: PR_ID, workspaceId: WS_ID, number: 7 },
      },
      prFiles: [{ path: 'src/config.ts', patch: '@@ -10,3 +10,4 @@\n   port: 3000,\n+  stripeKey: "x",\n   redisUrl: x,' }],
    });

    vi.spyOn(EvalRepository.prototype, 'insertCase').mockImplementation(async (data: any) => ({
      id: 'new-case',
      ...data,
    }));

    const service = new EvalService(container);
    const result = await service.createCaseFromFinding(WS_ID, FINDING_ID);

    expect(result.expected_output[0]?.type).toBe('must_not_flag');
  });

  it('captures only the finding\'s own file hunk, not the whole multi-file PR diff (AC-5)', async () => {
    const container = buildContainer({
      findingContext: {
        finding: {
          id: FINDING_ID,
          reviewId: REVIEW_ID,
          file: 'src/config.ts',
          startLine: 11,
          endLine: 11,
          severity: 'CRITICAL',
          category: 'security',
          title: 'Hardcoded secret',
          rationale: 'Do not hardcode secrets',
          suggestion: null,
          confidence: 0.9,
          kind: 'finding',
          acceptedAt: new Date('2026-01-01'),
          dismissedAt: null,
        },
        review: { id: REVIEW_ID, agentId: AGENT_ID, prId: PR_ID },
        pull: { id: PR_ID, workspaceId: WS_ID, number: 42 },
      },
      // The PR touches THREE files; the finding is only on src/config.ts.
      prFiles: [
        { path: 'src/other.ts', patch: '@@ -1,2 +1,3 @@\n line one\n+added line\n line two' },
        { path: 'src/config.ts', patch: '@@ -10,3 +10,4 @@\n   port: 3000,\n+  stripeKey: "x",\n   redisUrl: x,' },
        { path: 'src/third.ts', patch: '@@ -5,1 +5,2 @@\n existing\n+another added line' },
      ],
    });

    const insertSpy = vi.spyOn(EvalRepository.prototype, 'insertCase').mockImplementation(async (data: any) => ({
      id: 'new-case',
      ...data,
    }));

    const service = new EvalService(container);
    await service.createCaseFromFinding(WS_ID, FINDING_ID);

    const insertedArg = insertSpy.mock.calls[0]![0] as any;
    expect(insertedArg.inputDiff).toContain('src/config.ts');
    expect(insertedArg.inputDiff).toContain('stripeKey');
    expect(insertedArg.inputDiff).not.toContain('src/other.ts');
    expect(insertedArg.inputDiff).not.toContain('src/third.ts');
    expect(insertedArg.inputDiff).not.toContain('added line');
  });

  it('carries severity + kind onto the expectation as display metadata (AC-3/AC-4)', async () => {
    const container = buildContainer({
      findingContext: {
        finding: {
          id: FINDING_ID,
          reviewId: REVIEW_ID,
          file: 'src/config.ts',
          startLine: 11,
          endLine: 11,
          severity: 'CRITICAL',
          category: 'security',
          title: 'Hardcoded secret',
          rationale: 'Do not hardcode secrets',
          suggestion: null,
          confidence: 0.9,
          kind: 'sql-injection',
          acceptedAt: new Date('2026-01-01'),
          dismissedAt: null,
        },
        review: { id: REVIEW_ID, agentId: AGENT_ID, prId: PR_ID },
        pull: { id: PR_ID, workspaceId: WS_ID, number: 42 },
      },
      prFiles: [{ path: 'src/config.ts', patch: '@@ -10,3 +10,4 @@\n   port: 3000,\n+  stripeKey: "x",\n   redisUrl: x,' }],
    });

    const insertSpy = vi.spyOn(EvalRepository.prototype, 'insertCase').mockImplementation(async (data: any) => ({
      id: 'new-case',
      ...data,
    }));

    const service = new EvalService(container);
    await service.createCaseFromFinding(WS_ID, FINDING_ID);

    const insertedArg = insertSpy.mock.calls[0]![0] as any;
    // severity/kind ride along as display metadata only — scoring.ts never
    // reads them (AC-24) but they must still be present for the UI to render.
    expect(insertedArg.expectedOutput[0]).toMatchObject({ severity: 'CRITICAL', kind: 'sql-injection' });
  });

  it('throws ValidationError when the finding is neither accepted nor dismissed', async () => {
    const container = buildContainer({
      findingContext: {
        finding: {
          id: FINDING_ID,
          reviewId: REVIEW_ID,
          file: 'src/config.ts',
          startLine: 11,
          endLine: 11,
          severity: 'WARNING',
          category: 'bug',
          title: 'Untriaged',
          rationale: 'r',
          suggestion: null,
          confidence: 0.5,
          kind: 'finding',
          acceptedAt: null,
          dismissedAt: null,
        },
        review: { id: REVIEW_ID, agentId: AGENT_ID, prId: PR_ID },
        pull: { id: PR_ID, workspaceId: WS_ID, number: 7 },
      },
    });

    const service = new EvalService(container);
    await expect(service.createCaseFromFinding(WS_ID, FINDING_ID)).rejects.toThrow(ValidationError);
  });

  it('throws NotFoundError for a cross-workspace finding', async () => {
    const container = buildContainer({
      findingContext: {
        finding: { id: FINDING_ID, acceptedAt: new Date(), dismissedAt: null, file: 'a.ts', startLine: 1, endLine: 1, severity: 'CRITICAL', category: 'bug', title: 't', rationale: 'r', confidence: 0.5, kind: 'finding' },
        review: { id: REVIEW_ID, agentId: AGENT_ID, prId: PR_ID },
        pull: { id: PR_ID, workspaceId: 'other-workspace', number: 1 },
      },
    });

    const service = new EvalService(container);
    await expect(service.createCaseFromFinding(WS_ID, FINDING_ID)).rejects.toThrow(NotFoundError);
  });

  it('is idempotent by source_finding_id: returns the existing case instead of inserting a duplicate (#12)', async () => {
    const existingCase = makeCaseRow({
      id: 'existing-case',
      inputMeta: { source: 'finding', source_finding_id: FINDING_ID, source_pr_number: 42 },
    });
    vi.spyOn(EvalRepository.prototype, 'findCaseBySourceFindingId').mockResolvedValue(existingCase as any);
    const insertSpy = vi.spyOn(EvalRepository.prototype, 'insertCase');
    const findingContextSpy = vi.fn();

    const container = buildContainer({ findingContext: undefined });
    (container.reviewRepo as any).findingContext = findingContextSpy;

    const service = new EvalService(container);
    const result = await service.createCaseFromFinding(WS_ID, FINDING_ID);

    expect(result.id).toBe('existing-case');
    expect(insertSpy).not.toHaveBeenCalled();
    // Never even looked up the finding context — the idempotency check short-circuits first.
    expect(findingContextSpy).not.toHaveBeenCalled();
  });

  it('throws ValidationError when the finding\'s file has no patch to derive a diff from (#8)', async () => {
    const container = buildContainer({
      findingContext: {
        finding: {
          id: FINDING_ID,
          reviewId: REVIEW_ID,
          file: 'src/config.ts',
          startLine: 11,
          endLine: 11,
          severity: 'CRITICAL',
          category: 'security',
          title: 'Hardcoded secret',
          rationale: 'r',
          suggestion: null,
          confidence: 0.9,
          kind: 'finding',
          acceptedAt: new Date('2026-01-01'),
          dismissedAt: null,
        },
        review: { id: REVIEW_ID, agentId: AGENT_ID, prId: PR_ID },
        pull: { id: PR_ID, workspaceId: WS_ID, number: 42 },
      },
      // The finding's own file has a null patch (large/binary diff, or a
      // rename pr_files doesn't carry a patch for) — no hunk to derive.
      prFiles: [{ path: 'src/config.ts', patch: null }],
    });

    const insertSpy = vi.spyOn(EvalRepository.prototype, 'insertCase');
    const service = new EvalService(container);

    await expect(service.createCaseFromFinding(WS_ID, FINDING_ID)).rejects.toThrow(ValidationError);
    expect(insertSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Manual case diff validation
// ---------------------------------------------------------------------------

describe('EvalService.createCaseManual', () => {
  it('accepts a valid unified diff and persists the case', async () => {
    const container = buildContainer({});
    const insertSpy = vi.spyOn(EvalRepository.prototype, 'insertCase').mockImplementation(async (data: any) => ({
      id: 'new-case',
      ...data,
    }));

    const service = new EvalService(container);
    const result = await service.createCaseManual(WS_ID, AGENT_ID, {
      owner_id: AGENT_ID,
      name: 'Manual case',
      input_diff: VALID_DIFF,
      expected_output: [],
      notes: null,
    });

    expect(insertSpy).toHaveBeenCalledOnce();
    expect(result.name).toBe('Manual case');
  });

  it('rejects a diff fragment referencing zero files without persisting', async () => {
    const container = buildContainer({});
    const insertSpy = vi.spyOn(EvalRepository.prototype, 'insertCase');

    const service = new EvalService(container);
    await expect(
      service.createCaseManual(WS_ID, AGENT_ID, {
        owner_id: AGENT_ID,
        name: 'Bad case',
        input_diff: 'not a diff at all',
        expected_output: [],
        notes: null,
      }),
    ).rejects.toThrow(ValidationError);

    expect(insertSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Edit-in-place (updateCase)
// ---------------------------------------------------------------------------

describe('EvalService.updateCase', () => {
  it('accepts a valid unified diff and persists the update, preserving provenance', async () => {
    const existing = makeCaseRow({ inputMeta: { source: 'finding', source_finding_id: FINDING_ID, source_pr_number: 42 } });
    vi.spyOn(EvalRepository.prototype, 'getCase').mockResolvedValue(existing as any);
    const updateSpy = vi.spyOn(EvalRepository.prototype, 'updateCase').mockImplementation(async (_ws, _id, data: any) => ({
      ...existing,
      ...data,
    }));

    const container = buildContainer({});
    const service = new EvalService(container);
    const result = await service.updateCase(WS_ID, AGENT_ID, 'case-1', {
      owner_id: AGENT_ID,
      name: 'Updated name',
      input_diff: VALID_DIFF,
      expected_output: [],
      notes: 'updated notes',
    });

    expect(updateSpy).toHaveBeenCalledWith(WS_ID, 'case-1', {
      name: 'Updated name',
      inputDiff: VALID_DIFF,
      expectedOutput: [],
      notes: 'updated notes',
    });
    expect(result.name).toBe('Updated name');
    // Provenance (source/source_finding_id) survives the edit — the update
    // call never touched inputMeta, and the row returned by the mocked
    // updateCase still carries the original inputMeta.
    expect(result.source).toBe('finding');
    expect(result.source_finding_id).toBe(FINDING_ID);
  });

  it('rejects a diff fragment referencing zero files without persisting', async () => {
    vi.spyOn(EvalRepository.prototype, 'getCase').mockResolvedValue(makeCaseRow() as any);
    const updateSpy = vi.spyOn(EvalRepository.prototype, 'updateCase');

    const container = buildContainer({});
    const service = new EvalService(container);
    await expect(
      service.updateCase(WS_ID, AGENT_ID, 'case-1', {
        owner_id: AGENT_ID,
        name: 'Bad edit',
        input_diff: 'not a diff at all',
        expected_output: [],
        notes: null,
      }),
    ).rejects.toThrow(ValidationError);

    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('throws NotFoundError for a missing/cross-workspace case', async () => {
    vi.spyOn(EvalRepository.prototype, 'getCase').mockResolvedValue(null);
    const container = buildContainer({});
    const service = new EvalService(container);
    await expect(
      service.updateCase(WS_ID, AGENT_ID, 'missing-case', {
        owner_id: AGENT_ID,
        name: 'x',
        input_diff: VALID_DIFF,
        expected_output: [],
        notes: null,
      }),
    ).rejects.toThrow(NotFoundError);
  });

  it('throws NotFoundError when the case belongs to a different agent', async () => {
    vi.spyOn(EvalRepository.prototype, 'getCase').mockResolvedValue(makeCaseRow({ ownerId: 'other-agent' }) as any);
    const container = buildContainer({});
    const service = new EvalService(container);
    await expect(
      service.updateCase(WS_ID, AGENT_ID, 'case-1', {
        owner_id: AGENT_ID,
        name: 'x',
        input_diff: VALID_DIFF,
        expected_output: [],
        notes: null,
      }),
    ).rejects.toThrow(NotFoundError);
  });
});

// ---------------------------------------------------------------------------
// Batch run — full-set, mixed pass/fail
// ---------------------------------------------------------------------------

describe('EvalService.runBatch — full batch', () => {
  it('runs every case, aggregates recall/precision, and seals status=clean', async () => {
    const caseMustFind = makeCaseRow({
      id: 'case-a',
      expectedOutput: [
        { type: 'must_find', file: 'src/config.ts', line_start: 11, line_end: 11 } satisfies Expectation,
      ],
    });
    const caseCleanDiff = makeCaseRow({ id: 'case-b', expectedOutput: [] });

    vi.spyOn(EvalRepository.prototype, 'listCases').mockResolvedValue([caseMustFind, caseCleanDiff] as any);
    const insertBatchSpy = vi.spyOn(EvalRepository.prototype, 'insertBatch').mockResolvedValue(makeBatchRow() as any);
    const insertRunSpy = vi.spyOn(EvalRepository.prototype, 'insertRun').mockResolvedValue({} as any);
    const updateAggSpy = vi.spyOn(EvalRepository.prototype, 'updateBatchAggregate').mockResolvedValue(undefined);

    const llm = new MockLLMProvider('openai', {
      structured: {
        verdict: 'comment',
        summary: 'ok',
        score: 90,
        findings: [
          {
            id: 'f1',
            severity: 'CRITICAL',
            category: 'security',
            title: 'Hardcoded secret',
            file: 'src/config.ts',
            start_line: 11,
            end_line: 11,
            rationale: 'r',
            confidence: 0.9,
          },
        ],
      },
    });

    const container = buildContainer({ llm });
    const service = new EvalService(container);

    const result = await service.runBatch(WS_ID, AGENT_ID);

    expect(result.kind).toBe('full');
    expect(insertBatchSpy).toHaveBeenCalledOnce();
    expect(insertBatchSpy.mock.calls[0]![0]).toMatchObject({ kind: 'full', status: null });
    expect(insertRunSpy).toHaveBeenCalledTimes(2);
    expect(updateAggSpy).toHaveBeenCalledOnce();
    const aggArg = updateAggSpy.mock.calls[0]![1];
    expect(aggArg.status).toBe('clean');
    expect(aggArg.recall).toBe(1); // must_find matched
    expect(aggArg.precision).toBe(1); // no must_not_flag violations
  });

  it('derives the stored agent_snapshot from the CURRENT prompt/skills/model/provider, changing when skills change (AC-17 wiring)', async () => {
    const caseCleanDiff = makeCaseRow({ id: 'case-b', expectedOutput: [] });
    vi.spyOn(EvalRepository.prototype, 'listCases').mockResolvedValue([caseCleanDiff] as any);
    const insertBatchSpy = vi.spyOn(EvalRepository.prototype, 'insertBatch').mockResolvedValue(makeBatchRow() as any);
    vi.spyOn(EvalRepository.prototype, 'insertRun').mockResolvedValue({} as any);
    vi.spyOn(EvalRepository.prototype, 'updateBatchAggregate').mockResolvedValue(undefined);

    const llm = new MockLLMProvider('openai', {
      structured: { verdict: 'comment', summary: 'ok', score: 90, findings: [] },
    });

    // No linked skills — baseline fingerprint.
    const container = buildContainer({ llm, linkedSkills: [] });
    const service = new EvalService(container);
    await service.runBatch(WS_ID, AGENT_ID);
    const snapshotNoSkills = insertBatchSpy.mock.calls[0]![0]!.agentSnapshot as { fingerprint: string };
    expect(snapshotNoSkills.fingerprint).toEqual(expect.any(String));

    // Now with an enabled skill linked — the derived fingerprint must differ,
    // proving it's genuinely computed from the agent's current config each
    // run, not a cached/stubbed value.
    insertBatchSpy.mockClear();
    const containerWithSkill = buildContainer({
      llm,
      linkedSkills: [{ skill: { enabled: true, body: 'Always check for SQL injection.' }, order: 0 }],
    });
    const serviceWithSkill = new EvalService(containerWithSkill);
    await serviceWithSkill.runBatch(WS_ID, AGENT_ID);
    const snapshotWithSkill = insertBatchSpy.mock.calls[0]![0]!.agentSnapshot as { fingerprint: string };

    expect(snapshotWithSkill.fingerprint).not.toBe(snapshotNoSkills.fingerprint);
  });
});

// ---------------------------------------------------------------------------
// Degraded-batch path — one case's mock LLM throws
// ---------------------------------------------------------------------------

describe('EvalService.runBatch — degraded path', () => {
  it('records an error outcome for the failing case and marks the batch degraded', async () => {
    const caseOk = makeCaseRow({ id: 'case-ok', expectedOutput: [] });
    const caseBoom = makeCaseRow({ id: 'case-boom', expectedOutput: [] });

    vi.spyOn(EvalRepository.prototype, 'listCases').mockResolvedValue([caseOk, caseBoom] as any);
    vi.spyOn(EvalRepository.prototype, 'insertBatch').mockResolvedValue(makeBatchRow() as any);
    const insertRunSpy = vi.spyOn(EvalRepository.prototype, 'insertRun').mockResolvedValue({} as any);
    const updateAggSpy = vi.spyOn(EvalRepository.prototype, 'updateBatchAggregate').mockResolvedValue(undefined);

    // llm() resolves a provider that throws on the SECOND call only, simulating
    // a per-case provider failure without affecting the first case's run.
    let call = 0;
    const throwingLlm = {
      id: 'openai' as const,
      listModels: vi.fn(),
      complete: vi.fn(),
      embed: vi.fn(),
      completeStructured: vi.fn(async (req: any) => {
        call++;
        if (call === 2) throw new Error('provider timeout');
        return {
          data: { verdict: 'comment', summary: 'ok', score: 90, findings: [] },
          model: req.model,
          tokensIn: 10,
          tokensOut: 5,
          costUsd: 0.001,
          raw: '{}',
          attempts: 1,
        };
      }),
    };

    const container = buildContainer({ llm: throwingLlm as unknown as MockLLMProvider });
    const service = new EvalService(container);

    const result = await service.runBatch(WS_ID, AGENT_ID);

    expect(result.status).toBe('degraded');
    expect(insertRunSpy).toHaveBeenCalledTimes(2);
    const errorRunCall = insertRunSpy.mock.calls.find((c) => (c[0] as any).pass === null);
    expect(errorRunCall).toBeDefined();
    const aggArg = updateAggSpy.mock.calls[0]![1];
    expect(aggArg.status).toBe('degraded');
  });

  it('computes aggregate recall/precision from ONLY the successfully-scored case, excluding the errored one (AC-16)', async () => {
    // case-ok carries a real must_find expectation the mock LLM satisfies —
    // if the errored case were folded into the aggregate as a 0/0 or a
    // failure, recall would no longer cleanly resolve to 1.
    const caseOk = makeCaseRow({
      id: 'case-ok',
      expectedOutput: [
        { type: 'must_find', file: 'src/config.ts', line_start: 11, line_end: 11 } satisfies Expectation,
      ],
    });
    const caseBoom = makeCaseRow({ id: 'case-boom', expectedOutput: [] });

    vi.spyOn(EvalRepository.prototype, 'listCases').mockResolvedValue([caseOk, caseBoom] as any);
    vi.spyOn(EvalRepository.prototype, 'insertBatch').mockResolvedValue(makeBatchRow() as any);
    vi.spyOn(EvalRepository.prototype, 'insertRun').mockResolvedValue({} as any);
    const updateAggSpy = vi.spyOn(EvalRepository.prototype, 'updateBatchAggregate').mockResolvedValue(undefined);

    let call = 0;
    const throwingLlm = {
      id: 'openai' as const,
      listModels: vi.fn(),
      complete: vi.fn(),
      embed: vi.fn(),
      completeStructured: vi.fn(async (req: any) => {
        call++;
        if (call === 2) throw new Error('provider timeout');
        return {
          data: {
            verdict: 'comment',
            summary: 'ok',
            score: 90,
            findings: [
              {
                id: 'f1',
                severity: 'CRITICAL',
                category: 'security',
                title: 'Hardcoded secret',
                file: 'src/config.ts',
                start_line: 11,
                end_line: 11,
                rationale: 'r',
                confidence: 0.9,
              },
            ],
          },
          model: req.model,
          tokensIn: 10,
          tokensOut: 5,
          costUsd: 0.001,
          raw: '{}',
          attempts: 1,
        };
      }),
    };

    const container = buildContainer({ llm: throwingLlm as unknown as MockLLMProvider });
    const service = new EvalService(container);

    await service.runBatch(WS_ID, AGENT_ID);

    const aggArg = updateAggSpy.mock.calls[0]![1];
    // Only case-ok's 1/1 must_find match feeds the aggregate — the errored
    // case contributes nothing (not even a 0/0), so recall/precision resolve
    // exactly as if the batch had a single successfully-scored case.
    expect(aggArg.recall).toBe(1);
    expect(aggArg.precision).toBe(1);
    expect(aggArg.status).toBe('degraded');
  });
});

// ---------------------------------------------------------------------------
// Calibration-batch kind detection
// ---------------------------------------------------------------------------

describe('EvalService.runBatch — calibration kind detection', () => {
  it('marks a strict subset of a multi-case set as a calibration batch', async () => {
    const caseA = makeCaseRow({ id: 'case-a' });
    const caseB = makeCaseRow({ id: 'case-b' });

    vi.spyOn(EvalRepository.prototype, 'listCases').mockResolvedValue([caseA, caseB] as any);
    const insertBatchSpy = vi
      .spyOn(EvalRepository.prototype, 'insertBatch')
      .mockResolvedValue(makeBatchRow({ kind: 'calibration' }) as any);
    vi.spyOn(EvalRepository.prototype, 'insertRun').mockResolvedValue({} as any);
    vi.spyOn(EvalRepository.prototype, 'updateBatchAggregate').mockResolvedValue(undefined);

    const container = buildContainer({});
    const service = new EvalService(container);

    const result = await service.runBatch(WS_ID, AGENT_ID, ['case-a']);

    expect(result.kind).toBe('calibration');
    expect(insertBatchSpy.mock.calls[0]![0]).toMatchObject({ kind: 'calibration' });
  });

  it('treats a single-case case set run as a full batch (not a strict subset)', async () => {
    // `runSingleCase` (a thin `runBatch(ws, agent, [caseId])` wrapper) was
    // dead code — no route ever called `service.runSingleCase` (S5); single-
    // case runs already go through `runBatch([caseId])` directly from the
    // route. Deleted along with its dedicated wrapper method; this test now
    // exercises the same "single-case set resolves to 'full'" behavior via
    // `runBatch` directly.
    const onlyCase = makeCaseRow({ id: 'only-case' });

    vi.spyOn(EvalRepository.prototype, 'listCases').mockResolvedValue([onlyCase] as any);
    const insertBatchSpy = vi
      .spyOn(EvalRepository.prototype, 'insertBatch')
      .mockResolvedValue(makeBatchRow({ kind: 'full' }) as any);
    vi.spyOn(EvalRepository.prototype, 'insertRun').mockResolvedValue({} as any);
    vi.spyOn(EvalRepository.prototype, 'updateBatchAggregate').mockResolvedValue(undefined);

    const container = buildContainer({});
    const service = new EvalService(container);

    const result = await service.runBatch(WS_ID, AGENT_ID, ['only-case']);

    expect(result.kind).toBe('full');
    expect(insertBatchSpy.mock.calls[0]![0]).toMatchObject({ kind: 'full' });
  });
});

// ---------------------------------------------------------------------------
// KPI-delta skip-calibration logic
// ---------------------------------------------------------------------------

describe('EvalService.getKpiDelta', () => {
  it('compares against the previous FULL batch, skipping any calibration batches in between', async () => {
    const latest = makeBatchRow({ id: 'batch-latest', recall: 0.9, precision: 0.8, citationAccuracy: 1, ranAt: new Date('2026-02-01') });
    const previousFull = makeBatchRow({ id: 'batch-prev-full', recall: 0.7, precision: 0.6, citationAccuracy: 0.9, ranAt: new Date('2026-01-01') });

    vi.spyOn(EvalRepository.prototype, 'getBatch').mockResolvedValue(latest as any);
    const previousFullSpy = vi.spyOn(EvalRepository.prototype, 'previousFullBatch').mockResolvedValue(previousFull as any);

    const container = buildContainer({});
    const service = new EvalService(container);

    const delta = await service.getKpiDelta(WS_ID, AGENT_ID, 'batch-latest');

    expect(previousFullSpy).toHaveBeenCalledWith(WS_ID, AGENT_ID, latest.ranAt);
    expect(delta).toEqual({
      recall: expect.closeTo(0.2, 5),
      precision: expect.closeTo(0.2, 5),
      citation_accuracy: expect.closeTo(0.1, 5),
    });
  });

  it('returns null when there is no previous full batch', async () => {
    const latest = makeBatchRow({ id: 'batch-latest' });
    vi.spyOn(EvalRepository.prototype, 'getBatch').mockResolvedValue(latest as any);
    vi.spyOn(EvalRepository.prototype, 'previousFullBatch').mockResolvedValue(null);

    const container = buildContainer({});
    const service = new EvalService(container);

    const delta = await service.getKpiDelta(WS_ID, AGENT_ID, 'batch-latest');
    expect(delta).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// deleteCase — existence/ownership guard
// ---------------------------------------------------------------------------

describe('EvalService.deleteCase', () => {
  it('throws NotFoundError for a missing/cross-workspace case', async () => {
    vi.spyOn(EvalRepository.prototype, 'getCase').mockResolvedValue(null);
    const container = buildContainer({});
    const service = new EvalService(container);
    await expect(service.deleteCase(WS_ID, AGENT_ID, 'missing-case')).rejects.toThrow(NotFoundError);
  });

  it('deletes an existing case in the workspace', async () => {
    vi.spyOn(EvalRepository.prototype, 'getCase').mockResolvedValue(makeCaseRow() as any);
    const deleteSpy = vi.spyOn(EvalRepository.prototype, 'deleteCase').mockResolvedValue(true);
    const container = buildContainer({});
    const service = new EvalService(container);
    await service.deleteCase(WS_ID, AGENT_ID, 'case-1');
    expect(deleteSpy).toHaveBeenCalledWith(WS_ID, 'case-1');
  });

  it('throws NotFoundError when the case belongs to a different agent (#2 ownership guard)', async () => {
    vi.spyOn(EvalRepository.prototype, 'getCase').mockResolvedValue(makeCaseRow({ ownerId: 'other-agent' }) as any);
    const deleteSpy = vi.spyOn(EvalRepository.prototype, 'deleteCase');
    const container = buildContainer({});
    const service = new EvalService(container);
    await expect(service.deleteCase(WS_ID, AGENT_ID, 'case-1')).rejects.toThrow(NotFoundError);
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it('throws NotFoundError when the case is skill-owned (#2 ownership guard)', async () => {
    vi.spyOn(EvalRepository.prototype, 'getCase').mockResolvedValue(
      makeCaseRow({ ownerKind: 'skill', ownerId: 'skill-1' }) as any,
    );
    const deleteSpy = vi.spyOn(EvalRepository.prototype, 'deleteCase');
    const container = buildContainer({});
    const service = new EvalService(container);
    await expect(service.deleteCase(WS_ID, AGENT_ID, 'case-1')).rejects.toThrow(NotFoundError);
    expect(deleteSpy).not.toHaveBeenCalled();
  });
});
