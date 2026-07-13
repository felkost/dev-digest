/**
 * Hermetic tests for `ci/helpers.ts` — pure functions, no DB/network/filesystem.
 * Covers: `slugify`/`dedupeSlug` collision cases, and `composeCiFiles`'s flat
 * file assembly (0 skills, N skills, workflowOverride present/absent, the
 * slug-is-a-pure-input guarantee, and the editable flags per file).
 */
import { describe, it, expect } from 'vitest';
import {
  slugify,
  dedupeSlug,
  composeCiFiles,
  staleAgentManifests,
  CI_RESULT_ARTIFACT_NAME,
  type ComposeCiFilesParams,
} from '../src/modules/ci/helpers.js';
import { generateWorkflowYaml } from '../src/modules/ci/workflow.js';
import type { ManifestAgentInput } from '../src/modules/ci/manifest.js';

function makeAgent(overrides: Partial<ManifestAgentInput> = {}): ManifestAgentInput {
  return {
    name: 'Security Reviewer',
    provider: 'openai',
    model: 'gpt-4o',
    systemPrompt: 'Review for security issues.',
    strategy: 'single-pass',
    ciFailOn: 'critical',
    ...overrides,
  };
}

function baseParams(overrides: Partial<ComposeCiFilesParams> = {}): ComposeCiFilesParams {
  return {
    slug: 'security-reviewer',
    agent: makeAgent(),
    skills: [],
    triggers: ['opened', 'synchronize'],
    postAs: 'github_review',
    runnerBundleContents: '// mock runner bundle\n',
    ...overrides,
  };
}

describe('staleAgentManifests', () => {
  const KEEP = '.devdigest/agents/security-reviewer.yaml';

  it('returns OTHER agent manifests on the branch, excluding the one being written', () => {
    const tree = [
      'src/index.ts',
      'package.json',
      '.devdigest/runner/index.js',
      '.devdigest/memory.jsonl',
      '.devdigest/agents/performance-reviewer.yaml', // stale (previous agent)
      '.devdigest/agents/security-reviewer.yaml', // the one we're re-writing
      '.github/workflows/devdigest-review.yml',
    ];
    expect(staleAgentManifests(tree, KEEP)).toEqual([
      '.devdigest/agents/performance-reviewer.yaml',
    ]);
  });

  it('matches both .yaml and .yml, and only files directly under .devdigest/agents/', () => {
    const tree = [
      '.devdigest/agents/old-one.yml', // stale (.yml extension)
      '.devdigest/agents/old-two.yaml', // stale
      '.devdigest/agents/nested/deep.yaml', // NOT a manifest (subdir) — runner globs the dir flatly
      '.devdigest/skills/boundary-cases.md', // not a manifest
      KEEP,
    ];
    expect(staleAgentManifests(tree, KEEP)).toEqual([
      '.devdigest/agents/old-one.yml',
      '.devdigest/agents/old-two.yaml',
    ]);
  });

  it('returns [] on a fresh export (no manifests on the branch yet)', () => {
    expect(staleAgentManifests(['src/index.ts', 'package.json'], KEEP)).toEqual([]);
  });
});

describe('slugify', () => {
  it('lowercases and collapses non-alphanumeric runs to a single hyphen', () => {
    expect(slugify('Security Reviewer!!')).toBe('security-reviewer');
    expect(slugify('Foo___Bar---Baz')).toBe('foo-bar-baz');
  });

  it('trims leading and trailing hyphens', () => {
    expect(slugify('--Foo Bar--')).toBe('foo-bar');
    expect(slugify('!!!Weird Name!!!')).toBe('weird-name');
  });

  it('returns "" for a name with zero ASCII alphanumeric characters after lowercasing — the fallback belongs in the CALLER (export-service.ts), not here', () => {
    expect(slugify('日本語')).toBe('');
    expect(slugify('★★★')).toBe('');
  });

  it('caps the result at ~60 characters with no trailing hyphen', () => {
    const longName = 'A'.repeat(80);
    const result = slugify(longName);
    expect(result.length).toBeLessThanOrEqual(60);
    expect(result.endsWith('-')).toBe(false);

    // A name whose slug would end exactly on a word-boundary hyphen at the
    // cap point must still not leave a trailing '-' after slicing.
    const wordsPastCap = Array.from({ length: 20 }, (_, i) => `word${i}`).join(' ');
    const capped = slugify(wordsPastCap);
    expect(capped.length).toBeLessThanOrEqual(60);
    expect(capped.endsWith('-')).toBe(false);
  });
});

describe('dedupeSlug', () => {
  it('returns the base slug unchanged when there is no collision', () => {
    expect(dedupeSlug(new Set(), 'foo')).toBe('foo');
    expect(dedupeSlug(new Set(['bar']), 'foo')).toBe('foo');
  });

  it('appends -2 on the first collision', () => {
    expect(dedupeSlug(new Set(['foo']), 'foo')).toBe('foo-2');
  });

  it('keeps incrementing until a free slug is found', () => {
    expect(dedupeSlug(new Set(['foo', 'foo-2', 'foo-3']), 'foo')).toBe('foo-4');
  });

  it('does not mutate the existing set (pure function)', () => {
    const existing = new Set(['foo']);
    dedupeSlug(existing, 'foo');
    expect(existing.size).toBe(1);
    expect(existing.has('foo-2')).toBe(false);
  });
});

describe('composeCiFiles — 0 skills', () => {
  it('produces exactly the 4 non-skill files, no skill files', () => {
    const files = composeCiFiles(baseParams({ skills: [] }));

    const paths = files.map((f) => f.path);
    expect(paths).toEqual([
      '.devdigest/agents/security-reviewer.yaml',
      '.devdigest/memory.jsonl',
      '.github/workflows/devdigest-review.yml',
      '.devdigest/runner/index.js',
    ]);
    expect(paths.some((p) => p.startsWith('.devdigest/skills/'))).toBe(false);
  });
});

describe('composeCiFiles — N skills', () => {
  it('produces one file per linked skill, in flat .devdigest/skills/<slug>.md paths', () => {
    const files = composeCiFiles(
      baseParams({
        skills: [
          { name: 'Security Practices', body: '# Security\n...' },
          { name: 'Style Guide', body: '# Style\n...' },
        ],
      }),
    );

    const skillFiles = files.filter((f) => f.path.startsWith('.devdigest/skills/'));
    expect(skillFiles.map((f) => f.path)).toEqual([
      '.devdigest/skills/security-practices.md',
      '.devdigest/skills/style-guide.md',
    ]);
    expect(skillFiles[0]!.contents).toBe('# Security\n...');
    expect(skillFiles[1]!.contents).toBe('# Style\n...');
  });

  it('dedupes skill slugs that collide after slugification', () => {
    const files = composeCiFiles(
      baseParams({
        skills: [
          { name: 'My Skill', body: 'first' },
          { name: 'My Skill!!', body: 'second' },
        ],
      }),
    );

    const skillFiles = files.filter((f) => f.path.startsWith('.devdigest/skills/'));
    expect(skillFiles.map((f) => f.path)).toEqual([
      '.devdigest/skills/my-skill.md',
      '.devdigest/skills/my-skill-2.md',
    ]);
  });

  it('includes the deduped skill slugs (not raw names) in the agent manifest yaml', () => {
    const files = composeCiFiles(
      baseParams({
        skills: [
          { name: 'My Skill', body: 'first' },
          { name: 'My Skill!!', body: 'second' },
        ],
      }),
    );
    const manifestFile = files.find((f) => f.path === '.devdigest/agents/security-reviewer.yaml')!;
    expect(manifestFile.contents).toContain('my-skill');
    expect(manifestFile.contents).toContain('my-skill-2');
  });
});

describe('composeCiFiles — workflowOverride', () => {
  it('uses the override verbatim when provided, marked editable', () => {
    const override = 'name: Custom Workflow\non: { pull_request: { types: [opened] } }\n';
    const files = composeCiFiles(baseParams({ workflowOverride: override }));

    const workflowFile = files.find((f) => f.path === '.github/workflows/devdigest-review.yml')!;
    expect(workflowFile.contents).toBe(override);
    expect(workflowFile.editable).toBe(true);
  });

  it('generates the workflow via generateWorkflowYaml when no override is provided', () => {
    const params = baseParams({ workflowOverride: undefined, triggers: ['opened'], postAs: 'pr_comment' });
    const files = composeCiFiles(params);

    const workflowFile = files.find((f) => f.path === '.github/workflows/devdigest-review.yml')!;
    const expected = generateWorkflowYaml({
      triggers: ['opened'],
      postAs: 'pr_comment',
      resultArtifactName: CI_RESULT_ARTIFACT_NAME,
    });
    expect(workflowFile.contents).toBe(expected);
    expect(workflowFile.editable).toBe(true);
  });

  it('generates fresh (not the override) when workflowOverride is null', () => {
    const params = baseParams({ workflowOverride: null });
    const files = composeCiFiles(params);
    const workflowFile = files.find((f) => f.path === '.github/workflows/devdigest-review.yml')!;
    expect(workflowFile.contents).not.toBe('');
    expect(workflowFile.contents).toContain('DevDigest Review');
  });
});

describe('composeCiFiles — slug is a pure input (AC-4/AC-5 identity stability)', () => {
  it('uses the passed-in slug for the agent manifest path regardless of the agent object\'s current name', () => {
    const files = composeCiFiles(
      baseParams({
        slug: 'frozen-slug',
        agent: makeAgent({ name: 'A Totally Different Name After A Rename' }),
      }),
    );

    const manifestFile = files.find((f) => f.path.startsWith('.devdigest/agents/'))!;
    expect(manifestFile.path).toBe('.devdigest/agents/frozen-slug.yaml');
    expect(manifestFile.path).not.toContain('totally-different-name');
  });
});

describe('composeCiFiles — memory + runner bundle + editable flags', () => {
  it('always includes an empty, non-editable memory.jsonl', () => {
    const files = composeCiFiles(baseParams());
    const memoryFile = files.find((f) => f.path === '.devdigest/memory.jsonl')!;
    expect(memoryFile.contents).toBe('');
    expect(memoryFile.editable).toBe(false);
  });

  it('includes the runner bundle contents verbatim, non-editable', () => {
    const files = composeCiFiles(baseParams({ runnerBundleContents: '// real ncc bundle\n' }));
    const runnerFile = files.find((f) => f.path === '.devdigest/runner/index.js')!;
    expect(runnerFile.contents).toBe('// real ncc bundle\n');
    expect(runnerFile.editable).toBe(false);
  });

  it('marks every non-workflow file editable:false, and only the workflow file editable:true', () => {
    const files = composeCiFiles(
      baseParams({ skills: [{ name: 'Some Skill', body: 'body' }] }),
    );
    for (const file of files) {
      if (file.path === '.github/workflows/devdigest-review.yml') {
        expect(file.editable).toBe(true);
      } else {
        expect(file.editable).toBe(false);
      }
    }
  });
});
