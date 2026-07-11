/**
 * RunnerError — thrown for any pre-flight / configuration failure (missing or
 * invalid manifest, missing skill file, missing required env var, malformed CI
 * context). Distinguished from a plain `Error` only for clearer log messages;
 * both are handled identically by `runCi`'s single top-level catch (see
 * `run.ts`): hard-fail, no PR post, no artifact, non-zero exit (Q5).
 */
export class RunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunnerError';
  }
}

/**
 * PrDiffTooLargeError — GitHub's diff media type caps a PR at 300 changed files
 * and returns `406 { code: "too_large" }` for anything larger. Distinguished
 * from a plain `RunnerError` so `runCi` can DEGRADE GRACEFULLY (skip + comment
 * + exit 0) instead of hard-failing: a PR that's simply too big to fetch is not
 * a runner crash, and a red "Failed" check would wrongly block the author.
 */
export class PrDiffTooLargeError extends RunnerError {
  constructor(message: string) {
    super(message);
    this.name = 'PrDiffTooLargeError';
  }
}
