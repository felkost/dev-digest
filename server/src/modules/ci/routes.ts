import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  CiExportPreviewInput,
  CiExportPreview,
  CiExportInput,
  CiExport,
  CiBulkUpdateResult,
  CiDisconnectResult,
  CiAgentSurface,
  CiRunsResponse,
  CiCheckResult,
} from '@devdigest/shared';
import { getContext } from '../_shared/context.js';
import { IdParams } from '../_shared/schemas.js';
import { NotFoundError } from '../../platform/errors.js';
import { ExportService } from './export-service.js';
import { IngestService } from './ingest-service.js';

/**
 * `POST /repos/:repoId/agents/:agentId/...` param shape — specific to this
 * module's two producer routes, not added to `_shared/schemas.ts` (Step 11,
 * per the plan: this shape has no other consumer).
 */
const RepoAgentParams = z.object({
  repoId: z.string().uuid(),
  agentId: z.string().uuid(),
});

/** `GET /ci/runs` filters — all optional, `since_days` coerced from a query string. */
const CiRunsQuery = z.object({
  agent_id: z.string().uuid().optional(),
  repo: z.string().optional(),
  status: z.string().optional(),
  since_days: z.coerce.number().int().optional(),
});

/**
 * ci module — Export-to-CI producer + ingest (Export-to-CI plan, Step 11).
 * Mirrors `blast/routes.ts`'s shape: thin handlers, `getContext` first,
 * delegate to a service, return.
 *
 *   POST /repos/:repoId/agents/:agentId/ci/preview  → no-side-effect file preview
 *   POST /repos/:repoId/agents/:agentId/export-ci   → publish (open_pr | files)
 *   POST /agents/:id/ci/bulk-update                 → refresh every non-disconnected installation
 *   POST /ci/installations/:id/disconnect           → stop tracking (no file writes)
 *   GET  /agents/:id/ci                             → agent-level CI surface (7-day rollup)
 *   GET  /ci/runs                                   → run history (filterable)
 *   POST /ci/check                                  → pull new results from GitHub Actions
 */
export default async function ciRoutes(appBase: FastifyInstance): Promise<void> {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const { container } = app;
  const exportService = new ExportService(container);
  const ingestService = new IngestService(container);

  // ---- Preview: no DB write, no GitHub call (AC-34/35/36/38) --------------
  app.post(
    '/repos/:repoId/agents/:agentId/ci/preview',
    {
      schema: {
        params: RepoAgentParams,
        body: CiExportPreviewInput,
        response: { 200: CiExportPreview },
      },
    },
    async (req) => {
      const { workspaceId } = await getContext(container, req);
      return exportService.previewFiles(
        workspaceId,
        req.params.repoId,
        req.params.agentId,
        req.body,
      );
    },
  );

  // ---- Publish: commits/opens a PR (or just returns files) + persists -----
  // Rate-limited per-workspace (not per-IP) — mirrors reviews/routes.ts's
  // `brief-generate` keyGenerator pattern exactly (AC-15).
  app.post(
    '/repos/:repoId/agents/:agentId/export-ci',
    {
      schema: {
        params: RepoAgentParams,
        body: CiExportInput,
        response: { 200: CiExport },
      },
      config: {
        rateLimit: {
          max: 2,
          timeWindow: '1 minute',
          keyGenerator: async (req: import('fastify').FastifyRequest) => {
            const { workspaceId } = await getContext(container, req);
            return `ci-export:${workspaceId}`;
          },
        },
      },
    },
    async (req) => {
      const { workspaceId } = await getContext(container, req);
      return exportService.exportInstallation(
        workspaceId,
        req.params.repoId,
        req.params.agentId,
        req.body,
      );
    },
  );

  // ---- Bulk update: refresh every installation's config (AC-40/41/48) -----
  app.post(
    '/agents/:id/ci/bulk-update',
    {
      schema: { params: IdParams, response: { 200: CiBulkUpdateResult } },
      config: {
        rateLimit: {
          max: 2,
          timeWindow: '1 minute',
          keyGenerator: async (req: import('fastify').FastifyRequest) => {
            const { workspaceId } = await getContext(container, req);
            return `ci-bulk-update:${workspaceId}`;
          },
        },
      },
    },
    async (req) => {
      const { workspaceId } = await getContext(container, req);
      return exportService.bulkUpdate(workspaceId, req.params.id);
    },
  );

  // ---- Disconnect: stop tracking only, no repo side effect (AC-14) --------
  app.post(
    '/ci/installations/:id/disconnect',
    { schema: { params: IdParams, response: { 200: CiDisconnectResult } } },
    async (req) => {
      const { workspaceId } = await getContext(container, req);
      return exportService.disconnect(workspaceId, req.params.id);
    },
  );

  // ---- Agent-level CI surface: installations + 7-day rollup (AC-29/46/47) -
  app.get(
    '/agents/:id/ci',
    { schema: { params: IdParams, response: { 200: CiAgentSurface } } },
    async (req) => {
      const { workspaceId } = await getContext(container, req);
      // `ExportService.getAgentCiSurface` never 404s on a missing/cross-workspace
      // agent by itself (an absent agentId simply yields empty aggregates via
      // `listByAgent`'s workspace-scoped filter) — this route-level guard is
      // what actually satisfies AC-32 for this endpoint, mirroring
      // reviews/routes.ts's `POST /repos/:id/review-all` precedent of a direct
      // workspace-scoped existence check before delegating to the service.
      const agent = await container.agentsRepo.getById(workspaceId, req.params.id);
      if (!agent) throw new NotFoundError('Agent not found');
      return exportService.getAgentCiSurface(workspaceId, req.params.id);
    },
  );

  // ---- Run history: filterable by agent/repo/status/recency (AC-23/25) ----
  app.get(
    '/ci/runs',
    { schema: { querystring: CiRunsQuery, response: { 200: CiRunsResponse } } },
    async (req) => {
      const { workspaceId } = await getContext(container, req);
      const { agent_id, repo, status, since_days } = req.query;
      return ingestService.listRuns(workspaceId, {
        ...(agent_id !== undefined ? { agentId: agent_id } : {}),
        ...(repo !== undefined ? { repo } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(since_days !== undefined ? { sinceDays: since_days } : {}),
      });
    },
  );

  // ---- Check: pull new GitHub Actions results (AC-16/17/26/27) ------------
  app.post(
    '/ci/check',
    {
      schema: { response: { 200: CiCheckResult } },
      config: {
        rateLimit: {
          max: 2,
          timeWindow: '1 minute',
          keyGenerator: async (req: import('fastify').FastifyRequest) => {
            const { workspaceId } = await getContext(container, req);
            return `ci-check:${workspaceId}`;
          },
        },
      },
    },
    async (req) => {
      const { workspaceId } = await getContext(container, req);
      return ingestService.checkForNewResults(workspaceId);
    },
  );
}
