/**
 * Unit tests for `SkillsService.stats`'s even-split dollar arithmetic (L08
 * Spec B, spec §8/§9 — `findings_by_category`).
 *
 * Hermetic: no Postgres, no Docker. `SkillsRepository.prototype` methods are
 * stubbed via `vi.spyOn` (same convention as `agents-promote.test.ts`) so the
 * pure arithmetic in the service (not the repository's raw-count query) is
 * exercised directly.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { SkillsService } from '../src/modules/skills/service.js';
import { SkillsRepository, type SkillStatsRaw } from '../src/modules/skills/repository.js';
import type { Container } from '../src/platform/container.js';
import type { SkillRow } from '../src/db/rows.js';

const WS_ID = '11111111-1111-1111-1111-111111111111';
const SKILL_ID = '22222222-2222-2222-2222-222222222222';

const SKILL_ROW: SkillRow = {
  id: SKILL_ID,
  workspaceId: WS_ID,
  name: 'Test Skill',
  description: '',
  type: 'rubric',
  source: 'manual',
  body: 'x',
  enabled: true,
  version: 1,
  evidenceFiles: null,
  createdAt: new Date('2026-01-01'),
};

function buildContainer(): Container {
  return { db: {} as never } as unknown as Container;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SkillsService.stats — findings_by_category even-split dollar estimate', () => {
  it('splits total known cost across categories proportionally to their share of the finding count', async () => {
    vi.spyOn(SkillsRepository.prototype, 'getById').mockResolvedValue(SKILL_ROW);
    const raw: SkillStatsRaw = {
      used_by: 1,
      pull_frequency_pct: 100,
      accept_rate_pct: 80,
      findings_30d: 4,
      agents: [{ id: 'a1', name: 'Agent 1' }],
      category_counts: [
        { category: 'security', count: 3 },
        { category: 'style', count: 1 },
      ],
      // 3 distinct contributing runs: $10, unknown, $2 → total known cost $12.
      contributing_run_costs: [10, null, 2],
    };
    vi.spyOn(SkillsRepository.prototype, 'stats').mockResolvedValue(raw);

    const service = new SkillsService(buildContainer());
    const stats = await service.stats(WS_ID, SKILL_ID);

    expect(stats.findings_by_category).toEqual([
      { category: 'security', estimated_cost_usd: 9 }, // 12 * 3/4
      { category: 'style', estimated_cost_usd: 3 }, // 12 * 1/4
    ]);
  });

  it('returns estimated_cost_usd: null for every category when every contributing run has unknown cost (AC-28)', async () => {
    vi.spyOn(SkillsRepository.prototype, 'getById').mockResolvedValue(SKILL_ROW);
    const raw: SkillStatsRaw = {
      used_by: 1,
      pull_frequency_pct: 100,
      accept_rate_pct: 50,
      findings_30d: 2,
      agents: [{ id: 'a1', name: 'Agent 1' }],
      category_counts: [
        { category: 'security', count: 1 },
        { category: 'correctness', count: 1 },
      ],
      contributing_run_costs: [null, null],
    };
    vi.spyOn(SkillsRepository.prototype, 'stats').mockResolvedValue(raw);

    const service = new SkillsService(buildContainer());
    const stats = await service.stats(WS_ID, SKILL_ID);

    expect(stats.findings_by_category).toEqual([
      { category: 'security', estimated_cost_usd: null },
      { category: 'correctness', estimated_cost_usd: null },
    ]);
  });

  it('returns an empty findings_by_category when there are zero findings in the trailing-30d window (AC-23)', async () => {
    vi.spyOn(SkillsRepository.prototype, 'getById').mockResolvedValue(SKILL_ROW);
    const raw: SkillStatsRaw = {
      used_by: 0,
      pull_frequency_pct: 0,
      accept_rate_pct: 0,
      findings_30d: 0,
      agents: [],
      category_counts: [],
      contributing_run_costs: [],
    };
    vi.spyOn(SkillsRepository.prototype, 'stats').mockResolvedValue(raw);

    const service = new SkillsService(buildContainer());
    const stats = await service.stats(WS_ID, SKILL_ID);

    expect(stats.findings_by_category).toEqual([]);
  });
});
