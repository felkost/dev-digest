/**
 * seed-disagreement.test.ts — proves the Multi-Agent Review demo seed (Step 5,
 * `server/src/db/seed.ts`) produces a GENUINE cross-agent disagreement, not
 * just plausible-looking fixture data. Pure/hermetic: no DB, no container —
 * builds `MatcherColumn[]` mirroring the exact seeded findings (file/
 * start_line/severity/title/rationale) for the Security Reviewer, Performance
 * Reviewer, and Architecture Reviewer's grouped run on PR #482, and feeds them
 * through the real `computeConflicts` (Step 3) — the same matcher the live
 * multi-agent view uses. Verifies AC-29 (consumed by AC-42): at least one
 * location where one agent flagged and another silently did not, plus a
 * second location where two agents flagged the same spot at different
 * severities.
 */
import { describe, it, expect } from 'vitest';
import { computeConflicts, type MatcherColumn } from '../src/modules/reviews/conflict-matcher.js';

// Mirrors the exact three agent_runs/reviews/findings seeded in seed.ts's
// "Multi-Agent Review demo" block for PR #482 (~seed.ts, after the built-in
// agents' upsert loop). Keep in sync if that block's finding data changes.
const seededColumns: MatcherColumn[] = [
  {
    agent_id: 'security-reviewer',
    agent_name: 'Security Reviewer',
    status: 'done',
    findings: [
      {
        file: 'src/api/public/webhooks.ts',
        start_line: 16,
        severity: 'CRITICAL',
        title: 'SSRF via unvalidated webhook callback URL',
        rationale:
          'The webhook handler forwards to payload.callbackUrl with no allow-list, letting a caller redirect delivery to an internal address.',
      },
    ],
  },
  {
    agent_id: 'performance-reviewer',
    agent_name: 'Performance Reviewer',
    status: 'done',
    // Deliberately NO finding at src/api/public/webhooks.ts:16 — the
    // Performance Reviewer silently did not flag the SSRF location the
    // Security Reviewer flagged. Its own finding is at a different location.
    findings: [
      {
        file: 'src/api/users.ts',
        start_line: 45,
        severity: 'WARNING',
        title: 'N+1 query in user list endpoint',
        rationale:
          'Loop issues one query per user under the new rate limiter middleware, scaling with request volume.',
      },
    ],
  },
  {
    agent_id: 'architecture-reviewer',
    agent_name: 'Architecture Reviewer',
    status: 'done',
    // Flags the SAME location as the Security Reviewer, but at a DIFFERENT
    // severity — the second, richer disagreement example.
    findings: [
      {
        file: 'src/api/public/webhooks.ts',
        start_line: 16,
        severity: 'WARNING',
        title: 'Webhook handler reaches outside its layer to deliver payloads directly',
        rationale:
          'The route-level webhook handler performs outbound delivery itself instead of delegating to a service — the same code path the Security Reviewer already flags as a CRITICAL SSRF risk.',
      },
    ],
  },
];

describe('Multi-Agent Review demo seed — genuine cross-agent disagreement (AC-29/AC-42)', () => {
  it('finds a location where one agent flagged and another silently did not', () => {
    const conflicts = computeConflicts(seededColumns);

    const webhookConflict = conflicts.find(
      (c) => c.file === 'src/api/public/webhooks.ts' && c.line === 16,
    );
    expect(webhookConflict).toBeDefined();

    const performanceTake = webhookConflict!.takes.find((t) => t.agent_id === 'performance-reviewer');
    expect(performanceTake).toBeDefined();
    expect(performanceTake!.verdict).toBe('ignored');

    const securityTake = webhookConflict!.takes.find((t) => t.agent_id === 'security-reviewer');
    expect(securityTake!.verdict).toBe('CRITICAL');
  });

  it('finds the same location flagged at two different severities', () => {
    const conflicts = computeConflicts(seededColumns);

    const webhookConflict = conflicts.find(
      (c) => c.file === 'src/api/public/webhooks.ts' && c.line === 16,
    );
    expect(webhookConflict).toBeDefined();

    const securityTake = webhookConflict!.takes.find((t) => t.agent_id === 'security-reviewer');
    const architectureTake = webhookConflict!.takes.find((t) => t.agent_id === 'architecture-reviewer');
    expect(securityTake!.verdict).toBe('CRITICAL');
    expect(architectureTake!.verdict).toBe('WARNING');
    expect(securityTake!.verdict).not.toBe(architectureTake!.verdict);
  });

  it('is a real cross-agent conflict, not agreement — takes differ across agents', () => {
    const conflicts = computeConflicts(seededColumns);
    const webhookConflict = conflicts.find(
      (c) => c.file === 'src/api/public/webhooks.ts' && c.line === 16,
    );
    const distinctVerdicts = new Set(webhookConflict!.takes.map((t) => t.verdict));
    expect(distinctVerdicts.size).toBeGreaterThan(1);
  });

  it('the Performance Reviewer finding at a different location does not itself create a conflict location clash', () => {
    // Sanity: the users.ts:45 location is a distinct entry from the
    // webhooks.ts:16 one — proves the disagreement isn't an artifact of a
    // location-key collision.
    const conflicts = computeConflicts(seededColumns);
    const usersConflict = conflicts.find((c) => c.file === 'src/api/users.ts' && c.line === 45);
    expect(usersConflict).toBeDefined();
    expect(usersConflict!.file).not.toBe('src/api/public/webhooks.ts');
  });
});
