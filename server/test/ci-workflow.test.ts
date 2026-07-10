/**
 * Hermetic tests for `ci/workflow.ts` — pure function, no DB/network.
 * Covers: standard `pull_request` trigger (never `pull_request_target`), the
 * fork-skip job-level `if:` guard, no inlined secret values, no
 * `DEVDIGEST_DIR`, and the `actions/upload-artifact@v4` step positioned
 * after the runner step (what makes the whole ingest half of the feature
 * reachable at all).
 */
import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { CI_RESULT_ARTIFACT_NAME } from '../src/modules/ci/helpers.js';
import { generateWorkflowYaml } from '../src/modules/ci/workflow.js';

interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
}

interface ParsedWorkflow {
  on: { pull_request?: { types: string[] }; pull_request_target?: unknown };
  jobs: { review: { if?: string; steps: WorkflowStep[] } };
}

function generate(overrides: Partial<{ triggers: string[]; postAs: 'github_review' | 'pr_comment' | 'none' }> = {}) {
  const yaml = generateWorkflowYaml({
    triggers: overrides.triggers ?? ['opened', 'synchronize'],
    postAs: overrides.postAs ?? 'github_review',
    resultArtifactName: CI_RESULT_ARTIFACT_NAME,
  });
  return { yaml, parsed: parseYaml(yaml) as ParsedWorkflow };
}

describe('generateWorkflowYaml — trigger', () => {
  it('sets on.pull_request.types to the given triggers', () => {
    const { parsed } = generate({ triggers: ['opened', 'synchronize', 'reopened'] });
    expect(parsed.on.pull_request?.types).toEqual(['opened', 'synchronize', 'reopened']);
  });

  it('never uses the pull_request_target variant', () => {
    const { parsed, yaml } = generate();
    expect(parsed.on.pull_request_target).toBeUndefined();
    expect(yaml).not.toContain('pull_request_target');
  });
});

describe('generateWorkflowYaml — fork skip guard', () => {
  it('adds a job-level if: guard comparing the PR head repo to the base repo', () => {
    const { parsed } = generate();
    expect(parsed.jobs.review.if).toBe(
      'github.event.pull_request.head.repo.full_name == github.repository',
    );
  });
});

describe('generateWorkflowYaml — runner step + secrets', () => {
  it('runs the runner via node .devdigest/runner/index.js with the expected env, never DEVDIGEST_DIR', () => {
    const { parsed, yaml } = generate({ postAs: 'pr_comment' });
    const steps = parsed.jobs.review.steps;
    const runnerStep = steps.find((s) => s.run === 'node .devdigest/runner/index.js');

    expect(runnerStep).toBeDefined();
    expect(runnerStep!.env).toMatchObject({
      OPENROUTER_API_KEY: '${{ secrets.OPENROUTER_API_KEY }}',
      GITHUB_TOKEN: '${{ secrets.GITHUB_TOKEN }}',
      DEVDIGEST_POST_AS: 'pr_comment',
    });
    expect(yaml).not.toContain('DEVDIGEST_DIR');
    expect(runnerStep!.env).not.toHaveProperty('DEVDIGEST_DIR');
  });

  it('never inlines a raw secret value — only the ${{ secrets.* }} template form', () => {
    const { yaml } = generate();
    expect(yaml).toContain('${{ secrets.OPENROUTER_API_KEY }}');
    expect(yaml).toContain('${{ secrets.GITHUB_TOKEN }}');
    // No bare "OPENROUTER_API_KEY: <something that isn't the template>" line.
    expect(yaml).not.toMatch(/OPENROUTER_API_KEY:\s*(?!\$\{\{)\S/);
  });
});

describe('generateWorkflowYaml — result artifact upload', () => {
  it('uploads via actions/upload-artifact@v4, positioned after the runner step', () => {
    const { parsed } = generate();
    const steps = parsed.jobs.review.steps;

    const runnerIndex = steps.findIndex((s) => s.run === 'node .devdigest/runner/index.js');
    const uploadIndex = steps.findIndex((s) => s.uses === 'actions/upload-artifact@v4');

    expect(runnerIndex).toBeGreaterThanOrEqual(0);
    expect(uploadIndex).toBeGreaterThan(runnerIndex);
  });

  it('references CI_RESULT_ARTIFACT_NAME as the artifact name, with if: always() and if-no-files-found: ignore', () => {
    const { parsed } = generate();
    const uploadStep = parsed.jobs.review.steps.find((s) => s.uses === 'actions/upload-artifact@v4')!;

    expect(uploadStep.with).toMatchObject({
      name: CI_RESULT_ARTIFACT_NAME,
      path: 'devdigest-result.json',
      'if-no-files-found': 'ignore',
    });
    expect(uploadStep.if).toBe('always()');
  });
});
