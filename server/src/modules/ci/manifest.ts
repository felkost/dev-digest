import { stringify } from 'yaml';
import type { CiFailOn, Provider, ReviewStrategy } from '@devdigest/shared';

/**
 * Minimal agent shape `agentManifestYaml` needs to build a manifest — a
 * deliberately small, module-local subset of the full `Agent` DTO (not
 * imported from the `agents` module — module isolation, backend-onion-architecture
 * R6/AP-4).
 */
export interface ManifestAgentInput {
  name: string;
  provider: Provider;
  model: string;
  systemPrompt: string;
  strategy: ReviewStrategy;
  ciFailOn: CiFailOn;
}

/**
 * Builds the `.devdigest/agents/<slug>.yaml` manifest content for one
 * installation.
 *
 * This is written to match `AgentManifest` (`@devdigest/shared`) exactly —
 * the CI runner (`agent-runner/src/manifest.ts`) parses this same YAML and
 * validates it against that identical Zod schema, so the studio and the
 * runner can never drift on what a manifest means.
 *
 * `provider` is ALWAYS hardcoded to `'openrouter'`, regardless of
 * `agent.provider` — the CI runner only ever instantiates
 * `OpenRouterProvider` at runtime and never reads this field to choose
 * between providers. Writing the agent's actual configured provider here
 * would misrepresent what the runner actually executes with.
 */
export function agentManifestYaml(agent: ManifestAgentInput, skillSlugs: string[]): string {
  const manifest = {
    name: agent.name,
    provider: 'openrouter' as const,
    model: agent.model,
    system_prompt: agent.systemPrompt,
    skills: skillSlugs,
    strategy: agent.strategy,
    ci_fail_on: agent.ciFailOn,
  };
  return stringify(manifest);
}
