import { describe, it, expect } from 'vitest';
import {
  projectAgent,
  projectBlast,
  projectConvention,
  paginateFindings,
  conciseReviewSummary,
} from '../src/format.js';
import {
  makeAgent,
  makeConvention,
  makePrBrief,
  makeReviewRecord,
  makeFinding,
} from './setup.js';

describe('format', () => {
  describe('projectAgent', () => {
    it('projects only the allowed fields and drops sensitive ones', () => {
      const agent = makeAgent({
        system_prompt: 'SECRET PROMPT',
        output_schema: { type: 'object' },
        version: 42,
        strategy: 'map-reduce',
        ci_fail_on: 'any',
        repo_intel: false,
      });

      const projected = projectAgent(agent);

      // Allowed fields
      expect(projected.id).toBe(agent.id);
      expect(projected.name).toBe(agent.name);
      expect(projected.description).toBe(agent.description);
      expect(projected.provider).toBe(agent.provider);
      expect(projected.model).toBe(agent.model);
      expect(projected.enabled).toBe(agent.enabled);

      // Dropped fields must not appear
      expect(projected).not.toHaveProperty('system_prompt');
      expect(projected).not.toHaveProperty('output_schema');
      expect(projected).not.toHaveProperty('version');
      expect(projected).not.toHaveProperty('strategy');
      expect(projected).not.toHaveProperty('ci_fail_on');
      expect(projected).not.toHaveProperty('repo_intel');
    });
  });

  describe('projectConvention', () => {
    it('uses edited_rule when present, falls back to rule', () => {
      const withEdited = makeConvention('accepted', {
        rule: 'Original rule',
        edited_rule: 'Edited rule',
      });
      expect(projectConvention(withEdited).rule).toBe('Edited rule');

      const noEdited = makeConvention('accepted', {
        rule: 'Only rule',
        edited_rule: undefined,
      });
      expect(projectConvention(noEdited).rule).toBe('Only rule');
    });

    it('defaults category to uncategorized when absent', () => {
      const c = makeConvention('verified', { category: undefined });
      expect(projectConvention(c).category).toBe('uncategorized');
    });
  });

  describe('projectBlast', () => {
    it('returns available:false with reason when brief is null', () => {
      const result = projectBlast(null);
      expect(result.available).toBe(false);
      if (!result.available) {
        expect(result.reason).toMatch(/later lesson/i);
      }
    });

    it('returns available:true with correct counts when brief is provided', () => {
      const brief = makePrBrief();
      const result = projectBlast(brief);

      expect(result.available).toBe(true);
      if (result.available) {
        expect(result.summary).toBe(brief.blast.summary);
        expect(result.changed_symbols_count).toBe(brief.blast.changed_symbols.length);
        expect(result.downstream_count).toBe(brief.blast.downstream.length);
        // top_downstream is first 5 (we have 2 in our fixture)
        expect(result.top_downstream).toHaveLength(2);
        expect(result.top_downstream[0]?.symbol).toBe('useCache');
        expect(result.top_downstream[0]?.callers_count).toBe(2);
        expect(result.top_downstream[0]?.endpoints_affected).toEqual(['/api/data']);
      }
    });

    it('limits top_downstream to 5 entries', () => {
      const brief = makePrBrief();
      // Add enough downstream entries to exceed 5
      const manyDownstream = Array.from({ length: 8 }, (_, i) => ({
        symbol: `sym${i}`,
        callers: [{ name: `caller${i}`, file: `src/f${i}.ts`, line: i + 1 }],
        endpoints_affected: [],
        crons_affected: [],
      }));
      brief.blast.downstream = manyDownstream;
      const result = projectBlast(brief);

      if (result.available) {
        expect(result.top_downstream).toHaveLength(5);
      }
    });
  });

  describe('paginateFindings', () => {
    it('returns has_more:true and items.length===20 when total is 25 and limit is 20', () => {
      const findings = Array.from({ length: 25 }, (_, i) =>
        makeFinding('WARNING', String(i + 1)),
      );
      const review = makeReviewRecord({ findings });

      const result = paginateFindings([review], 20);

      expect(result.total).toBe(25);
      expect(result.has_more).toBe(true);
      expect(result.items).toHaveLength(20);
    });

    it('returns has_more:false when total is within limit', () => {
      const findings = Array.from({ length: 5 }, (_, i) =>
        makeFinding('SUGGESTION', String(i + 1)),
      );
      const review = makeReviewRecord({ findings });

      const result = paginateFindings([review], 20);

      expect(result.total).toBe(5);
      expect(result.has_more).toBe(false);
      expect(result.items).toHaveLength(5);
    });

    it('sorts findings CRITICAL → WARNING → SUGGESTION', () => {
      const findings = [
        makeFinding('SUGGESTION', '1'),
        makeFinding('CRITICAL', '2'),
        makeFinding('WARNING', '3'),
      ];
      const review = makeReviewRecord({ findings });

      const result = paginateFindings([review]);

      expect(result.items[0]?.severity).toBe('CRITICAL');
      expect(result.items[1]?.severity).toBe('WARNING');
      expect(result.items[2]?.severity).toBe('SUGGESTION');
    });

    it('caps limit at 50 when a higher limit is requested', () => {
      const findings = Array.from({ length: 60 }, (_, i) =>
        makeFinding('WARNING', String(i + 1)),
      );
      const review = makeReviewRecord({ findings });

      const result = paginateFindings([review], 100);

      expect(result.items).toHaveLength(50);
      expect(result.has_more).toBe(true);
    });
  });

  describe('conciseReviewSummary', () => {
    it('omits finding bodies and computes findings_breakdown by severity', () => {
      const findings = [
        makeFinding('CRITICAL', '1'),
        makeFinding('WARNING', '2'),
        makeFinding('WARNING', '3'),
        makeFinding('SUGGESTION', '4'),
      ];
      const review = makeReviewRecord({ findings, verdict: 'request_changes', score: 30 });

      const result = conciseReviewSummary([review]);

      expect(result).toHaveLength(1);
      const entry = result[0]!;

      // No finding bodies
      expect(entry).not.toHaveProperty('findings');

      // Computed breakdown
      expect(entry.findings_breakdown).toEqual({ critical: 1, warning: 2, suggestion: 1 });
      expect(entry.verdict).toBe('request_changes');
      expect(entry.score).toBe(30);
      expect(entry.agent_name).toBe('Test Agent');
    });

    it('handles reviews with no findings — all counts are 0', () => {
      const review = makeReviewRecord({ findings: [] });
      const result = conciseReviewSummary([review]);

      expect(result[0]?.findings_breakdown).toEqual({ critical: 0, warning: 0, suggestion: 0 });
    });

    it('returns empty array for empty reviews input', () => {
      expect(conciseReviewSummary([])).toEqual([]);
    });
  });
});
