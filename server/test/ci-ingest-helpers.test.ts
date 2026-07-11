/**
 * Hermetic tests for `ci/ingest-helpers.ts` — artifact validation (zip → JSON
 * → Zod) and the pure GitHub-run-to-status mapping. No Postgres, no Docker.
 */
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { parseResultArtifact, mapGithubRunToStatus } from '../src/modules/ci/ingest-helpers.js';
import type { CiResultArtifact } from '@devdigest/shared';

function makeArtifact(overrides: Partial<CiResultArtifact> = {}): CiResultArtifact {
  return {
    findings_count: 3,
    critical: 1,
    warning: 2,
    suggestion: 0,
    cost_usd: 0.05,
    duration_ms: 12345,
    agent: 'Security Reviewer',
    version: '1.0.0',
    pr_number: 42,
    ...overrides,
  };
}

async function zipOf(filename: string, contents: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(filename, contents);
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('parseResultArtifact', () => {
  it('parses a valid zip containing a well-formed JSON artifact', async () => {
    const artifact = makeArtifact();
    const buf = await zipOf('devdigest-result.json', JSON.stringify(artifact));

    const result = await parseResultArtifact(buf);

    expect(result).toEqual(artifact);
  });

  it('returns null for a corrupt (non-zip) buffer, never throws', async () => {
    const corrupt = Buffer.from('this is definitely not a zip file');

    await expect(parseResultArtifact(corrupt)).resolves.toBeNull();
  });

  it('returns null when the zip is valid but the JSON fails CiResultArtifact validation', async () => {
    // Missing required `findings_count`/`agent`, wrong types elsewhere.
    const invalid = { cost_usd: 'not-a-number', foo: 'bar' };
    const buf = await zipOf('devdigest-result.json', JSON.stringify(invalid));

    await expect(parseResultArtifact(buf)).resolves.toBeNull();
  });

  it('returns null when the zip has no .json entry at all', async () => {
    const zip = new JSZip();
    zip.file('devdigest-result.txt', 'not json');
    const buf = await zip.generateAsync({ type: 'nodebuffer' });

    await expect(parseResultArtifact(buf)).resolves.toBeNull();
  });

  it('finds the artifact JSON regardless of the exact filename inside the zip', async () => {
    const artifact = makeArtifact({ findings_count: 0 });
    // A differently-named .json entry should still be picked up.
    const buf = await zipOf('some-other-name.json', JSON.stringify(artifact));

    const result = await parseResultArtifact(buf);

    expect(result).toEqual(artifact);
  });

  it('returns null when the JSON entry contains malformed JSON text', async () => {
    const buf = await zipOf('devdigest-result.json', '{ this is not valid json ');

    await expect(parseResultArtifact(buf)).resolves.toBeNull();
  });
});

describe('mapGithubRunToStatus', () => {
  const artifact = makeArtifact();

  it('maps a non-completed run to "running", regardless of artifact', () => {
    expect(mapGithubRunToStatus({ status: 'in_progress', conclusion: null }, null)).toBe('running');
    expect(mapGithubRunToStatus({ status: 'queued', conclusion: null }, artifact)).toBe('running');
  });

  it('maps a completed+skipped run to "skipped_fork"', () => {
    expect(mapGithubRunToStatus({ status: 'completed', conclusion: 'skipped' }, null)).toBe(
      'skipped_fork',
    );
    expect(mapGithubRunToStatus({ status: 'completed', conclusion: 'skipped' }, artifact)).toBe(
      'skipped_fork',
    );
  });

  it('fallback (no artifact): maps completed+success to "no_findings"', () => {
    expect(mapGithubRunToStatus({ status: 'completed', conclusion: 'success' }, null)).toBe(
      'no_findings',
    );
  });

  it('fallback (no artifact): maps completed+non-success (e.g. failure) to "failed"', () => {
    expect(mapGithubRunToStatus({ status: 'completed', conclusion: 'failure' }, null)).toBe('failed');
    expect(mapGithubRunToStatus({ status: 'completed', conclusion: 'cancelled' }, null)).toBe('failed');
  });

  it('with artifact: a `failure` conclusion + findings maps to "succeeded" (the ci_fail_on gate exits non-zero BY DESIGN to block the PR — a review that surfaced findings is a success, not a crash)', () => {
    expect(
      mapGithubRunToStatus(
        { status: 'completed', conclusion: 'failure' },
        makeArtifact({ findings_count: 5 }),
      ),
    ).toBe('succeeded');
  });

  it('with artifact: a skipped_reason (diff_too_large) maps to "skipped_large", ahead of the findings check', () => {
    expect(
      mapGithubRunToStatus(
        { status: 'completed', conclusion: 'success' },
        makeArtifact({ findings_count: 0, skipped_reason: 'diff_too_large' }),
      ),
    ).toBe('skipped_large');
  });

  it('with artifact: maps completed+non-failure with zero findings to "no_findings"', () => {
    expect(
      mapGithubRunToStatus(
        { status: 'completed', conclusion: 'success' },
        makeArtifact({ findings_count: 0 }),
      ),
    ).toBe('no_findings');
  });

  it('with artifact: maps completed+non-failure with findings to "succeeded"', () => {
    expect(
      mapGithubRunToStatus(
        { status: 'completed', conclusion: 'success' },
        makeArtifact({ findings_count: 4 }),
      ),
    ).toBe('succeeded');
  });
});
