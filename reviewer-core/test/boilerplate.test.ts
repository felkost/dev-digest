import { describe, it, expect } from 'vitest';
import type { UnifiedDiff } from '@devdigest/shared';
import { excludeBoilerplateFiles } from '../src/index.js';

/** Build a minimal, valid diff --git block for one file (no hunks needed —
 * `excludeBoilerplateFiles` only reads `diff.raw` + `diff.files[].path` via
 * `classifyFile`/`sliceDiff`, never the hunk contents). */
function block(path: string, body: string): string {
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${body}`;
}

function fileEntry(path: string): UnifiedDiff['files'][number] {
  return { path, additions: 1, deletions: 0, hunks: [] };
}

describe('excludeBoilerplateFiles', () => {
  it('excludes only the lock file from a mixed core+lock-file diff, preserving order', () => {
    const lockBlock = block('yarn.lock', '@@ -1,1 +1,2 @@\n dependencies:\n+  left-pad: "1.0.0"');
    const aBlock = block('src/services/a.ts', '@@ -1,1 +1,2 @@\n export function a() {}\n+// a');
    const bBlock = block('src/services/b.ts', '@@ -1,1 +1,2 @@\n export function b() {}\n+// b');

    const diff: UnifiedDiff = {
      raw: [lockBlock, aBlock, bBlock].join('\n'),
      files: [fileEntry('yarn.lock'), fileEntry('src/services/a.ts'), fileEntry('src/services/b.ts')],
    };

    const result = excludeBoilerplateFiles(diff);

    expect(result.excludedFiles).toEqual(['yarn.lock']);
    expect(result.diff.files.map((f) => f.path)).toEqual([
      'src/services/a.ts',
      'src/services/b.ts',
    ]);
    // Order preserved: a's block still precedes b's block in the rebuilt raw.
    expect(result.diff.raw).toBe([aBlock, bBlock].join('\n'));
    expect(result.diff.raw).not.toContain('yarn.lock');
    expect(result.excludedTokensEstimate).toBeGreaterThan(0);
  });

  it('regression: a kept file whose path is a PREFIX of an excluded file\'s path does not leak the excluded section into raw (Foo.tsx vs Foo.tsx.snap)', () => {
    const coreBlock = block('Foo.tsx', '@@ -1,1 +1,2 @@\n export function Foo() {}\n+// core change');
    const snapBlock = block(
      'Foo.tsx.snap',
      '@@ -1,1 +1,2 @@\n exports[`Foo renders`] = `<div />`;\n+// snapshot-only line, must never leak',
    );

    const diff: UnifiedDiff = {
      raw: [coreBlock, snapBlock].join('\n'),
      files: [fileEntry('Foo.tsx'), fileEntry('Foo.tsx.snap')],
    };

    const result = excludeBoilerplateFiles(diff);

    expect(result.diff.files.map((f) => f.path)).toEqual(['Foo.tsx']);
    expect(result.excludedFiles).toEqual(['Foo.tsx.snap']);
    // The excluded .snap section (including its own header line) must be
    // fully absent from the rebuilt raw — not just its unique content line.
    expect(result.diff.raw).not.toContain('Foo.tsx.snap');
    expect(result.diff.raw).not.toContain('snapshot-only line, must never leak');
    expect(result.diff.raw).toBe(coreBlock);
  });

  it('regression: a kept file whose path is a PREFIX of an excluded file\'s path does not leak the excluded section into raw (bundle.js vs bundle.js.map)', () => {
    const coreBlock = block('bundle.js', '@@ -1,1 +1,2 @@\n console.log("app");\n+// core change');
    const mapBlock = block(
      'bundle.js.map',
      '@@ -1,1 +1,2 @@\n {"version":3}\n+// sourcemap-only line, must never leak',
    );

    const diff: UnifiedDiff = {
      raw: [coreBlock, mapBlock].join('\n'),
      files: [fileEntry('bundle.js'), fileEntry('bundle.js.map')],
    };

    const result = excludeBoilerplateFiles(diff);

    expect(result.diff.files.map((f) => f.path)).toEqual(['bundle.js']);
    expect(result.excludedFiles).toEqual(['bundle.js.map']);
    expect(result.diff.raw).not.toContain('bundle.js.map');
    expect(result.diff.raw).not.toContain('sourcemap-only line, must never leak');
    expect(result.diff.raw).toBe(coreBlock);
  });

  it('returns the ORIGINAL diff object unchanged when nothing is boilerplate (zero-count case, never omitted)', () => {
    const aBlock = block('src/services/a.ts', '@@ -1,1 +1,2 @@\n export function a() {}\n+// a');
    const diff: UnifiedDiff = {
      raw: aBlock,
      files: [fileEntry('src/services/a.ts')],
    };

    const result = excludeBoilerplateFiles(diff);

    expect(result.diff).toBe(diff); // same object identity, not a rebuilt copy
    expect(result.excludedFiles).toEqual([]);
    expect(result.excludedTokensEstimate).toBe(0);
  });

  describe('designated fixture — large lock-file-style change', () => {
    // A "core" file with a small, fixed body, and a "lock" file whose body is
    // a large, deterministic block of repeated dependency lines (simulating a
    // real pnpm-lock.yaml diff). Both blocks are built from literal strings so
    // their `.length` is an independently-known, concrete number — the
    // assertions below don't call the counter on the same input twice, they
    // pin the exact reduction this fixture produces.
    const coreBody = '@@ -1,3 +1,4 @@\n function charge() {\n+  logStart();\n   return true;\n }';
    const coreBlock = block('src/services/payments.ts', coreBody);

    const lockDepLines = Array.from(
      { length: 50 },
      (_, i) => `+  "dep-${i}": "^1.0.${i}",`,
    ).join('\n');
    const lockBody = `@@ -1,1 +1,51 @@\n dependencies:\n${lockDepLines}`;
    const lockBlock = block('pnpm-lock.yaml', lockBody);

    const diff: UnifiedDiff = {
      raw: [coreBlock, lockBlock].join('\n'),
      files: [fileEntry('src/services/payments.ts'), { ...fileEntry('pnpm-lock.yaml'), additions: 50 }],
    };

    // A simple, deterministic stubbed counter (character count) — the point
    // is exercising that excludeBoilerplateFiles calls it per excluded file
    // and sums the result, not js-tiktoken's real BPE behavior.
    const stubCounter = (text: string): number => text.length;

    it('excludes the lock file and reports a concrete, asserted token reduction', () => {
      const result = excludeBoilerplateFiles(diff, stubCounter);

      expect(result.excludedFiles).toEqual(['pnpm-lock.yaml']);
      // The excluded block is captured verbatim by sliceDiff, so its stub
      // token count is exactly its own character length.
      expect(result.excludedTokensEstimate).toBe(lockBlock.length);

      // Concrete recorded numbers for this fixture (raw vs. post-exclusion):
      const rawTokens = stubCounter(diff.raw);
      const postExclusionTokens = stubCounter(result.diff.raw);
      expect(rawTokens).toBe(coreBlock.length + 1 + lockBlock.length); // +1 = joining '\n'
      expect(postExclusionTokens).toBe(coreBlock.length);
      expect(rawTokens - postExclusionTokens).toBe(lockBlock.length + 1);
      expect(result.excludedTokensEstimate).toBeGreaterThan(1000);
    });
  });
});
