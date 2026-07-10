/**
 * Hermetic tests for `ci/manifest.ts` — pure function, no DB/network.
 * Covers: `provider` is always hardcoded to `openrouter` regardless of the
 * input agent's configured provider, the rest of the fields map through
 * correctly, and the output validates against the shared `AgentManifest`
 * schema (the same schema `agent-runner/src/manifest.ts` parses against).
 */
import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { AgentManifest } from '@devdigest/shared';
import { agentManifestYaml, type ManifestAgentInput } from '../src/modules/ci/manifest.js';

function makeAgent(overrides: Partial<ManifestAgentInput> = {}): ManifestAgentInput {
  return {
    name: 'Security Reviewer',
    provider: 'openai',
    model: 'gpt-4o',
    systemPrompt: 'Review PRs for security issues.',
    strategy: 'single-pass',
    ciFailOn: 'critical',
    ...overrides,
  };
}

describe('agentManifestYaml — provider is always openrouter', () => {
  it.each(['openai', 'anthropic', 'openrouter'] as const)(
    'writes provider: openrouter even when the agent is configured with provider=%s',
    (provider) => {
      const yaml = agentManifestYaml(makeAgent({ provider }), []);
      const parsed = parseYaml(yaml) as Record<string, unknown>;
      expect(parsed.provider).toBe('openrouter');
    },
  );
});

describe('agentManifestYaml — field mapping', () => {
  it('maps name/model/systemPrompt/strategy/ciFailOn and the given skill slugs', () => {
    const agent = makeAgent({
      name: 'My Agent',
      model: 'gpt-4o-mini',
      systemPrompt: 'Be thorough.',
      strategy: 'map-reduce',
      ciFailOn: 'warning',
    });
    const yaml = agentManifestYaml(agent, ['security-practices', 'style-guide']);
    const parsed = parseYaml(yaml) as Record<string, unknown>;

    expect(parsed).toMatchObject({
      name: 'My Agent',
      model: 'gpt-4o-mini',
      system_prompt: 'Be thorough.',
      strategy: 'map-reduce',
      ci_fail_on: 'warning',
      skills: ['security-practices', 'style-guide'],
    });
  });

  it('produces an empty skills array when given no skill slugs', () => {
    const yaml = agentManifestYaml(makeAgent(), []);
    const parsed = parseYaml(yaml) as Record<string, unknown>;
    expect(parsed.skills).toEqual([]);
  });
});

describe('agentManifestYaml — validates against the shared AgentManifest schema', () => {
  it('parses and safeParses successfully — the same validation the CI runner performs', () => {
    const yaml = agentManifestYaml(makeAgent(), ['a-skill']);
    const parsed = parseYaml(yaml);
    const result = AgentManifest.safeParse(parsed);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.provider).toBe('openrouter');
    }
  });
});
