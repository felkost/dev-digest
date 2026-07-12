/**
 * conflict-matcher unit tests — pure function, hermetic (no DB, no container).
 */
import { describe, it, expect } from 'vitest';
import {
  computeConflicts,
  type MatcherColumn,
  type MatcherFinding,
} from '../src/modules/reviews/conflict-matcher.js';

function makeFinding(overrides: Partial<MatcherFinding> = {}): MatcherFinding {
  return {
    file: 'src/a.ts',
    start_line: 10,
    severity: 'WARNING',
    title: 'Missing null check',
    rationale: 'Value can be undefined here.',
    ...overrides,
  };
}

function makeColumn(overrides: Partial<MatcherColumn> = {}): MatcherColumn {
  return {
    agent_id: 'agent-1',
    agent_name: 'Agent One',
    status: 'done',
    findings: [],
    ...overrides,
  };
}

describe('computeConflicts', () => {
  it('one agent flags a location the other does not → one Conflict with one ignored take', () => {
    const columns: MatcherColumn[] = [
      makeColumn({
        agent_id: 'a1',
        agent_name: 'Agent One',
        findings: [makeFinding({ file: 'src/a.ts', start_line: 10, title: 'Missing null check' })],
      }),
      makeColumn({ agent_id: 'a2', agent_name: 'Agent Two', findings: [] }),
    ];

    const conflicts = computeConflicts(columns);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ file: 'src/a.ts', line: 10, title: 'Missing null check' });
    expect(conflicts[0]!.takes).toHaveLength(2);
    expect(conflicts[0]!.takes[0]).toEqual({
      agent_id: 'a1',
      persona: 'Agent One',
      verdict: 'WARNING',
      note: 'Value can be undefined here.',
    });
    expect(conflicts[0]!.takes[1]).toEqual({
      agent_id: 'a2',
      persona: 'Agent Two',
      verdict: 'ignored',
      note: '',
    });
  });

  it('both agents flag the same location at different severities → one Conflict, both non-ignored', () => {
    const columns: MatcherColumn[] = [
      makeColumn({
        agent_id: 'a1',
        agent_name: 'Agent One',
        findings: [makeFinding({ severity: 'CRITICAL', title: 'SQL injection' })],
      }),
      makeColumn({
        agent_id: 'a2',
        agent_name: 'Agent Two',
        findings: [makeFinding({ severity: 'SUGGESTION', title: 'Consider parameterizing' })],
      }),
    ];

    const conflicts = computeConflicts(columns);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.takes.map((t) => t.verdict)).toEqual(['CRITICAL', 'SUGGESTION']);
    expect(conflicts[0]!.takes.every((t) => t.verdict !== 'ignored')).toBe(true);
    // Title comes from the first take (in column order) whose verdict !== 'ignored'.
    expect(conflicts[0]!.title).toBe('SQL injection');
  });

  it('both agents flag the same location at the same severity → still emitted (agreement case)', () => {
    const columns: MatcherColumn[] = [
      makeColumn({
        agent_id: 'a1',
        agent_name: 'Agent One',
        findings: [makeFinding({ severity: 'WARNING' })],
      }),
      makeColumn({
        agent_id: 'a2',
        agent_name: 'Agent Two',
        findings: [makeFinding({ severity: 'WARNING' })],
      }),
    ];

    const conflicts = computeConflicts(columns);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.takes.map((t) => t.verdict)).toEqual(['WARNING', 'WARNING']);
  });

  it('a running column contributes no take and does not count toward the >=2-done gate', () => {
    const columns: MatcherColumn[] = [
      makeColumn({
        agent_id: 'a1',
        agent_name: 'Agent One',
        status: 'done',
        findings: [makeFinding()],
      }),
      makeColumn({
        agent_id: 'a2',
        agent_name: 'Agent Two',
        status: 'running',
        findings: [makeFinding({ file: 'src/other.ts', start_line: 99 })],
      }),
    ];

    // Only 1 done column ('a1') — below the >=2-done gate, even though 2
    // columns total were passed in.
    expect(computeConflicts(columns)).toEqual([]);
  });

  it('a running column never contributes a take even when >=2 done columns exist', () => {
    const columns: MatcherColumn[] = [
      makeColumn({ agent_id: 'a1', agent_name: 'Agent One', status: 'done', findings: [makeFinding()] }),
      makeColumn({ agent_id: 'a2', agent_name: 'Agent Two', status: 'done', findings: [] }),
      makeColumn({
        agent_id: 'a3',
        agent_name: 'Agent Three',
        status: 'running',
        findings: [makeFinding()],
      }),
    ];

    const conflicts = computeConflicts(columns);

    expect(conflicts).toHaveLength(1);
    // Only the 2 done columns produce takes — the running column is absent entirely.
    expect(conflicts[0]!.takes).toHaveLength(2);
    expect(conflicts[0]!.takes.map((t) => t.agent_id)).toEqual(['a1', 'a2']);
  });

  it('fewer than 2 done columns → []', () => {
    expect(computeConflicts([])).toEqual([]);
    expect(computeConflicts([makeColumn({ status: 'done', findings: [makeFinding()] })])).toEqual([]);
    expect(
      computeConflicts([
        makeColumn({ status: 'done', findings: [makeFinding()] }),
        makeColumn({ status: 'failed', findings: [] }),
      ]),
    ).toEqual([]);
  });

  it('two findings at the same file but DIFFERENT lines are two separate locations, never merged into one Conflict (exact match, not line-range overlap)', () => {
    const columns: MatcherColumn[] = [
      makeColumn({
        agent_id: 'a1',
        agent_name: 'Agent One',
        findings: [
          makeFinding({ file: 'src/a.ts', start_line: 10, title: 'Issue at line 10' }),
          makeFinding({ file: 'src/a.ts', start_line: 20, title: 'Issue at line 20' }),
        ],
      }),
      makeColumn({
        agent_id: 'a2',
        agent_name: 'Agent Two',
        // Only flags line 10 — a naive "same file" or range-overlap match would
        // wrongly conflate this with the a1 finding at line 20.
        findings: [makeFinding({ file: 'src/a.ts', start_line: 10, title: 'Issue at line 10' })],
      }),
    ];

    const conflicts = computeConflicts(columns);

    expect(conflicts).toHaveLength(2);
    expect(conflicts.map((c) => c.line).sort((a, b) => a - b)).toEqual([10, 20]);

    const line10 = conflicts.find((c) => c.line === 10)!;
    const line20 = conflicts.find((c) => c.line === 20)!;

    // line 10: both agents produced a real take there.
    expect(line10.takes.every((t) => t.verdict !== 'ignored')).toBe(true);
    // line 20: only a1 flagged it — a2's take at THIS location is 'ignored',
    // proving the two lines are scored independently rather than collapsed
    // into a single "src/a.ts" conflict.
    const a2TakeAtLine20 = line20.takes.find((t) => t.agent_id === 'a2')!;
    expect(a2TakeAtLine20.verdict).toBe('ignored');
  });

  it('a done column finding with rationale: null → note: "", never null', () => {
    const columns: MatcherColumn[] = [
      makeColumn({
        agent_id: 'a1',
        agent_name: 'Agent One',
        findings: [makeFinding({ rationale: null })],
      }),
      makeColumn({ agent_id: 'a2', agent_name: 'Agent Two', findings: [] }),
    ];

    const conflicts = computeConflicts(columns);

    expect(conflicts[0]!.takes[0]!.note).toBe('');
    expect(conflicts[0]!.takes[0]!.note).not.toBeNull();
  });
});
