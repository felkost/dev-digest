import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunnerBundler } from '@devdigest/shared';
import { ExternalServiceError } from '../../platform/errors.js';

const execFileAsync = promisify(execFile);
// ncc bundles the entire agent-runner + reviewer-core dependency graph (openai
// SDK, zod, etc.) into a single ~1.5 MB file, compiling TypeScript along the
// way — a genuinely heavy operation that measured ~52 s on a loaded Windows dev
// machine. The plan's literal Step text carried over AC-27's 30 s budget here,
// but AC-27 governs the ingest/CHECK path (a user-facing "don't hang the
// screen" poll), NOT this one-time export build — 30 s was too tight and killed
// every real export with a misleading "Failed to build the CI runner bundle".
// 120 s gives a safe margin over the observed cost while still bounding a truly
// stuck build. No test exercises this path (all use MockRunnerBundler), so this
// only surfaces on a real export.
const BUILD_TIMEOUT_MS = 120_000;

/**
 * Builds the `agent-runner` `ncc` bundle fresh on every call (never cached /
 * checked in) so an exported CI installation always ships the CURRENT
 * agent-runner source — staleness here is a correctness/security regression,
 * not a cosmetic one (a stale bundle could silently keep running an old,
 * possibly-vulnerable reviewer-core pipeline in a target repo's CI).
 */
export class NccRunnerBundler implements RunnerBundler {
  async build(): Promise<{ contents: string }> {
    // Resolved relative to import.meta.url (not process.cwd()) so the path is
    // correct regardless of the server's launch directory. NOTE: this is 4
    // levels up because `pnpm dev` (this project's only currently-used runtime
    // mode — see AGENTS.md / scripts/dev.sh, both `tsx watch src/server.ts`)
    // runs this file directly from `server/src/adapters/runner-bundle/`. The
    // compiled `dist/` output (`pnpm build && pnpm start`, not currently wired
    // into any documented workflow) sits one `server/` segment deeper —
    // `server/dist/server/src/...` — because `server/tsconfig.json`'s
    // `rootDir: ".."` preserves that segment (see server/insights.md's
    // 2026-06-27 rootDir Decision entry) — so this exact path math would need
    // adjusting if the compiled-build runtime mode is ever adopted.
    const agentRunnerPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../../agent-runner',
    );

    try {
      // execFile — never exec()/spawn({shell:true}) — fixed argument list, no
      // interpolated input reaches a shell (OWASP A06 command-injection rule).
      // Invokes ncc's own JS CLI entry via `process.execPath` directly rather
      // than the `pnpm` command name: on Windows `pnpm` resolves to a
      // .cmd/.ps1 shim, which execFile cannot launch without a shell (Node
      // can only execFile a native binary or a script with its own shebang).
      const nccCli = path.join(agentRunnerPath, 'node_modules', '@vercel', 'ncc', 'dist', 'ncc', 'cli.js');
      await execFileAsync(process.execPath, [nccCli, 'build', 'src/index.ts', '-o', 'dist'], {
        cwd: agentRunnerPath,
        timeout: BUILD_TIMEOUT_MS,
      });
    } catch (err) {
      throw new ExternalServiceError('Failed to build the CI runner bundle', { cause: err });
    }

    try {
      const contents = await readFile(path.join(agentRunnerPath, 'dist', 'index.js'), 'utf8');
      return { contents };
    } catch (err) {
      throw new ExternalServiceError('Failed to build the CI runner bundle', { cause: err });
    }
  }
}
