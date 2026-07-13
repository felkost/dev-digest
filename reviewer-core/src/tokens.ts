/**
 * tokens — the single canonical token counter for the engine.
 *
 * A byte-for-byte behavioral port of the server's
 * `src/adapters/tokenizer/index.ts` (`TiktokenTokenizer` / `approxTokens`):
 * a lazily-initialised js-tiktoken `cl100k_base` encoder, permanently falling
 * back to the `ceil(chars / 4)` heuristic the first time the encoder throws
 * (BPE rank load failure). Zero I/O, zero env reads — pure computation, so it
 * is safe to share between the server (local reviews) and the CI runner.
 */
import { getEncoding, type Tiktoken } from 'js-tiktoken';

export type TokenCounter = (text: string) => number;

/**
 * Heuristic fallback used before/instead of a real encoder. Exported (not
 * just internal to `countTokens`) so other modules in this package that need
 * a token estimate without an injected `TokenCounter` (e.g. `boilerplate.ts`'s
 * default) share the exact same formula instead of re-deriving it.
 */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

let enc: Tiktoken | undefined;
let broken = false;

/**
 * Lazily-initialised `cl100k_base` token counter. On the first encoder
 * failure (e.g. BPE ranks fail to load), permanently switches to the
 * `ceil(chars / 4)` heuristic for the lifetime of the process — never
 * retries the real encoder per call.
 */
export const countTokens: TokenCounter = (text: string): number => {
  if (broken) return approxTokens(text);
  try {
    enc ??= getEncoding('cl100k_base');
    return enc.encode(text).length;
  } catch {
    broken = true;
    return approxTokens(text);
  }
};
