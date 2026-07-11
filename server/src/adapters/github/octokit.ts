import { Octokit } from 'octokit';
import type {
  GitHubClient,
  RepoRef,
  PrMeta,
  PrDetail,
  PrStatus,
  GitHubReviewPayload,
  CreateReviewCommentInput,
  PrReviewComment,
  OpenPrPayload,
  CommitFilesPayload,
  IssueMeta,
} from '@devdigest/shared';
import { withRetry, withTimeout } from '../../platform/resilience.js';
import { ExternalServiceError } from '../../platform/errors.js';

const TIMEOUT = 30_000;

function mapStatus(state: string, merged: boolean | undefined): PrStatus {
  if (merged) return 'merged';
  if (state === 'closed') return 'closed';
  return 'open';
}

/**
 * A GitHub write (create-tree / commit / ref) that fails with 403/404 almost
 * always means the configured PAT lacks write access to the target repo — the
 * raw Octokit message ("Resource not accessible by personal access token -
 * …/git/trees#create-a-tree") is cryptic and surfaces verbatim in the Export
 * wizard / bulk-update UI. Translate it into one actionable sentence; leave
 * every other error untouched so real bugs still propagate as-is.
 */
function mapGitHubWriteError(err: unknown, repo: RepoRef): unknown {
  const status =
    (err as { status?: number })?.status ??
    (err as { response?: { status?: number } })?.response?.status;
  if (status === 403 || status === 404) {
    return new ExternalServiceError(
      `GitHub blocked writing DevDigest's CI files to ${repo.owner}/${repo.name}. ` +
        `The configured GitHub token can't write there — use a classic PAT with the "repo" and "workflow" scopes, ` +
        `or a fine-grained token with "Contents" and "Workflows" set to Read and write plus ${repo.owner}/${repo.name} ` +
        `in its selected repositories. Update GITHUB_TOKEN and restart the API (the token is read once at boot).`,
      err,
    );
  }
  return err;
}

/**
 * GitHubClient over Octokit REST — thin. PAT auth (fine-grained).
 * Reads PR list/detail/files/commits/issue; posts reviews; opens PRs.
 */
export class OctokitGitHubClient implements GitHubClient {
  private octokit: Octokit;

  constructor(token: string) {
    this.octokit = new Octokit({ auth: token });
  }

  async listPullRequests(repo: RepoRef): Promise<PrMeta[]> {
    return withRetry(() =>
      withTimeout(
        (async () => {
          // Fetch open + recently merged/closed (most-recently-updated first) so
          // the list shows which PRs are merged vs still open — not just open.
          const res = await this.octokit.rest.pulls.list({
            owner: repo.owner,
            repo: repo.name,
            state: 'all',
            sort: 'updated',
            direction: 'desc',
            per_page: 50,
          });
          return res.data.map((pr) => ({
            number: pr.number,
            title: pr.title,
            author: pr.user?.login ?? 'unknown',
            branch: pr.head.ref,
            base: pr.base.ref,
            head_sha: pr.head.sha,
            additions: 0,
            deletions: 0,
            files_count: 0, // not present on the list payload; populated by getPullRequest
            status: mapStatus(pr.state, Boolean(pr.merged_at)) as PrStatus,
            opened_at: pr.created_at,
            updated_at: pr.updated_at,
          }));
        })(),
        TIMEOUT,
      ),
    );
  }

  async getPullRequest(repo: RepoRef, n: number): Promise<PrDetail> {
    return withRetry(() =>
      withTimeout(
        (async () => {
          const { data: pr } = await this.octokit.rest.pulls.get({
            owner: repo.owner,
            repo: repo.name,
            pull_number: n,
          });
          const files = await this.octokit.paginate(
            this.octokit.rest.pulls.listFiles,
            { owner: repo.owner, repo: repo.name, pull_number: n, per_page: 100 },
          );
          const { data: commits } = await this.octokit.rest.pulls.listCommits({
            owner: repo.owner,
            repo: repo.name,
            pull_number: n,
            per_page: 100,
          });
          const linkedIssue = await this.resolveLinkedIssue(repo, pr.body ?? '');
          return {
            number: pr.number,
            title: pr.title,
            author: pr.user?.login ?? 'unknown',
            branch: pr.head.ref,
            base: pr.base.ref,
            head_sha: pr.head.sha,
            additions: pr.additions,
            deletions: pr.deletions,
            files_count: pr.changed_files,
            status: mapStatus(pr.state, Boolean(pr.merged_at)) as PrStatus,
            opened_at: pr.created_at,
            updated_at: pr.updated_at,
            body: pr.body,
            files: files.map((f) => ({
              path: f.filename,
              additions: f.additions,
              deletions: f.deletions,
              patch: f.patch,
            })),
            commits: commits.map((c) => ({
              sha: c.sha,
              message: c.commit.message,
              author: c.commit.author?.name ?? c.author?.login ?? 'unknown',
              committed_at: c.commit.author?.date,
            })),
            linked_issue: linkedIssue,
          };
        })(),
        TIMEOUT,
      ),
    );
  }

  /** linked issue via regex on PR body (#123 / closes #123). */
  private async resolveLinkedIssue(repo: RepoRef, body: string): Promise<IssueMeta | undefined> {
    const m = body.match(/(?:closes|fixes|resolves)?\s*#(\d+)/i);
    if (!m?.[1]) return undefined;
    try {
      return await this.getIssue(repo, Number(m[1]));
    } catch {
      return undefined;
    }
  }

  async postReview(
    repo: RepoRef,
    n: number,
    review: GitHubReviewPayload,
  ): Promise<{ id: string }> {
    return withRetry(() =>
      withTimeout(
        (async () => {
          const res = await this.octokit.rest.pulls.createReview({
            owner: repo.owner,
            repo: repo.name,
            pull_number: n,
            body: review.body,
            event: review.event,
            comments: review.comments?.map((c) => ({
              path: c.path,
              line: c.line,
              body: c.body,
            })),
          });
          return { id: String(res.data.id) };
        })(),
        TIMEOUT,
      ),
    );
  }

  /** Shape an Octokit review-comment payload into our DTO. */
  private mapReviewComment(c: {
    id: number;
    path: string;
    line?: number | null;
    original_line?: number | null;
    side?: string | null;
    body: string;
    user: { login: string } | null;
    created_at: string;
    html_url: string;
    in_reply_to_id?: number;
  }): PrReviewComment {
    return {
      id: c.id,
      path: c.path,
      line: c.line ?? null,
      original_line: c.original_line ?? null,
      side: c.side === 'LEFT' ? 'LEFT' : 'RIGHT',
      body: c.body,
      user: c.user?.login ?? 'unknown',
      created_at: c.created_at,
      html_url: c.html_url,
      in_reply_to_id: c.in_reply_to_id ?? null,
      // GitHub drops `line` when the comment can no longer be placed on the diff.
      is_outdated: c.line == null,
    };
  }

  async listReviewComments(repo: RepoRef, n: number): Promise<PrReviewComment[]> {
    return withRetry(() =>
      withTimeout(
        (async () => {
          const res = await this.octokit.rest.pulls.listReviewComments({
            owner: repo.owner,
            repo: repo.name,
            pull_number: n,
            per_page: 100,
          });
          return res.data.map((c) => this.mapReviewComment(c));
        })(),
        TIMEOUT,
      ),
    );
  }

  async createReviewComment(
    repo: RepoRef,
    n: number,
    input: CreateReviewCommentInput,
  ): Promise<PrReviewComment> {
    return withRetry(() =>
      withTimeout(
        (async () => {
          if (input.inReplyTo != null) {
            const res = await this.octokit.rest.pulls.createReplyForReviewComment({
              owner: repo.owner,
              repo: repo.name,
              pull_number: n,
              comment_id: input.inReplyTo,
              body: input.body,
            });
            return this.mapReviewComment(res.data);
          }
          const res = await this.octokit.rest.pulls.createReviewComment({
            owner: repo.owner,
            repo: repo.name,
            pull_number: n,
            commit_id: input.commitId,
            path: input.path,
            line: input.line,
            side: input.side ?? 'RIGHT',
            body: input.body,
          });
          return this.mapReviewComment(res.data);
        })(),
        TIMEOUT,
      ),
    );
  }

  async openPullRequest(repo: RepoRef, payload: OpenPrPayload): Promise<{ url: string }> {
    return withRetry(() =>
      withTimeout(
        (async () => {
          const res = await this.octokit.rest.pulls.create({
            owner: repo.owner,
            repo: repo.name,
            title: payload.title,
            head: payload.head,
            base: payload.base,
            body: payload.body,
          });
          return { url: res.data.html_url };
        })(),
        TIMEOUT,
      ),
    );
  }

  async commitFiles(
    repo: RepoRef,
    payload: CommitFilesPayload,
  ): Promise<{ branch: string }> {
    return withRetry(() =>
      withTimeout(
        (async () => {
          const owner = repo.owner;
          const name = repo.name;
          const g = this.octokit.rest.git;

          // Parent commit: the target branch if it already exists, else the base.
          let parentSha: string;
          let branchExists = false;
          try {
            const ref = await g.getRef({ owner, repo: name, ref: `heads/${payload.branch}` });
            parentSha = ref.data.object.sha;
            branchExists = true;
          } catch {
            const baseRef = await g.getRef({ owner, repo: name, ref: `heads/${payload.base}` });
            parentSha = baseRef.data.object.sha;
          }

          // New tree layered on the parent's tree (so unrelated files are kept).
          // `deletePaths` are appended as `sha: null` entries — the git tree
          // convention that REMOVES a path from the inherited `base_tree` (used
          // to prune a superseded agent manifest so the runner sees exactly one).
          const parentCommit = await g.getCommit({ owner, repo: name, commit_sha: parentSha });
          const treeEntries: {
            path: string;
            mode: '100644';
            type: 'blob';
            content?: string;
            sha?: null;
          }[] = [
            ...payload.files.map((f) => ({
              path: f.path,
              mode: '100644' as const,
              type: 'blob' as const,
              content: f.contents,
            })),
            ...(payload.deletePaths ?? []).map((path) => ({
              path,
              mode: '100644' as const,
              type: 'blob' as const,
              sha: null,
            })),
          ];
          const tree = await g.createTree({
            owner,
            repo: name,
            base_tree: parentCommit.data.tree.sha,
            tree: treeEntries,
          });

          const commit = await g.createCommit({
            owner,
            repo: name,
            message: payload.message,
            tree: tree.data.sha,
            parents: [parentSha],
          });

          if (branchExists) {
            await g.updateRef({
              owner,
              repo: name,
              ref: `heads/${payload.branch}`,
              sha: commit.data.sha,
              force: true,
            });
          } else {
            await g.createRef({
              owner,
              repo: name,
              ref: `refs/heads/${payload.branch}`,
              sha: commit.data.sha,
            });
          }
          return { branch: payload.branch };
        })(),
        TIMEOUT,
      ),
    ).catch((err) => {
      throw mapGitHubWriteError(err, repo);
    });
  }

  async findOpenPr(repo: RepoRef, branch: string): Promise<{ url: string } | null> {
    return withRetry(() =>
      withTimeout(
        (async () => {
          const res = await this.octokit.rest.pulls.list({
            owner: repo.owner,
            repo: repo.name,
            state: 'open',
            head: `${repo.owner}:${branch}`,
            per_page: 1,
          });
          const pr = res.data[0];
          return pr ? { url: pr.html_url } : null;
        })(),
        TIMEOUT,
      ),
    );
  }

  async getIssue(repo: RepoRef, n: number): Promise<IssueMeta> {
    const res = await withRetry(() =>
      withTimeout(
        this.octokit.rest.issues.get({ owner: repo.owner, repo: repo.name, issue_number: n }),
        TIMEOUT,
      ),
    );
    return {
      number: res.data.number,
      title: res.data.title,
      body: res.data.body,
      state: res.data.state,
    };
  }

  async currentLogin(): Promise<string> {
    const res = await withRetry(() =>
      withTimeout(this.octokit.rest.users.getAuthenticated(), TIMEOUT),
    );
    return res.data.login;
  }

  async getDefaultBranch(repo: RepoRef): Promise<string> {
    return withRetry(() =>
      withTimeout(
        (async () => {
          const { data: repoData } = await this.octokit.rest.repos.get({
            owner: repo.owner,
            repo: repo.name,
          });
          return repoData.default_branch;
        })(),
        TIMEOUT,
      ),
    );
  }

  async getRepoTree(
    repo: RepoRef,
    ref?: string,
  ): Promise<{ path: string; type: 'blob' | 'tree' }[]> {
    return withRetry(() =>
      withTimeout(
        (async () => {
          const owner = repo.owner;
          const name = repo.name;
          let treeSha = ref;
          if (!treeSha) {
            const { data: repoData } = await this.octokit.rest.repos.get({
              owner,
              repo: name,
            });
            treeSha = repoData.default_branch;
          }
          const res = await this.octokit.rest.git.getTree({
            owner,
            repo: name,
            tree_sha: treeSha,
            recursive: '1',
          });
          return res.data.tree
            .filter(
              (entry): entry is typeof entry & { path: string; type: 'blob' | 'tree' } =>
                entry.path != null && (entry.type === 'blob' || entry.type === 'tree'),
            )
            .map((entry) => ({ path: entry.path, type: entry.type }));
        })(),
        TIMEOUT,
      ),
    );
  }

  async getFileContents(repo: RepoRef, path: string, ref?: string): Promise<string | null> {
    try {
      return await withRetry(() =>
        withTimeout(
          (async () => {
            const res = await this.octokit.rest.repos.getContent({
              owner: repo.owner,
              repo: repo.name,
              path,
              ref,
            });
            const data = res.data;
            if (Array.isArray(data) || data.type !== 'file' || !data.content) {
              return null;
            }
            return Buffer.from(data.content, 'base64').toString('utf-8');
          })(),
          TIMEOUT,
        ),
      );
    } catch (err) {
      const status =
        (err as { status?: number })?.status ??
        (err as { response?: { status?: number } })?.response?.status;
      if (status === 404) return null;
      throw err;
    }
  }

  async listWorkflowRuns(
    repo: RepoRef,
    workflowFile: string,
    opts?: { perPage?: number },
  ): Promise<
    { id: number; status: string; conclusion: string | null; html_url: string; created_at: string }[]
  > {
    return withRetry(() =>
      withTimeout(
        (async () => {
          const res = await this.octokit.rest.actions.listWorkflowRuns({
            owner: repo.owner,
            repo: repo.name,
            workflow_id: workflowFile,
            per_page: opts?.perPage ?? 10,
          });
          return res.data.workflow_runs.map((run) => ({
            id: run.id,
            // GitHub types `status` as nullable even though a run always has SOME
            // status in practice — 'unknown' is the safe fallback for the rare
            // type-level null case (this port's contract keeps `status` non-null).
            status: run.status ?? 'unknown',
            conclusion: run.conclusion,
            html_url: run.html_url,
            created_at: run.created_at,
          }));
        })(),
        TIMEOUT,
      ),
    );
  }

  async getWorkflowRun(
    repo: RepoRef,
    runId: number,
  ): Promise<{ id: number; status: string; conclusion: string | null; html_url: string }> {
    return withRetry(() =>
      withTimeout(
        (async () => {
          const res = await this.octokit.rest.actions.getWorkflowRun({
            owner: repo.owner,
            repo: repo.name,
            run_id: runId,
          });
          return {
            id: res.data.id,
            status: res.data.status ?? 'unknown',
            conclusion: res.data.conclusion,
            html_url: res.data.html_url,
          };
        })(),
        TIMEOUT,
      ),
    );
  }

  async listRunArtifacts(
    repo: RepoRef,
    runId: number,
  ): Promise<{ id: number; name: string; expired: boolean }[]> {
    return withRetry(() =>
      withTimeout(
        (async () => {
          const res = await this.octokit.rest.actions.listWorkflowRunArtifacts({
            owner: repo.owner,
            repo: repo.name,
            run_id: runId,
          });
          return res.data.artifacts.map((a) => ({
            id: a.id,
            name: a.name,
            expired: a.expired,
          }));
        })(),
        TIMEOUT,
      ),
    );
  }

  async downloadArtifact(repo: RepoRef, artifactId: number): Promise<Buffer> {
    return withRetry(() =>
      withTimeout(
        (async () => {
          const res = await this.octokit.rest.actions.downloadArtifact({
            owner: repo.owner,
            repo: repo.name,
            artifact_id: artifactId,
            archive_format: 'zip',
          });
          // Empirically verified against the installed octokit@^4.0.3 types
          // (server/node_modules/@octokit/openapi-types): this endpoint's OpenAPI
          // spec documents ONLY a 302 response (`content: never`, a `Location`
          // header) and a 410 — there is no 200 schema at all. Octokit's request
          // layer (built on fetch) follows that redirect automatically, exactly
          // like the browser/curl `-L` behavior GitHub's own docs describe, so at
          // RUNTIME `res.data` IS the raw binary zip body of the redirected
          // response — but because there's no 200 schema for TS to derive a type
          // from, the generated Octokit types fall back to `unknown` for `.data`
          // (confirmed by forcing it into a `string`-typed slot: tsc reported
          // `TS2322: Type 'unknown' is not assignable to type 'string'`, not a
          // `{ url: string }` redirect-descriptor mismatch). Never a redirect URL
          // callers must `fetch()` themselves.
          return Buffer.from(res.data as ArrayBuffer);
        })(),
        TIMEOUT,
      ),
    );
  }
}
