import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { RunRequest } from '@devdigest/shared';
import { getContext } from '../_shared/context.js';
import { IdParams } from '../_shared/schemas.js';
import { AppError, NotFoundError } from '../../platform/errors.js';
import { MultiRunService } from './multi-run.service.js';
import { MULTI_AGENT_RUN_RATE_LIMIT } from './constants.js';

/**
 * Multi-Agent Review routes — a sibling sub-plugin (mirrors
 * `smart-diff.routes.ts`'s pattern) rather than more routes appended to the
 * already-large `reviews/routes.ts`.
 *
 * POST /pulls/:id/multi-agent-run   {agentIds}  → start a fan-out group
 * GET  /multi-agent-runs/:id                    → composed columns + conflicts
 * GET  /pulls/:id/agent-estimates               → per-agent cost/duration estimate
 */
export default async function multiRunRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const { container } = app;
  const service = new MultiRunService(container);

  // ---- Start a multi-agent fan-out run -------------------------------------
  // Tight per-route limit, same shape as `/pulls/:id/review` — each call can
  // fan out to N concurrent LLM runs.
  app.post(
    '/pulls/:id/multi-agent-run',
    { schema: { params: IdParams, body: RunRequest }, config: { rateLimit: MULTI_AGENT_RUN_RATE_LIMIT } },
    async (req) => {
      const { workspaceId } = await getContext(container, req);
      if (!req.body.agentIds || req.body.agentIds.length === 0) {
        throw new AppError('invalid_run_request', 'Provide agentIds (non-empty)', 400);
      }
      return service.startRun(workspaceId, req.params.id, req.body.agentIds, req.log);
    },
  );

  // ---- Composed multi-agent run (columns + cross-agent conflicts) ---------
  app.get('/multi-agent-runs/:id', { schema: { params: IdParams } }, async (req) => {
    const { workspaceId } = await getContext(container, req);
    const result = await service.getComposedRun(workspaceId, req.params.id);
    if (!result) throw new NotFoundError('Multi-agent run not found');
    return result;
  });

  // ---- Pre-run cost/duration estimate per enabled agent --------------------
  app.get('/pulls/:id/agent-estimates', { schema: { params: IdParams } }, async (req) => {
    const { workspaceId } = await getContext(container, req);
    return service.estimatesForPr(workspaceId, req.params.id);
  });
}
