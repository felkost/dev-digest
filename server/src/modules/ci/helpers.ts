import type { CiFile } from '@devdigest/shared';
import { agentManifestYaml, type ManifestAgentInput } from './manifest.js';
import { generateWorkflowYaml } from './workflow.js';

/**
 * Name of the GitHub Actions artifact the generated workflow uploads
 * (`workflow.ts`) and the one the ingest side (a later step, `ingest-helpers.ts`)
 * downloads by. Both sides import this SAME constant — never a string
 * literal duplicated in two files — so the upload name and the
 * download-selection name can never drift apart.
 */
export const CI_RESULT_ARTIFACT_NAME = 'devdigest-result';

/**
 * Lowercase, collapse any run of non-`[a-z0-9]` characters to a single `-`,
 * trim leading/trailing `-`, cap at ~60 chars (re-trimmed after the cap in
 * case slicing lands exactly on a hyphen).
 */
export function slugify(name: string): string {
  const collapsed = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return collapsed.slice(0, 60).replace(/-+$/g, '');
}

/**
 * Appends `-2`, `-3`, ... to `base` until the result is absent from
 * `existing`. Pure — does NOT mutate `existing`; the caller is responsible
 * for adding the returned slug before deduping the next candidate.
 */
export function dedupeSlug(existing: ReadonlySet<string>, base: string): string {
  if (!existing.has(base)) return base;
  let n = 2;
  while (existing.has(`${base}-${n}`)) {
    n += 1;
  }
  return `${base}-${n}`;
}

/**
 * An agent manifest path under `.devdigest/agents/`. The runner
 * (`agent-runner/src/manifest.ts`) globs `*.yaml`/`*.yml` there and requires
 * EXACTLY one, so both extensions count as a manifest.
 */
const AGENT_MANIFEST_RE = /^\.devdigest\/agents\/[^/]+\.ya?ml$/;

/**
 * Given every path currently on the CI branch and the manifest path this
 * export is about to (re-)write, returns the OTHER agent manifests that must be
 * DELETED in the same commit. An earlier export for a DIFFERENT agent leaves
 * its own `.devdigest/agents/<old-slug>.yaml` behind (`commitFiles` is additive
 * — it never removes files), and two manifests hard-fail the runner (`Expected
 * exactly one agent manifest ... found N` — see server/insights.md 2026-07-11).
 * Anything matching the manifest shape except `keepPath` is stale and pruned.
 * Pure: no I/O. `keepPath` is the path of the manifest in the freshly composed
 * file set (never deleted), so the net post-commit state is exactly one.
 */
export function staleAgentManifests(treePaths: string[], keepPath: string | undefined): string[] {
  return treePaths.filter((p) => AGENT_MANIFEST_RE.test(p) && p !== keepPath);
}

export interface ComposeCiFilesParams {
  /**
   * Frozen configuration-file identity for this installation. Taken as an
   * explicit input and NEVER re-derived from `agent.name` here — a later
   * rename of the agent must never shift the exported file's path. The
   * caller (a later step's service) is responsible for always supplying the
   * SAME slug across repeat exports of the same installation.
   */
  slug: string;
  agent: ManifestAgentInput;
  /** Linked + enabled skills for this export — an empty array is valid (no skill files at all). */
  skills: { name: string; body: string }[];
  triggers: string[];
  postAs: 'github_review' | 'pr_comment' | 'none';
  /** User-edited workflow YAML (Export Wizard), committed verbatim instead of a freshly generated one. */
  workflowOverride?: string | null;
  /** The CI runner's `ncc` bundle contents (built by the `RunnerBundler` adapter). */
  runnerBundleContents: string;
}

/**
 * Assembles the flat file list for one installation (v1 — one agent per
 * repository). Pure function: no file-system/network/DB access — every
 * input arrives already resolved by the caller.
 *
 * All non-workflow files are `editable: false`; only the generated (or
 * overridden) workflow file is `editable: true`.
 */
export function composeCiFiles(params: ComposeCiFilesParams): CiFile[] {
  const usedSlugs = new Set<string>();
  const skillFiles: CiFile[] = [];
  const skillSlugs: string[] = [];

  for (const skill of params.skills) {
    const skillSlug = dedupeSlug(usedSlugs, slugify(skill.name));
    usedSlugs.add(skillSlug);
    skillSlugs.push(skillSlug);
    skillFiles.push({
      path: `.devdigest/skills/${skillSlug}.md`,
      contents: skill.body,
      editable: false,
    });
  }

  const workflowYaml =
    params.workflowOverride ??
    generateWorkflowYaml({
      triggers: params.triggers,
      postAs: params.postAs,
      resultArtifactName: CI_RESULT_ARTIFACT_NAME,
    });

  return [
    {
      path: `.devdigest/agents/${params.slug}.yaml`,
      contents: agentManifestYaml(params.agent, skillSlugs),
      editable: false,
    },
    ...skillFiles,
    { path: '.devdigest/memory.jsonl', contents: '', editable: false },
    { path: '.github/workflows/devdigest-review.yml', contents: workflowYaml, editable: true },
    { path: '.devdigest/runner/index.js', contents: params.runnerBundleContents, editable: false },
  ];
}
