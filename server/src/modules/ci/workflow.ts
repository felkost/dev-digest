import { stringify } from 'yaml';

export interface GenerateWorkflowYamlParams {
  triggers: string[];
  postAs: 'github_review' | 'pr_comment' | 'none';
  /**
   * Name of the GitHub Actions artifact the upload step publishes under.
   * Callers must pass `CI_RESULT_ARTIFACT_NAME` (from `./helpers.js`) here.
   *
   * This is a parameter rather than a direct import of that constant on
   * purpose: `helpers.ts`'s `composeCiFiles` already imports
   * `generateWorkflowYaml` from this file, so this file importing
   * `CI_RESULT_ARTIFACT_NAME` back from `helpers.ts` would create a circular
   * module dependency between the two (backend-onion-architecture R6 forbids
   * circular imports between any two files, without a layer exception).
   * Taking the name as an explicit input keeps the dependency one-way
   * (`helpers.ts` → `workflow.ts`) while still guaranteeing both the
   * generated upload step and Step 8's later download-by-name selection read
   * from the exact same single source of truth — never a string literal
   * duplicated in two places.
   */
  resultArtifactName: string;
}

/**
 * Generates the `.github/workflows/devdigest-review.yml` content for one
 * installation (flat layout, v1 — one agent per repository, so no
 * `DEVDIGEST_DIR` override is ever needed; the runner's own default
 * `.devdigest` directory is already correct for this layout).
 */
export function generateWorkflowYaml(params: GenerateWorkflowYamlParams): string {
  const workflow = {
    name: 'DevDigest Review',
    on: {
      pull_request: {
        types: params.triggers,
      },
    },
    // Least-privilege GITHUB_TOKEN: the runner READs the repo (checkout) and
    // WRITES to the pull request (post the review / PR comment). Without this,
    // GitHub's default read-only token makes posting a comment fail with
    // `403 Resource not accessible by integration` — the whole job then exits 1.
    // `pull-requests: write` covers both a GitHub review and a PR conversation
    // comment (a PR is an issue, so its comments fall under this scope).
    permissions: {
      contents: 'read',
      'pull-requests': 'write',
    },
    jobs: {
      review: {
        'runs-on': 'ubuntu-latest',
        // Fork PRs never receive repository secrets under the standard
        // `pull_request` trigger (only `pull_request_target` would, and that
        // variant is never used here) — skip the job entirely rather than
        // let it run and fail for a reason invisible to an external
        // contributor.
        if: 'github.event.pull_request.head.repo.full_name == github.repository',
        steps: [
          {
            name: 'Checkout',
            // @v5 runs on Node.js 24. @v4 targets Node.js 20, which GitHub is
            // deprecating on Actions runners — it emits a "Node.js 20 is
            // deprecated" annotation on every review run (forced onto Node 24
            // anyway). Pinning the Node-24 major keeps the run warning-free.
            uses: 'actions/checkout@v5',
          },
          {
            name: 'Run DevDigest review',
            run: 'node .devdigest/runner/index.js',
            env: {
              OPENROUTER_API_KEY: '${{ secrets.OPENROUTER_API_KEY }}',
              GITHUB_TOKEN: '${{ secrets.GITHUB_TOKEN }}',
              DEVDIGEST_POST_AS: params.postAs,
            },
          },
          {
            name: 'Upload DevDigest result',
            // Upload even when the runner step exits non-zero (a
            // REQUEST_CHANGES gate) — ingest needs the result on a failing
            // check too, not only a passing one. A true hard-crash run that
            // wrote no result file at all must not fail this step itself.
            if: 'always()',
            // @v6 runs on Node.js 24. Unlike checkout (node24 since @v5),
            // upload-artifact@v5 still declares node20 and keeps emitting the
            // "Node.js 20 is deprecated" annotation — so this step specifically
            // needs @v6, not @v5.
            uses: 'actions/upload-artifact@v6',
            with: {
              name: params.resultArtifactName,
              path: 'devdigest-result.json',
              'if-no-files-found': 'ignore',
            },
          },
        ],
      },
    },
  };
  return stringify(workflow);
}
