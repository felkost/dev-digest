import { describe, it, expect, vi } from 'vitest';
import { Review } from '@devdigest/shared';
import { OpenRouterProvider } from '../src/llm/openrouter.js';

/**
 * Cost-surgery instrumentation: completeStructured extracts the OpenAI-compatible
 * cache-hit usage field (`usage.prompt_tokens_details.cached_tokens`, also proxied
 * through by OpenRouter for models that report it) into `StructuredResult.cachedTokens`
 * — without ever coercing a missing/unreported field to `0`. This adapter never marks
 * `cache_control` breakpoints (that's Anthropic-only), so `cacheControlApplied` must
 * stay unset here.
 */

const validInput = {
  verdict: 'approve',
  summary: 'looks fine',
  score: 90,
  findings: [],
};

function fakeChatCompletion(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'chatcmpl_1',
    choices: [{ message: { content: JSON.stringify(validInput) } }],
    usage: { prompt_tokens: 100, completion_tokens: 20 },
    ...overrides,
  };
}

/** Swap the provider's private `client.chat.completions.create` with a stub. */
function withStubbedCreate(provider: OpenRouterProvider, create: (...args: unknown[]) => unknown) {
  (
    provider as unknown as { client: { chat: { completions: { create: unknown } } } }
  ).client = { chat: { completions: { create } } };
}

describe('OpenRouterProvider completeStructured — cache-hit usage extraction', () => {
  it('extracts a reported prompt_tokens_details.cached_tokens value into cachedTokens', async () => {
    const provider = new OpenRouterProvider('test-key');
    const create = vi.fn().mockImplementationOnce(() =>
      Promise.resolve(
        fakeChatCompletion({
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            prompt_tokens_details: { cached_tokens: 42 },
          },
        }),
      ),
    );
    withStubbedCreate(provider, create);

    const result = await provider.completeStructured({
      model: 'openrouter/some-model',
      schema: Review,
      schemaName: 'Review',
      messages: [{ role: 'user', content: 'review this' }],
    });

    expect(result.cachedTokens).toBe(42);
    expect(result.cacheControlApplied).toBeUndefined();
  });

  it('cachedTokens stays undefined (not 0) when the mocked response omits prompt_tokens_details entirely', async () => {
    const provider = new OpenRouterProvider('test-key');
    // fakeChatCompletion's default usage has no `prompt_tokens_details` key at
    // all — the field is genuinely `undefined` at runtime and must NOT be
    // defaulted to 0.
    const create = vi.fn().mockImplementationOnce(() => Promise.resolve(fakeChatCompletion()));
    withStubbedCreate(provider, create);

    const result = await provider.completeStructured({
      model: 'openrouter/some-model',
      schema: Review,
      schemaName: 'Review',
      messages: [{ role: 'user', content: 'review this' }],
    });

    expect(result.cachedTokens).toBeUndefined();
    expect(result.cacheControlApplied).toBeUndefined();
  });

  it('cachedTokens stays undefined when prompt_tokens_details is present but cached_tokens itself is missing', async () => {
    const provider = new OpenRouterProvider('test-key');
    const create = vi.fn().mockImplementationOnce(() =>
      Promise.resolve(
        fakeChatCompletion({
          usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: {} },
        }),
      ),
    );
    withStubbedCreate(provider, create);

    const result = await provider.completeStructured({
      model: 'openrouter/some-model',
      schema: Review,
      schemaName: 'Review',
      messages: [{ role: 'user', content: 'review this' }],
    });

    expect(result.cachedTokens).toBeUndefined();
  });
});
