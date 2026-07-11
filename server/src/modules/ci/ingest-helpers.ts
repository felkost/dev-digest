import JSZip from 'jszip';
import { CiResultArtifact, type CiRunStatus } from '@devdigest/shared';

/**
 * Parse the CI result artifact zip downloaded from a GitHub Actions run.
 *
 * SECURITY BOUNDARY: this zip is produced by a target repo's own CI run — a
 * build process entirely outside DevDigest's control (a misconfigured or
 * tampered workflow could upload anything under that artifact name). This
 * function must NEVER throw: any failure (corrupt zip, no entry, malformed
 * JSON, schema mismatch) returns `null`, and the caller falls back to
 * GitHub's own reported run outcome (`status`/`conclusion`) only — the
 * artifact's content is never partially trusted.
 */
export async function parseResultArtifact(zipBuffer: Buffer): Promise<CiResultArtifact | null> {
  try {
    const zip = await JSZip.loadAsync(zipBuffer);
    // Don't assume a fixed filename inside the zip — take the first .json entry found.
    const entry = Object.values(zip.files).find(
      (f) => !f.dir && f.name.toLowerCase().endsWith('.json'),
    );
    if (!entry) return null;

    const text = await entry.async('string');
    const json: unknown = JSON.parse(text);
    const parsed = CiResultArtifact.safeParse(json);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Pure mapping from a GitHub Actions run's own reported outcome + the
 * (optionally) parsed result artifact to the `ci_runs.status` value the
 * ingest loop persists. No I/O, never throws.
 */
export function mapGithubRunToStatus(
  run: { status: string; conclusion: string | null },
  artifact: CiResultArtifact | null,
): CiRunStatus {
  if (run.status !== 'completed') return 'running';
  if (run.conclusion === 'skipped') return 'skipped_fork';
  if (artifact === null) {
    // Fallback: no artifact to trust — GitHub's own reported outcome only.
    return run.conclusion === 'success' ? 'no_findings' : 'failed';
  }
  // The review was SKIPPED, not run (e.g. the PR diff exceeded GitHub's
  // 300-file cap): surface it as its own status rather than a misleading clean
  // "no findings" (the runner exits 0 with an empty, skipped artifact).
  if (artifact.skipped_reason) return 'skipped_large';
  // An artifact exists = the review actually RAN and produced a grounded
  // result, so the DevDigest status is derived from the FINDINGS, not from the
  // GitHub run conclusion. A `failure` conclusion here means the `ci_fail_on`
  // gate requested changes and the runner exited non-zero BY DESIGN (so the
  // GitHub *check* blocks the PR) — that is a SUCCESSFUL review that surfaced
  // blocking findings, not a crash. "Failed" is reserved for a run that wrote
  // no artifact at all (the null branch above).
  return artifact.findings_count === 0 ? 'no_findings' : 'succeeded';
}
