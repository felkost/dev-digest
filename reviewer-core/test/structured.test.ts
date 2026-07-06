import { describe, it, expect } from 'vitest';
import { Review } from '@devdigest/shared';
import { toJsonSchema } from '../src/llm/structured.js';

/**
 * toJsonSchema must produce a FULLY self-contained JSON Schema — zero `$ref`
 * and zero `$defs`/`definitions` anywhere. OpenAI's `zodResponseFormat` (via
 * `$refStrategy: 'extract-to-root'`) hoists REUSED sub-schemas (e.g.
 * `TrifectaComponent`, reused by both `Finding.trifecta_components` and
 * `TrifectaEvidence.component`) into a root `$defs`/`definitions` container and
 * replaces reuse sites with `$ref` pointers. OpenAI/Anthropic/DeepSeek/Mistral
 * resolve `$ref` — Gemini (via OpenRouter) rejects it outright with HTTP 400
 * ("reference to undefined schema"). This gate pins that the engine always
 * ships a Gemini-safe, provider-agnostic schema.
 */

/** Recursively collect every `$ref`, `$defs`, and `definitions` key path found
 *  anywhere in a JSON Schema value (deep scan, arrays + objects). */
function scanForRefsAndDefs(node: unknown, path = '$'): string[] {
  const hits: string[] = [];
  if (Array.isArray(node)) {
    node.forEach((item, i) => hits.push(...scanForRefsAndDefs(item, `${path}[${i}]`)));
    return hits;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === '$ref' || key === '$defs' || key === 'definitions') {
        hits.push(`${path}.${key}`);
      }
      hits.push(...scanForRefsAndDefs(value, `${path}.${key}`));
    }
  }
  return hits;
}

describe('toJsonSchema — Gemini-safe fully self-contained schema', () => {
  const { schema } = toJsonSchema(Review, 'Review');

  it('contains no $ref, $defs, or definitions anywhere (deep scan)', () => {
    expect(scanForRefsAndDefs(schema)).toEqual([]);
  });

  it('inlines the reused TrifectaComponent sub-schema at findings[].evidence[].component', () => {
    const props = schema['properties'] as Record<string, unknown>;
    const findings = props['findings'] as Record<string, unknown>;
    const findingItem = findings['items'] as Record<string, unknown>;
    const findingProps = findingItem['properties'] as Record<string, unknown>;
    const evidence = findingProps['evidence'] as Record<string, unknown>;
    // `evidence` is `.nullish()` → anyOf [array, null]; index 0 is the array branch.
    const evidenceAnyOf = evidence['anyOf'] as Record<string, unknown>[];
    const evidenceArray = evidenceAnyOf[0]!;
    const evidenceItems = evidenceArray['items'] as Record<string, unknown>;
    const evidenceItemProps = evidenceItems['properties'] as Record<string, unknown>;
    const component = evidenceItemProps['component'];

    // Must be an inline enum object, NOT `{ $ref: '#/$defs/...' }` or similar.
    expect(component).toBeDefined();
    expect(component).not.toHaveProperty('$ref');
    expect(component).toMatchObject({
      type: 'string',
      enum: ['private_data_access', 'untrusted_input', 'exfil_path'],
    });
  });

  it('preserves strict-mode constraints at the root (additionalProperties, required)', () => {
    expect(schema['additionalProperties']).toBe(false);
    expect(schema['required']).toEqual(
      expect.arrayContaining(['verdict', 'summary', 'score', 'findings']),
    );
  });

  it('verdict is required-but-nullable (no bare .optional() SDK warning)', () => {
    const props = schema['properties'] as Record<string, unknown>;
    const verdict = props['verdict'] as Record<string, unknown>;
    // Verdict.nullable() on an enum compiles to an anyOf [enum, null] branch.
    const anyOf = verdict['anyOf'] as Record<string, unknown>[] | undefined;
    const hasNullBranch = anyOf?.some((b) => b['type'] === 'null') ?? verdict['nullable'] === true;
    expect(hasNullBranch).toBe(true);
    expect(schema['required']).toContain('verdict');
  });
});
