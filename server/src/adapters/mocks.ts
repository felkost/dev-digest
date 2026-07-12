import type { z } from 'zod';
import type {
  LLMProvider,
  ModelInfo,
  CompletionRequest,
  CompletionResult,
  StructuredRequest,
  StructuredResult,
  Embedder,
  GitHubClient,
  RepoRef,
  PrMeta,
  PrDetail,
  GitHubReviewPayload,
  CreateReviewCommentInput,
  PrReviewComment,
  OpenPrPayload,
  CommitFilesPayload,
  IssueMeta,
  GitClient,
  CloneOptions,
  UnifiedDiff,
  BlameLine,
  GitCommit,
  CodeIndex,
  CodeMatch,
  CodeSymbol,
  CodeReference,
  AuthProvider,
  AuthUser,
  AuthWorkspace,
  SecretsProvider,
  SecretKey,
  RunnerBundler,
} from '@devdigest/shared';
import { parseUnifiedDiff } from './git/diff-parser.js';

/**
 * Deterministic MOCK adapters for tests/dev — NO real network. Each mirrors the
 * adapter interface. The mock LLM returns a caller-supplied fixture (or a default)
 * for completeStructured, so review/grounding flows can be tested end-to-end.
 */

// ---------- Mock LLM ----------
export interface MockLLMOptions {
  models?: ModelInfo[];
  /** Fixture returned by completeStructured (validated against the schema). */
  structured?: unknown;
  /**
   * Per-schemaName fixtures for multi-call flows (e.g. the conventions 2-step
   * dialogue: 'ConventionFileSelection' then 'ConventionExtraction'). Looked up
   * by req.schemaName; falls back to `structured` when no entry matches.
   */
  structuredBySchema?: Record<string, unknown>;
  completionText?: string;
  embedding?: number[];
}

export class MockLLMProvider implements LLMProvider {
  readonly id: 'openai' | 'anthropic';
  public calls: { method: string; req: unknown }[] = [];

  constructor(
    id: 'openai' | 'anthropic' = 'openai',
    private opts: MockLLMOptions = {},
  ) {
    this.id = id;
  }

  async listModels(): Promise<ModelInfo[]> {
    this.calls.push({ method: 'listModels', req: null });
    return (
      this.opts.models ?? [
        { id: 'gpt-4.1', provider: this.id === 'anthropic' ? 'anthropic' : 'openai' },
      ]
    );
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    this.calls.push({ method: 'complete', req });
    return {
      text: this.opts.completionText ?? 'mock completion',
      model: req.model,
      tokensIn: 100,
      tokensOut: 50,
      costUsd: 0.001,
    };
  }

  async completeStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.calls.push({ method: 'completeStructured', req });
    const fixture = this.opts.structuredBySchema?.[req.schemaName] ?? this.opts.structured ?? {};
    const parsed = (req.schema as z.ZodType<T>).safeParse(fixture);
    if (!parsed.success) {
      throw new Error(`MockLLMProvider fixture failed schema: ${parsed.error.message}`);
    }
    return {
      data: parsed.data,
      model: req.model,
      tokensIn: 100,
      tokensOut: 50,
      costUsd: 0.001,
      raw: JSON.stringify(fixture),
      attempts: 1,
    };
  }

  async embed(texts: string[]): Promise<number[][]> {
    this.calls.push({ method: 'embed', req: texts });
    return texts.map(() => this.opts.embedding ?? new Array(1536).fill(0));
  }
}

// ---------- Mock Embedder ----------
export class MockEmbedder implements Embedder {
  readonly dims = 1536;
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((_, i) => new Array(1536).fill(0).map((_, j) => (i + j) % 2));
  }
}

// ---------- Mock GitHub ----------
/** Fixture shape shared by listWorkflowRuns/getWorkflowRun. */
export interface MockWorkflowRun {
  id: number;
  status: string;
  conclusion: string | null;
  html_url: string;
  created_at: string;
}

/** Fixture shape shared by listRunArtifacts. */
export interface MockRunArtifact {
  id: number;
  name: string;
  expired: boolean;
}

export interface MockGitHubOptions {
  pulls?: PrMeta[];
  detail?: Partial<PrDetail>;
  login?: string;
  /** Existing inline review comments returned by listReviewComments. */
  comments?: PrReviewComment[];
  /** Fixture tree returned by getRepoTree (defaults to a small deterministic tree). */
  tree?: { path: string; type: 'blob' | 'tree' }[];
  /** Fixture file contents keyed by path, returned by getFileContents. */
  contents?: Record<string, string>;
  /** Fixture default branch returned by getDefaultBranch (defaults to 'main'). */
  defaultBranch?: string;
  /** Fixture workflow runs returned by listWorkflowRuns/getWorkflowRun (defaults to one completed/success run + one in_progress run). */
  workflowRuns?: MockWorkflowRun[];
  /** Fixture artifacts returned by listRunArtifacts. */
  artifacts?: MockRunArtifact[];
  /** Fixture zip bytes returned by downloadArtifact. */
  artifactContents?: Buffer;
}

const DEFAULT_MOCK_TREE: { path: string; type: 'blob' | 'tree' }[] = [
  { path: 'src', type: 'tree' },
  { path: 'src/index.ts', type: 'blob' },
  { path: 'package.json', type: 'blob' },
  { path: 'README.md', type: 'blob' },
];

const DEFAULT_MOCK_CONTENTS: Record<string, string> = {
  'package.json': JSON.stringify(
    { name: 'mock-repo', version: '1.0.0', scripts: { dev: 'node src/index.ts' } },
    null,
    2,
  ),
  'README.md': '# Mock Repo\n\nA deterministic fixture repository for hermetic tests.\n',
};

const DEFAULT_MOCK_WORKFLOW_RUNS: MockWorkflowRun[] = [
  {
    id: 1001,
    status: 'completed',
    conclusion: 'success',
    html_url: 'https://github.com/mock/mock/actions/runs/1001',
    created_at: '2026-06-01T00:00:00Z',
  },
  {
    id: 1002,
    status: 'in_progress',
    conclusion: null,
    html_url: 'https://github.com/mock/mock/actions/runs/1002',
    created_at: '2026-06-02T00:00:00Z',
  },
];

const DEFAULT_MOCK_ARTIFACTS: MockRunArtifact[] = [
  { id: 2001, name: 'devdigest-result', expired: false },
];

export class MockGitHubClient implements GitHubClient {
  public posted: { n: number; review: GitHubReviewPayload }[] = [];
  public openedPrs: OpenPrPayload[] = [];
  public committed: CommitFilesPayload[] = [];
  public createdComments: CreateReviewCommentInput[] = [];
  public gotDefaultBranches: RepoRef[] = [];
  public listedRuns: { repo: RepoRef; workflowFile: string }[] = [];
  public gotRuns: { repo: RepoRef; runId: number }[] = [];
  public listedArtifacts: { repo: RepoRef; runId: number }[] = [];
  public downloadedArtifacts: { repo: RepoRef; artifactId: number }[] = [];

  constructor(private opts: MockGitHubOptions = {}) {}

  async listPullRequests(_repo: RepoRef): Promise<PrMeta[]> {
    return (
      this.opts.pulls ?? [
        {
          number: 482,
          title: 'Add rate limiting to public API endpoints',
          author: 'marisa.koch',
          branch: 'feat/rate-limit-public',
          base: 'main',
          head_sha: 'a1b2c3d4',
          additions: 247,
          deletions: 38,
          files_count: 9,
          status: 'open',
          opened_at: '2026-06-01T00:00:00Z',
          updated_at: '2026-06-01T03:00:00Z',
        },
      ]
    );
  }

  async getPullRequest(_repo: RepoRef, n: number): Promise<PrDetail> {
    const base: PrDetail = {
      number: n,
      title: 'Add rate limiting to public API endpoints',
      author: 'marisa.koch',
      branch: 'feat/rate-limit-public',
      base: 'main',
      head_sha: 'a1b2c3d4',
      additions: 247,
      deletions: 38,
      files_count: 9,
      status: 'open',
      body: 'Add rate limiting. Closes #471.',
      files: [
        {
          path: 'src/config.ts',
          additions: 4,
          deletions: 0,
          patch: '@@ -10,3 +10,4 @@\n   port: 3000,\n+  stripeKey: "sk_live_xxx",\n   redisUrl: x,',
        },
      ],
      commits: [
        { sha: 'a1b2c3d4', message: 'Add limiter', author: 'marisa.koch', committed_at: null },
      ],
      linked_issue: null,
    };
    return { ...base, ...this.opts.detail };
  }

  async postReview(_repo: RepoRef, n: number, review: GitHubReviewPayload): Promise<{ id: string }> {
    this.posted.push({ n, review });
    return { id: `mock-review-${n}` };
  }

  async listReviewComments(_repo: RepoRef, _n: number): Promise<PrReviewComment[]> {
    return this.opts.comments ?? [];
  }

  async createReviewComment(
    _repo: RepoRef,
    _n: number,
    input: CreateReviewCommentInput,
  ): Promise<PrReviewComment> {
    this.createdComments.push(input);
    return {
      id: this.createdComments.length,
      path: input.path,
      line: input.line,
      original_line: input.line,
      side: input.side ?? 'RIGHT',
      body: input.body,
      user: this.opts.login ?? 'mock-user',
      created_at: '2026-06-01T00:00:00Z',
      html_url: `https://github.com/mock/mock/pull/1#discussion_r${this.createdComments.length}`,
      in_reply_to_id: input.inReplyTo ?? null,
      is_outdated: false,
    };
  }

  async openPullRequest(_repo: RepoRef, payload: OpenPrPayload): Promise<{ url: string }> {
    this.openedPrs.push(payload);
    return { url: 'https://github.com/mock/mock/pull/1' };
  }

  async commitFiles(_repo: RepoRef, payload: CommitFilesPayload): Promise<{ branch: string }> {
    this.committed.push(payload);
    return { branch: payload.branch };
  }

  async findOpenPr(_repo: RepoRef, branch: string): Promise<{ url: string } | null> {
    const pr = this.openedPrs.find((p) => p.head === branch);
    return pr ? { url: 'https://github.com/mock/mock/pull/1' } : null;
  }

  async getIssue(_repo: RepoRef, n: number): Promise<IssueMeta> {
    return { number: n, title: `Issue #${n}`, body: 'mock issue', state: 'open' };
  }

  async currentLogin(): Promise<string> {
    return this.opts.login ?? 'mock-user';
  }

  async getRepoTree(
    _repo: RepoRef,
    _ref?: string,
  ): Promise<{ path: string; type: 'blob' | 'tree' }[]> {
    return this.opts.tree ?? DEFAULT_MOCK_TREE;
  }

  async getDefaultBranch(repo: RepoRef): Promise<string> {
    this.gotDefaultBranches.push(repo);
    return this.opts.defaultBranch ?? 'main';
  }

  async getFileContents(_repo: RepoRef, path: string, _ref?: string): Promise<string | null> {
    const fixtures = this.opts.contents ?? DEFAULT_MOCK_CONTENTS;
    return fixtures[path] ?? null;
  }

  async listWorkflowRuns(
    repo: RepoRef,
    workflowFile: string,
    _opts?: { perPage?: number },
  ): Promise<MockWorkflowRun[]> {
    this.listedRuns.push({ repo, workflowFile });
    return this.opts.workflowRuns ?? DEFAULT_MOCK_WORKFLOW_RUNS;
  }

  async getWorkflowRun(
    repo: RepoRef,
    runId: number,
  ): Promise<{ id: number; status: string; conclusion: string | null; html_url: string }> {
    this.gotRuns.push({ repo, runId });
    const runs = this.opts.workflowRuns ?? DEFAULT_MOCK_WORKFLOW_RUNS;
    const match = runs.find((r) => r.id === runId) ?? runs[0];
    // `??` on individual fields would wrongly overwrite a legitimate
    // `conclusion: null` (in-progress run) with the 'success' fallback — null
    // and "no match found" must stay distinguishable. Use the found fixture's
    // fields verbatim; only synthesize defaults when there is truly no match.
    if (match) {
      return { id: match.id, status: match.status, conclusion: match.conclusion, html_url: match.html_url };
    }
    return {
      id: runId,
      status: 'completed',
      conclusion: 'success',
      html_url: `https://github.com/mock/mock/actions/runs/${runId}`,
    };
  }

  async listRunArtifacts(repo: RepoRef, runId: number): Promise<MockRunArtifact[]> {
    this.listedArtifacts.push({ repo, runId });
    return this.opts.artifacts ?? DEFAULT_MOCK_ARTIFACTS;
  }

  async downloadArtifact(repo: RepoRef, artifactId: number): Promise<Buffer> {
    this.downloadedArtifacts.push({ repo, artifactId });
    return this.opts.artifactContents ?? Buffer.from('mock artifact contents');
  }
}

// ---------- Mock RunnerBundler ----------
export class MockRunnerBundler implements RunnerBundler {
  public buildCalls = 0;

  constructor(private contents = '// mock runner bundle\n') {}

  async build(): Promise<{ contents: string }> {
    this.buildCalls += 1;
    return { contents: this.contents };
  }
}

// ---------- Mock Git ----------
export interface MockGitOptions {
  diff?: string;
  files?: Record<string, string>;
  /** Name-only diff result (drives the incremental indexer's "changed files since X" path). */
  diffNameOnly?: string[];
  /** Override `currentHead()` so tests can simulate "sha unchanged since last index". */
  head?: string;
  /** Head `currentHead()` returns AFTER `sync()` runs — simulates fetch+reset advancing HEAD. */
  syncedHead?: string;
}

export class MockGitClient implements GitClient {
  public cloned: { repo: RepoRef; url: string }[] = [];
  public syncs: { repo: RepoRef; branch: string }[] = [];
  private syncedHead?: string;

  constructor(private opts: MockGitOptions = {}) {}

  clonePathFor(repo: RepoRef): string {
    return `/mock/clones/${repo.owner}/${repo.name}`;
  }
  async clone(repo: RepoRef, url: string, _opts?: CloneOptions): Promise<{ path: string }> {
    this.cloned.push({ repo, url });
    return { path: this.clonePathFor(repo) };
  }
  async fetchPullHead(): Promise<void> {}
  async sync(repo: RepoRef, branch: string): Promise<{ head: string }> {
    this.syncs.push({ repo, branch });
    // After a sync, HEAD advances to syncedHead (or stays at head if unset).
    this.syncedHead = this.opts.syncedHead ?? this.opts.head ?? 'a1b2c3d4';
    return { head: this.syncedHead };
  }
  async currentHead(): Promise<string> {
    return this.syncedHead ?? this.opts.head ?? 'a1b2c3d4';
  }
  async diffNameOnly(): Promise<string[]> {
    return this.opts.diffNameOnly ?? [];
  }
  async diff(): Promise<UnifiedDiff> {
    const raw =
      this.opts.diff ??
      'diff --git a/src/config.ts b/src/config.ts\n--- a/src/config.ts\n+++ b/src/config.ts\n@@ -10,3 +10,4 @@\n   port: 3000,\n+  stripeKey: "sk_live_xxx",\n   redisUrl: x,';
    return parseUnifiedDiff(raw);
  }
  async blame(): Promise<BlameLine[]> {
    return [{ line: 1, sha: 'a1b2c3d4', author: 'marisa.koch', date: '2026-06-01', summary: 'init' }];
  }
  async log(): Promise<GitCommit[]> {
    return [{ sha: 'a1b2c3d4', message: 'init', author: 'marisa.koch', date: '2026-06-01' }];
  }
  async readFile(_repo: RepoRef, path: string): Promise<string> {
    return this.opts.files?.[path] ?? '';
  }
}

// ---------- Mock CodeIndex ----------
export class MockCodeIndex implements CodeIndex {
  async grep(_repo: RepoRef, pattern: string): Promise<CodeMatch[]> {
    return [{ path: 'src/config.ts', line: 12, text: `match for ${pattern}` }];
  }
  async symbols(): Promise<CodeSymbol[]> {
    return [{ path: 'src/middleware/ratelimit.ts', name: 'rateLimit', kind: 'function', line: 25 }];
  }
  async references(_repo: RepoRef, symbol: string): Promise<CodeReference[]> {
    return [{ fromPath: 'src/api/public/index.ts', toSymbol: symbol, line: 23 }];
  }
}

// ---------- Mock Auth / Secrets ----------
export class MockAuthProvider implements AuthProvider {
  constructor(
    private user: AuthUser = { id: 'u1', email: 'you@local', name: 'You' },
    private workspace: AuthWorkspace = { id: 'w1', name: 'default' },
  ) {}
  async currentUser(): Promise<AuthUser> {
    return this.user;
  }
  async currentWorkspace(): Promise<AuthWorkspace> {
    return this.workspace;
  }
}

export class MockSecretsProvider implements SecretsProvider {
  constructor(private secrets: Partial<Record<string, string>> = {}) {}
  async get(key: SecretKey): Promise<string | undefined> {
    return this.secrets[key as string];
  }
}
