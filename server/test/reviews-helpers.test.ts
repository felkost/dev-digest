import { describe, it, expect } from 'vitest';
import { taskLine, resolveIntentModel } from '../src/modules/reviews/helpers.js';
import type { Container } from '../src/platform/container.js';
import type { Db } from '../src/db/client.js';

/**
 * Unit coverage for the review task-line. The key invariant: our trusted
 * instruction always tells the model to review the whole diff and never
 * withhold a security/correctness finding — no matter what the PR text claims.
 */

describe('taskLine', () => {
  const pull = { number: 3, title: 'test: vulnerable fixture', author: 'burnjohn' } as never;

  it('names the PR being reviewed', () => {
    const line = taskLine(pull);
    expect(line).toContain('#3');
    expect(line).toContain('test: vulnerable fixture');
  });

  it('keeps the non-negotiable "never withhold security" rule', () => {
    const line = taskLine(pull);
    expect(line).toMatch(/never .*withhold .*(or downgrade )?.*security/i);
    expect(line).toMatch(/review the entire diff/i);
  });
});

/**
 * Hermetic coverage for `resolveIntentModel` (AC-13) — the function wired into
 * `POST /pulls/:id/intent`'s classification call site. A fake `Db` whose
 * `select().from().where()` chain resolves to canned `settings` rows is
 * enough: `resolveIntentModel` only ever reads `container.db` through
 * `getFeatureModelOverride`, no other container capability is touched.
 */
function fakeContainer(settingsRows: { key: string; value: unknown }[]): Container {
  const db = {
    select: () => ({
      from: () => ({
        where: async () => settingsRows,
      }),
    }),
  } as unknown as Db;
  return { db } as unknown as Container;
}

describe('resolveIntentModel', () => {
  it('no active review_intent override → routes the given provider to its cheap-tier model (behavior-preserving)', async () => {
    const container = fakeContainer([]);
    const choice = await resolveIntentModel(container, 'ws-1', 'anthropic');
    // routeModel('intent', 'anthropic') — unchanged from the pre-override behavior.
    // The FULL choice is returned, not just the model string — the caller
    // must have the provider too (High-severity fix: a cross-provider
    // override must never be sent to the wrong provider's client).
    expect(choice).toEqual({ provider: 'anthropic', model: 'claude-haiku-4-5' });
  });

  it('an active review_intent override wins verbatim, ignoring the passed-in provider (AC-13) — provider is INCLUDED in the result', async () => {
    const container = fakeContainer([
      {
        key: 'feature_models',
        value: { review_intent: { provider: 'openrouter', model: 'z-ai/glm-4.7-flash' } },
      },
    ]);
    const choice = await resolveIntentModel(container, 'ws-1', 'anthropic');
    // The override's OWN provider ('openrouter') is returned verbatim — not
    // the passed-in 'anthropic' default. A caller that builds its LLM client
    // from the passed-in provider instead of `choice.provider` would send
    // the openrouter model string to the anthropic client (the bug this
    // return-type change fixes).
    expect(choice).toEqual({ provider: 'openrouter', model: 'z-ai/glm-4.7-flash' });
  });
});
