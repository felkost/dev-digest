/**
 * conflict-matcher — cross-agent conflict detection for the multi-agent
 * review view (L07). PURE, deterministic, ZERO LLM calls / DB / I/O.
 *
 * `computeConflicts` returns one `Conflict` per distinct (file, start_line)
 * location that at least one 'done' agent column flagged — this INCLUDES
 * locations where every done column agrees (same severity, or all ignored
 * except one). Despite the function's name, it does not filter down to
 * disagreements only: "show only conflicts" (AC-31) is a client-side display
 * filter applied on top of this full result, not something this function
 * decides. Keeping agreement rows in the output lets any future consumer
 * (e.g. a "agents agreed here" view) reuse the same data without recomputing.
 */
import type { Conflict, ConflictTake, Severity } from '@devdigest/shared';

export interface MatcherFinding {
  file: string;
  start_line: number;
  severity: Severity;
  title: string;
  rationale: string | null;
}

export interface MatcherColumn {
  agent_id: string;
  agent_name: string;
  status: 'done' | 'failed' | 'running';
  findings: MatcherFinding[];
}

/** Composite key for an exact (file, start_line) location. */
function locationKey(file: string, startLine: number): string {
  return JSON.stringify([file, startLine]);
}

/**
 * Compute cross-agent conflicts from a set of agent columns.
 *
 * - Only `status === 'done'` columns are considered; a `'running'`/`'failed'`
 *   column contributes no take for any location (not even `'ignored'`) and
 *   does not count toward the ≥2-done gate below — it has not produced a
 *   trustworthy verdict yet.
 * - If fewer than 2 done columns exist, returns `[]` immediately.
 * - Locations are matched by EXACT (file, start_line) equality, not a
 *   line-range overlap.
 * - Ordering is deterministic: locations appear in first-seen order while
 *   walking done columns in their given order, then each column's `findings`
 *   array in its given order (stable for a given input — no `Date.now()`,
 *   no sorting by anything non-deterministic).
 */
export function computeConflicts(columns: MatcherColumn[]): Conflict[] {
  const doneColumns = columns.filter((column) => column.status === 'done');
  if (doneColumns.length < 2) return [];

  const locationOrder: Array<{ file: string; start_line: number }> = [];
  const seenLocations = new Set<string>();
  for (const column of doneColumns) {
    for (const finding of column.findings) {
      const key = locationKey(finding.file, finding.start_line);
      if (!seenLocations.has(key)) {
        seenLocations.add(key);
        locationOrder.push({ file: finding.file, start_line: finding.start_line });
      }
    }
  }

  const conflicts: Conflict[] = [];
  for (const location of locationOrder) {
    const takes: ConflictTake[] = [];
    let title: string | undefined;

    for (const column of doneColumns) {
      const finding = column.findings.find(
        (f) => f.file === location.file && f.start_line === location.start_line,
      );
      if (finding) {
        takes.push({
          agent_id: column.agent_id,
          persona: column.agent_name,
          verdict: finding.severity,
          // Never emit null/undefined for note — ConflictTake.note is non-nullable.
          note: finding.rationale ?? '',
        });
        if (title === undefined) title = finding.title;
      } else {
        takes.push({
          agent_id: column.agent_id,
          persona: column.agent_name,
          verdict: 'ignored',
          note: '',
        });
      }
    }

    conflicts.push({
      file: location.file,
      line: location.start_line,
      // At least one done column produced this location, so `title` is
      // always set by the loop above; the fallback is only for the type checker.
      title: title ?? '',
      takes,
    });
  }

  return conflicts;
}
