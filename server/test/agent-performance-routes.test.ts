/**
 * Route tests for the L08 Spec B "Agent Performance" endpoints:
 *   GET /agents/performance   — fleet-wide performance read
 *   GET /agents/:id/stats     — per-agent stats detail (base AgentStats + L08 additive fields)
 *
 * Hermetic: no Postgres, no Docker. `AgentsRepository.prototype` methods are
 * stubbed via `vi.spyOn` — the established convention in this suite (see
 * `agents-promote-route.test.ts`) for exercising the route → service → repository
 * wiring without a hand-rolled fake Drizzle `db`. The composition arithmetic
 * itself (accept_rate, cost deltas, zero-fill weeks, …) is unit-tested against
 * the service directly in `agent-performance-service.test.ts`; this file only
 * asserts the ROUTE layer: schema wiring, the `getContext` → service call, and
 * the 404 mapping for `GET /agents/:id/stats` (mirrors the existing
 * `GET /agents/:id` 404 pattern — never leaks another workspace's data).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { MockAuthProvider } from '../src/adapters/mocks.js';
import { AgentsRepository } from '../src/modules/agents/repository.js';
import type { FastifyInstance } from 'fastify';
import type { AgentRow } from '../src/db/rows.js';
import type { AgentPerf, AgentStatsDetail } from '@devdigest/shared';

const WS_ID = '22222222-2222-2222-2222-222222222222';
const AGENT_ID = '33333333-3333-3333-3333-333333333333';
const UNKNOWN_ID = '99999999-9999-9999-9999-999999999999';
const INVALID_ID = 'not-a-uuid';

const AGENT_ROW: AgentRow = {
  id: AGENT_ID,
  workspaceId: WS_ID,
  name: 'Test Agent',
  description: '',
  provider: 'openai',
  model: 'gpt-4.1',
  systemPrompt: 'You are a reviewer.',
  outputSchema: null,
  strategy: 'single-pass',
  ciFailOn: 'critical',
  repoIntel: true,
  enabled: true,
  version: 1,
  createdBy: null,
  createdAt: new Date('2026-01-01'),
};

const config = loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);

async function buildPerfApp(): Promise<FastifyInstance> {
  const mockAuth = new MockAuthProvider(
    { id: 'u1', email: 'you@local', name: 'You' },
    { id: WS_ID, name: 'default' },
  );
  return buildApp({ config, overrides: { auth: mockAuth } });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /agents/performance', () => {
  it('returns 200 with the composed AgentPerf shape (route wiring)', async () => {
    vi.spyOn(AgentsRepository.prototype, 'list').mockResolvedValue([AGENT_ROW]);
    vi.spyOn(AgentsRepository.prototype, 'runAggregatesByAgent').mockResolvedValue(
      new Map([
        [
          AGENT_ID,
          {
            runs: 5,
            totalCostUsd: 1.25,
            avgCostUsd: 0.25,
            avgLatencyMs: 1200,
            lastRunAt: new Date('2026-07-10T00:00:00Z'),
            costTrend: [0.1, 0.15, 0.2, 0.3, 0.5],
          },
        ],
      ]),
    );
    vi.spyOn(AgentsRepository.prototype, 'findingsAggregatesByAgent').mockResolvedValue(
      new Map([
        [
          AGENT_ID,
          {
            total: 10,
            accepted: 6,
            dismissed: 2,
            pending: 2,
            bySeverity: { CRITICAL: 1, WARNING: 4, SUGGESTION: 5 },
          },
        ],
      ]),
    );
    vi.spyOn(AgentsRepository.prototype, 'workspaceCostWindows').mockResolvedValue({
      totalRunsAllTime: 5,
      cost30d: 1.25,
      costPrior30d: 0.5,
      runs30d: 5,
    });
    vi.spyOn(AgentsRepository.prototype, 'mostActiveAgent30d').mockResolvedValue({
      agentId: AGENT_ID,
      agentName: 'Test Agent',
      runs30d: 5,
    });
    vi.spyOn(AgentsRepository.prototype, 'avgAcceptRate30d').mockResolvedValue(75);
    vi.spyOn(AgentsRepository.prototype, 'costByAgent30d').mockResolvedValue([
      { agentId: AGENT_ID, agentName: 'Test Agent', cost: 1.25 },
    ]);
    vi.spyOn(AgentsRepository.prototype, 'costByModel30d').mockResolvedValue([
      { model: 'gpt-4.1', cost: 1.25 },
    ]);

    const app = await buildPerfApp();
    const res = await app.inject({ method: 'GET', url: '/agents/performance' });
    await app.close();

    expect(res.statusCode).toBe(200);
    const body = res.json() as AgentPerf;
    expect(body.summary).toMatchObject({
      total_runs_all_time: 5,
      total_cost_usd_30d: 1.25,
      cost_delta_usd_30d: 0.75,
      avg_accept_rate_pct_30d: 75,
      most_active_agent: { agent_id: AGENT_ID, agent_name: 'Test Agent', runs_30d: 5 },
    });
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0]).toMatchObject({
      agent_id: AGENT_ID,
      agent_name: 'Test Agent',
      provider: 'openai',
      model: 'gpt-4.1',
      runs: 5,
      findings_total: 10,
      accepted: 6,
      dismissed: 2,
      accept_rate: 0.75,
      dismiss_rate: 0.25,
      avg_findings_per_run: 2,
      total_cost_usd: 1.25,
      avg_cost_usd: 0.25,
      avg_latency_ms: 1200,
      findings_by_severity: { CRITICAL: 1, WARNING: 4, SUGGESTION: 5 },
    });
    expect(body.cost_by_agent).toEqual([{ label: 'Test Agent', value: 1.25 }]);
    expect(body.cost_by_model).toEqual([{ label: 'gpt-4.1', value: 1.25 }]);
  });

  it('returns an empty agents list + null/zero summary when the workspace has no agents', async () => {
    vi.spyOn(AgentsRepository.prototype, 'list').mockResolvedValue([]);
    vi.spyOn(AgentsRepository.prototype, 'runAggregatesByAgent').mockResolvedValue(new Map());
    vi.spyOn(AgentsRepository.prototype, 'findingsAggregatesByAgent').mockResolvedValue(new Map());
    vi.spyOn(AgentsRepository.prototype, 'workspaceCostWindows').mockResolvedValue({
      totalRunsAllTime: 0,
      cost30d: null,
      costPrior30d: 0,
      runs30d: 0,
    });
    vi.spyOn(AgentsRepository.prototype, 'mostActiveAgent30d').mockResolvedValue(undefined);
    vi.spyOn(AgentsRepository.prototype, 'avgAcceptRate30d').mockResolvedValue(null);
    vi.spyOn(AgentsRepository.prototype, 'costByAgent30d').mockResolvedValue([]);
    vi.spyOn(AgentsRepository.prototype, 'costByModel30d').mockResolvedValue([]);

    const app = await buildPerfApp();
    const res = await app.inject({ method: 'GET', url: '/agents/performance' });
    await app.close();

    expect(res.statusCode).toBe(200);
    const body = res.json() as AgentPerf;
    expect(body.agents).toEqual([]);
    expect(body.summary).toMatchObject({
      total_runs_all_time: 0,
      total_cost_usd_30d: null,
      cost_delta_usd_30d: null,
      avg_accept_rate_pct_30d: null,
      most_active_agent: null,
    });
  });
});

describe('GET /agents/:id/stats', () => {
  function stubHappyPathRepo() {
    vi.spyOn(AgentsRepository.prototype, 'getById').mockResolvedValue(AGENT_ROW);
    vi.spyOn(AgentsRepository.prototype, 'runAggregatesByAgent').mockResolvedValue(
      new Map([
        [
          AGENT_ID,
          {
            runs: 5,
            totalCostUsd: 1.25,
            avgCostUsd: 0.25,
            avgLatencyMs: 1200,
            lastRunAt: new Date('2026-07-10T00:00:00Z'),
            costTrend: [0.1, 0.15],
          },
        ],
      ]),
    );
    vi.spyOn(AgentsRepository.prototype, 'findingsAggregatesByAgent').mockResolvedValue(
      new Map([
        [
          AGENT_ID,
          {
            total: 10,
            accepted: 6,
            dismissed: 2,
            pending: 2,
            bySeverity: { CRITICAL: 1, WARNING: 4, SUGGESTION: 5 },
          },
        ],
      ]),
    );
    vi.spyOn(AgentsRepository.prototype, 'costWindowsByAgent').mockResolvedValue(
      new Map([[AGENT_ID, { cost30d: 1.25, costPrior30d: 0.5, runs30d: 5 }]]),
    );
    vi.spyOn(AgentsRepository.prototype, 'weeklyFindingsBySeverity').mockResolvedValue([]);
    vi.spyOn(AgentsRepository.prototype, 'mostUsedSkillsApprox').mockResolvedValue([]);
    vi.spyOn(AgentsRepository.prototype, 'memoryPulledSummary').mockResolvedValue([]);
    vi.spyOn(AgentsRepository.prototype, 'runHistoryForAgent').mockResolvedValue([
      {
        run_id: 'r1',
        ran_at: '2026-07-01T00:00:00.000Z',
        status: 'done',
        cost_usd: 0.5,
        findings_count: 3,
        pr_number: 482,
      },
    ]);
  }

  it('returns 200 with the composed AgentStatsDetail shape when the agent exists in this workspace', async () => {
    stubHappyPathRepo();

    const app = await buildPerfApp();
    const res = await app.inject({ method: 'GET', url: `/agents/${AGENT_ID}/stats` });
    await app.close();

    expect(res.statusCode).toBe(200);
    const body = res.json() as AgentStatsDetail;
    expect(body).toMatchObject({
      agent_id: AGENT_ID,
      agent_name: 'Test Agent',
      runs: 5,
      findings_total: 10,
      accepted: 6,
      dismissed: 2,
      pending: 2,
      accept_rate: 0.75,
      dismiss_rate: 0.25,
      total_cost_usd: 1.25,
      cost_delta_usd_30d: 0.75,
      most_used_skills: [],
      memory_pulled_summary: [],
    });
    expect(body.weekly_findings_by_severity).toHaveLength(8);
    expect(body.run_history).toEqual([
      {
        run_id: 'r1',
        ran_at: '2026-07-01T00:00:00.000Z',
        status: 'done',
        cost_usd: 0.5,
        findings_count: 3,
        pr_number: 482,
      },
    ]);
  });

  it('returns 404 (not another workspace\'s data) for an unknown/cross-workspace agent id', async () => {
    vi.spyOn(AgentsRepository.prototype, 'getById').mockResolvedValue(undefined);
    const runAggSpy = vi.spyOn(AgentsRepository.prototype, 'runAggregatesByAgent');

    const app = await buildPerfApp();
    const res = await app.inject({ method: 'GET', url: `/agents/${UNKNOWN_ID}/stats` });
    await app.close();

    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body).toMatchObject({ error: { code: 'not_found', message: expect.any(String) } });
    // Workspace guard short-circuits BEFORE any stats aggregate is queried.
    expect(runAggSpy).not.toHaveBeenCalled();
  });

  it('returns 422 for a non-uuid id (edge validation, not a 404/500)', async () => {
    const app = await buildPerfApp();
    const res = await app.inject({ method: 'GET', url: `/agents/${INVALID_ID}/stats` });
    await app.close();

    expect(res.statusCode).toBe(422);
  });
});
