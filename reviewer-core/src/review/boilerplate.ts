import type { UnifiedDiff } from '@devdigest/shared';
import { classifyFile } from './classify.js';
import { approxTokens, type TokenCounter } from '../tokens.js';

/**
 * excludeBoilerplateFiles — drop boilerplate files (lockfiles, minified/
 * generated/dist output — see `classifyFile`) from a diff before it reaches
 * the LLM, so token budget and review attention go to the files that
 * actually matter.
 *
 * Pure (no I/O): rebuilds `raw` by walking `diff.raw` LINE BY LINE and
 * routing each `diff --git` section to a kept/excluded bucket by an EXACT
 * match of the parsed `b/<path>` header against the excluded-file set.
 *
 * This intentionally does NOT reuse `sliceDiff` (`reduce.ts`) — `sliceDiff`
 * matches sections by loose substring (`line.includes(\`b/${path}\`)`), so a
 * KEPT file whose path is a prefix of an EXCLUDED file's path (e.g. kept
 * `Foo.tsx` + excluded `Foo.tsx.snap`, or kept `bundle.js` + excluded
 * `bundle.js.map`) would cause slicing the kept file to also capture the
 * excluded file's section, leaking boilerplate content back into `raw`.
 * Exact per-section routing here avoids that class of bug entirely.
 *
 * Fail-safe: a `diff --git` header whose `b/<path>` cannot be parsed keeps
 * its section (never silently drops a non-boilerplate section). Preamble
 * before the first `diff --git` header also goes to kept.
 *
 * When nothing is excluded, the ORIGINAL `diff` object is returned unchanged
 * (no rebuild, no new object identity) — callers that compare by reference
 * stay correct.
 */
export function excludeBoilerplateFiles(
  diff: UnifiedDiff,
  countTokens?: TokenCounter,
): { diff: UnifiedDiff; excludedFiles: string[]; excludedTokensEstimate: number } {
  const kept: UnifiedDiff['files'] = [];
  const excluded: UnifiedDiff['files'] = [];

  for (const f of diff.files) {
    (classifyFile(f.path) === 'boilerplate' ? excluded : kept).push(f);
  }

  if (excluded.length === 0) {
    return { diff, excludedFiles: [], excludedTokensEstimate: 0 };
  }

  const excludedPaths = new Set(excluded.map((f) => f.path));

  const keptLines: string[] = [];
  const excludedLines: string[] = [];
  let target = keptLines; // preamble before the first `diff --git` header goes to kept

  for (const line of diff.raw.split('\n')) {
    if (line.startsWith('diff --git')) {
      const i = line.indexOf(' b/');
      const path = i >= 0 ? line.slice(i + 3) : '';
      // Unparseable header (i < 0) is fail-safe: keeps its section.
      target = i >= 0 && excludedPaths.has(path) ? excludedLines : keptLines;
    }
    target.push(line);
  }

  const count = countTokens ?? approxTokens;
  const raw = keptLines.join('\n');
  const excludedTokensEstimate = count(excludedLines.join('\n'));

  return {
    diff: { raw, files: kept },
    excludedFiles: excluded.map((f) => f.path),
    excludedTokensEstimate,
  };
}
