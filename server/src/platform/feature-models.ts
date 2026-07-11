import { eq } from 'drizzle-orm';
import {
  FEATURE_MODELS,
  FeatureModelChoice,
  type FeatureModelId,
} from '@devdigest/shared';
import type { Container } from './container.js';
import * as t from '../db/schema.js';
import { routeModel, type TaskKind, type Provider } from './model-router.js';

/**
 * Per-feature model configuration.
 *
 * System LLM features (onboarding, intent, risk brief, conformance, conventions)
 * read their provider/model from the workspace's Settings instead of a hardcoded
 * module constant. When the workspace hasn't chosen one, we fall back to the
 * registry default in `FEATURE_MODELS` — which mirrors each module's old
 * constant, so behaviour is unchanged until a model is explicitly picked.
 *
 * Platform-layer copy: this file lives in `platform/` (not `modules/settings/`)
 * so that other modules (`reviews`, `onboarding`) can resolve feature models
 * without a forbidden `modules/*` → `modules/settings` cross-import. `platform/`
 * is the composition/platform layer and may read `container.db`/`db/schema.js`
 * directly, same as `platform/container.ts` and `platform/model-router.ts`.
 */

const DEFAULTS = Object.fromEntries(
  FEATURE_MODELS.map((f) => [f.id, { provider: f.defaultProvider, model: f.defaultModel }]),
) as Record<FeatureModelId, FeatureModelChoice>;

/** The registry default (provider+model) for a feature — no DB read. */
export function defaultFeatureModel(id: FeatureModelId): FeatureModelChoice {
  return DEFAULTS[id];
}

/**
 * The workspace's override for `id`, or `undefined` when unset/invalid. Callers
 * that keep their own dynamic default (e.g. conventions) use this directly so
 * that default is preserved; callers with a static default use
 * `resolveFeatureModel` instead.
 */
export async function getFeatureModelOverride(
  container: Container,
  workspaceId: string,
  id: FeatureModelId,
): Promise<FeatureModelChoice | undefined> {
  const rows = await container.db
    .select({ key: t.settings.key, value: t.settings.value })
    .from(t.settings)
    .where(eq(t.settings.workspaceId, workspaceId));
  const settingsMap: Record<string, unknown> = {};
  for (const r of rows) settingsMap[r.key] = r.value;
  const fm = (settingsMap as { feature_models?: Record<string, unknown> }).feature_models;
  const parsed = FeatureModelChoice.safeParse(fm?.[id]);
  return parsed.success ? parsed.data : undefined;
}

/** Resolve `id` to a concrete provider+model: workspace override, else registry default. */
export async function resolveFeatureModel(
  container: Container,
  workspaceId: string,
  id: FeatureModelId,
): Promise<FeatureModelChoice> {
  return (await getFeatureModelOverride(container, workspaceId, id)) ?? DEFAULTS[id];
}

/**
 * Resolve `featureModelId` to a concrete provider+model, folding in the
 * cost-routing table (`model-router.ts`): an explicit workspace override
 * always wins (returned verbatim, ignoring `provider`); otherwise the
 * caller-supplied `provider` is routed to a task-appropriate model via
 * `routeModel`. Using the caller-supplied `provider` (rather than a fixed
 * registry provider) preserves each call site's existing contextual provider
 * selection.
 */
export async function resolveRoutedFeatureModel(
  container: Container,
  workspaceId: string,
  featureModelId: FeatureModelId,
  task: TaskKind,
  provider: Provider,
): Promise<FeatureModelChoice> {
  const override = await getFeatureModelOverride(container, workspaceId, featureModelId);
  if (override) return override;
  return { provider, model: routeModel(task, provider) };
}
