/**
 * Tool: get_blast_radius
 *
 * Read-only. Returns blast radius data for a PR.
 * Never fabricates — delegates to projectBlast which returns available:false for live PRs.
 *
 * Descriptor export shape (used by Step 6 server.ts):
 *   export const getBlastRadiusTool = { name, description, inputSchema, annotations, handler }
 */

import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { fetchBrief } from '../api-client.js';
import { projectBlast } from '../format.js';
import { apiErrorResult, jsonResult } from '../result.js';

const description =
  'Returns the blast radius of a pull request: which symbols changed, what downstream ' +
  'code depends on them, and which endpoints are affected. It is currently backed by ' +
  'pre-computed seed data only; for live PRs without it the tool returns `available:false` ' +
  'and never fabricates an answer. Use `get_findings` for verdicts and this tool only for ' +
  'impact mapping. Read-only; takes a `pr_id`.';

/**
 * inputSchema is a ZodRawShape (Record<string, ZodType>) — SDK v1.29.0 convention.
 */
const inputSchema = {
  pr_id: z.string().uuid().describe('PR UUID'),
} as const;

const annotations = {
  readOnlyHint: true,
  idempotentHint: true,
} as const;

async function handler(args: { pr_id: string }): Promise<CallToolResult> {
  const result = await fetchBrief(args.pr_id);
  if (!result.ok) return apiErrorResult(result);

  // projectBlast(null) → { available: false, reason: "..." }
  // projectBlast(brief) → { available: true, ... }
  // Never fabricates — the shape is always grounded in real data or explicit unavailability.
  return jsonResult(projectBlast(result.data));
}

/** Descriptor consumed by Step 6 (server.ts). */
export const getBlastRadiusTool = {
  name: 'get_blast_radius',
  description,
  inputSchema,
  annotations,
  handler,
} as const;
