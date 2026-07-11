import { describe, it, expect } from 'vitest';
import type { PromptAssembly } from '@devdigest/shared';
import { countPromptAssemblyBlocks } from '../src/index.js';

const wordCount = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;

describe('countPromptAssemblyBlocks', () => {
  it('a full assembly reports all 8 slots, in fixed order', () => {
    const assembly: PromptAssembly = {
      system: 'system prompt text',
      skills: 'skills body text',
      memory: 'memory item text',
      specs: 'specs chunk text',
      callers: 'callers digest text',
      repo_map: 'repo map text',
      pr_description: 'pr description text',
      user: 'user task text',
    };

    const report = countPromptAssemblyBlocks(assembly, wordCount);

    expect(report.map((r) => r.block)).toEqual([
      'system',
      'skills',
      'memory',
      'specs',
      'callers',
      'repo_map',
      'pr_description',
      'user',
    ]);
    // Every block counted (each fixture value is 3 words).
    for (const entry of report) {
      expect(entry.tokens).toBe(3);
    }
  });

  it('a partial assembly OMITS absent slots entirely — not zero, not "unavailable"', () => {
    const assembly: PromptAssembly = {
      system: 'system prompt text',
      skills: null,
      memory: undefined,
      specs: null,
      callers: null,
      repo_map: null,
      pr_description: null,
      user: 'user text',
    };

    const report = countPromptAssemblyBlocks(assembly, wordCount);

    expect(report.map((r) => r.block)).toEqual(['system', 'user']);
    expect(report.every((r) => typeof r.tokens === 'number')).toBe(true);
  });

  it('a counter that throws for one slot yields "unavailable" for that slot only; the function itself never throws', () => {
    const assembly: PromptAssembly = {
      system: 'system prompt text',
      skills: 'skills text',
      memory: null,
      specs: null,
      callers: null,
      repo_map: null,
      pr_description: null,
      user: 'user text',
    };

    const throwingCounter = (text: string): number => {
      if (text === 'skills text') throw new Error('boom');
      return wordCount(text);
    };

    let report: { block: string; tokens: number | 'unavailable' }[] = [];
    expect(() => {
      report = countPromptAssemblyBlocks(assembly, throwingCounter);
    }).not.toThrow();

    expect(report.map((r) => r.block)).toEqual(['system', 'skills', 'user']);
    const skills = report.find((r) => r.block === 'skills');
    expect(skills?.tokens).toBe('unavailable');
    const system = report.find((r) => r.block === 'system');
    expect(system?.tokens).toBe(3);
    const user = report.find((r) => r.block === 'user');
    expect(user?.tokens).toBe(2);
  });
});
