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
            uses: 'actions/checkout@v4',
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
            uses: 'actions/upload-artifact@v4',
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
