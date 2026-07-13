import type { PromptAssembly } from '@devdigest/shared';
import type { TokenCounter } from '../tokens.js';

/**
 * countPromptAssemblyBlocks — per-slot token report for a `PromptAssembly`
 * (the run trace's prompt record), for surfacing where a review's token
 * budget actually went.
 *
 * Fixed slot order matches `PromptAssembly`'s fields
 * (`server/src/vendor/shared/contracts/trace.ts`):
 *   system, skills, memory, specs, callers, repo_map, pr_description, user
 *
 * A slot whose value is null/undefined is OMITTED from the result entirely —
 * that means the slot was not part of this run's prompt. This is distinct
 * from `'unavailable'`, which means the slot WAS present but `countTokens`
 * threw while counting it. This function itself must never throw: each
 * `countTokens` call is individually wrapped in try/catch so one bad slot
 * can't take down the whole report.
 */
export function countPromptAssemblyBlocks(
  assembly: PromptAssembly,
  countTokens: TokenCounter,
): { block: string; tokens: number | 'unavailable' }[] {
  const slots: { block: string; value: string | null | undefined }[] = [
    { block: 'system', value: assembly.system },
    { block: 'skills', value: assembly.skills },
    { block: 'memory', value: assembly.memory },
    { block: 'specs', value: assembly.specs },
    { block: 'callers', value: assembly.callers },
    { block: 'repo_map', value: assembly.repo_map },
    { block: 'pr_description', value: assembly.pr_description },
    { block: 'user', value: assembly.user },
  ];

  const result: { block: string; tokens: number | 'unavailable' }[] = [];

  for (const { block, value } of slots) {
    if (value == null) continue;
    try {
      result.push({ block, tokens: countTokens(value) });
    } catch {
      result.push({ block, tokens: 'unavailable' });
    }
  }

  return result;
}
