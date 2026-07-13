import { describe, it, expect } from 'vitest';
import { countTokens } from '../src/index.js';

/**
 * countTokens — the canonical token counter (js-tiktoken cl100k_base, with a
 * permanent ceil(chars/4) fallback on encoder failure). Pins the two
 * behavioral invariants callers depend on: non-empty text always counts to a
 * positive integer, and an empty string counts to exactly 0.
 */
describe('countTokens', () => {
  it('returns a positive integer for non-empty text', () => {
    const n = countTokens('The quick brown fox jumps over the lazy dog.');
    expect(Number.isInteger(n)).toBe(true);
    expect(n).toBeGreaterThan(0);
  });

  it('returns 0 for an empty string', () => {
    expect(countTokens('')).toBe(0);
  });
});
