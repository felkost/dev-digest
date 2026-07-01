import { describe, it, expect, vi } from 'vitest';
import { makePrBrief, makeOk, makeErr, getResultText } from '../setup.js';

vi.mock('../../src/api-client.js', () => ({
  fetchAgents: vi.fn(),
  fetchRepoPulls: vi.fn(),
  postReview: vi.fn(),
  fetchRuns: vi.fn(),
  fetchReviews: vi.fn(),
  fetchConventions: vi.fn(),
  fetchBrief: vi.fn(),
  enrichMessage: vi.fn((code: string, message: string) => message),
}));

import { getBlastRadiusTool } from '../../src/tools/get-blast-radius.js';
import * as apiClient from '../../src/api-client.js';

const fetchBriefMock = vi.mocked(apiClient.fetchBrief);

const PR_ID = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';

describe('get_blast_radius tool', () => {
  describe('handler', () => {
    it('returns available:false with reason when brief is null (live PR without seed data)', async () => {
      fetchBriefMock.mockResolvedValue(makeOk(null));

      const result = await getBlastRadiusTool.handler({ pr_id: PR_ID });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(getResultText(result));

      expect(parsed.available).toBe(false);
      expect(parsed.reason).toBeTruthy();
    });

    it('returns available:true with blast data for a seeded PR with brief', async () => {
      const brief = makePrBrief();
      fetchBriefMock.mockResolvedValue(makeOk(brief));

      const result = await getBlastRadiusTool.handler({ pr_id: PR_ID });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(getResultText(result));

      expect(parsed.available).toBe(true);
      expect(parsed.summary).toBe(brief.blast.summary);
      expect(parsed.changed_symbols_count).toBe(brief.blast.changed_symbols.length);
      expect(parsed.downstream_count).toBe(brief.blast.downstream.length);
      expect(Array.isArray(parsed.top_downstream)).toBe(true);
    });

    it('returns isError:true when fetchBrief returns an api error', async () => {
      fetchBriefMock.mockResolvedValue(
        makeErr('network_error', 'DevDigest API is unreachable at http://localhost:3001; ensure the server is running'),
      );

      const result = await getBlastRadiusTool.handler({ pr_id: PR_ID });

      expect(result.isError).toBe(true);
      expect(getResultText(result)).toContain('unreachable');
    });
  });
});
