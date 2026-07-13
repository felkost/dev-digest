/**
 * Unit tests for `AgentsService.statsDetail`'s week zero-fill helper
 * (`zeroFillWeeklySeverity`, L08 Spec B, spec §9 / AC-12).
 *
 * `zeroFillWeeklySeverity` is a module-private function in `agents/service.ts`
 * (not exported) — exercised indirectly by calling `AgentsService.statsDetail()`
 * directly with `AgentsRepository.prototype` stubbed via `vi.spyOn` (same
 * hermetic convention as `agents-promote.test.ts`). System time is frozen so
 * the 8-week window is deterministic.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentsService } from '../src/modules/agents/service.js';
import { AgentsRepository } from '../src/modules/agents/repository.js';
import type { Container } from '../src/platform/container.js';
import type { AgentRow } from '../src/db/rows.js';

const WS_ID = '11111111-1111-1111-1111-111111111111';
const AGENT_ID = '22222222-2222-2222-2222-222222222222';

const AGENT_ROW: AgentRow = {
  id: AGENT_ID,
  workspaceId: WS_ID,
  name: 'Test Agent',
  description: '',
  provider: 'openai',
  model: 'gpt-4.1',
  systemPrompt: 'x',
  outputSchema: null,
  strategy: 'single-pass',
  ciFailOn: 'critical',
  repoIntel: true,
  enabled: true,
  version: 1,
  createdBy: null,
  createdAt: new Date('2026-01-01'),
};

function buildContainer(): Container {
  return { db: {} as never } as unknown as Container;
}

/** Stubs every `statsDetail` dependency except `getById`/`weeklyFindingsBySeverity`,
 *  which each test sets explicitly. */
function stubBaseRepo() {
  vi.spyOn(AgentsRepository.prototype, 'runAggregatesByAgent').mockResolvedValue(new Map());
  vi.spyOn(AgentsRepository.prototype, 'findingsAggregatesByAgent').mockResolvedValue(new Map());
  vi.spyOn(AgentsRepository.prototype, 'costWindowsByAgent').mockResolvedValue(new Map());
  vi.spyOn(AgentsRepository.prototype, 'mostUsedSkillsApprox').mockResolvedValue([]);
  vi.spyOn(AgentsRepository.prototype, 'memoryPulledSummary').mockResolvedValue([]);
  vi.spyOn(AgentsRepository.prototype, 'runHistoryForAgent').mockResolvedValue([]);
}

beforeEach(() => {
  // Freeze "now" to a known UTC Wednesday (2026-07-15) inside the ISO week that
  // starts Monday 2026-07-13 — the production zero-fill's `now` is UTC-based, so
  // this pins the resulting 8 week_start buckets to a fixed, known sequence:
  // 2026-05-25, 06-01, 06-08, 06-15, 06-22, 06-29, 07-06, 07-13 (oldest→newest).
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-15T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('AgentsService.statsDetail — weekly_findings_by_severity zero-fill', () => {
  it('expands sparse (week, severity) rows into exactly 8 ordered points, zero-filling weeks/severities with no data', async () => {
    vi.spyOn(AgentsRepository.prototype, 'getById').mockResolvedValue(AGENT_ROW);
    stubBaseRepo();
    vi.spyOn(AgentsRepository.prototype, 'weeklyFindingsBySeverity').mockResolvedValue([
      { weekStart: new Date('2026-06-08T00:00:00Z'), severity: 'CRITICAL', count: 2 },
      { weekStart: new Date('2026-06-08T00:00:00Z'), severity: 'WARNING', count: 1 },
      { weekStart: new Date('2026-07-13T00:00:00Z'), severity: 'SUGGESTION', count: 4 },
    ]);

    const service = new AgentsService(buildContainer());
    const detail = await service.statsDetail(WS_ID, AGENT_ID);

    expect(detail).toBeDefined();
    const weeks = detail!.weekly_findings_by_severity;
    expect(weeks).toHaveLength(8);
    expect(weeks.map((w) => w.week_start)).toEqual([
      '2026-05-25',
      '2026-06-01',
      '2026-06-08',
      '2026-06-15',
      '2026-06-22',
      '2026-06-29',
      '2026-07-06',
      '2026-07-13',
    ]);

    // The one week that HAD raw rows carries the real counts, split by severity.
    expect(weeks.find((w) => w.week_start === '2026-06-08')).toEqual({
      week_start: '2026-06-08',
      CRITICAL: 2,
      WARNING: 1,
      SUGGESTION: 0,
    });
    // The current week had only a SUGGESTION row — CRITICAL/WARNING zero-fill.
    expect(weeks.find((w) => w.week_start === '2026-07-13')).toEqual({
      week_start: '2026-07-13',
      CRITICAL: 0,
      WARNING: 0,
      SUGGESTION: 4,
    });
    // Every other week had NO rows at all — fully zero-filled, not omitted.
    for (const wk of ['2026-05-25', '2026-06-01', '2026-06-15', '2026-06-22', '2026-06-29', '2026-07-06']) {
      expect(weeks.find((w) => w.week_start === wk)).toEqual({
        week_start: wk,
        CRITICAL: 0,
        WARNING: 0,
        SUGGESTION: 0,
      });
    }
  });

  it('returns all-zero 8-week points when the agent has no findings at all in the window', async () => {
    vi.spyOn(AgentsRepository.prototype, 'getById').mockResolvedValue(AGENT_ROW);
    stubBaseRepo();
    vi.spyOn(AgentsRepository.prototype, 'weeklyFindingsBySeverity').mockResolvedValue([]);

    const service = new AgentsService(buildContainer());
    const detail = await service.statsDetail(WS_ID, AGENT_ID);

    expect(detail!.weekly_findings_by_severity).toHaveLength(8);
    expect(detail!.weekly_findings_by_severity.every((w) => w.CRITICAL === 0 && w.WARNING === 0 && w.SUGGESTION === 0)).toBe(true);
  });

  it('returns undefined (route 404s) for an agent not in this workspace, without querying any stats aggregate', async () => {
    vi.spyOn(AgentsRepository.prototype, 'getById').mockResolvedValue(undefined);
    const weeklySpy = vi.spyOn(AgentsRepository.prototype, 'weeklyFindingsBySeverity');

    const service = new AgentsService(buildContainer());
    const detail = await service.statsDetail(WS_ID, AGENT_ID);

    expect(detail).toBeUndefined();
    expect(weeklySpy).not.toHaveBeenCalled();
  });
});
