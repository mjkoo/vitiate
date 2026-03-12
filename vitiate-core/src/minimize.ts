/**
 * Crash input minimization: two-pass strategy (truncation + byte deletion).
 *
 * Accepts a testCandidate callback so the core logic can be reused by
 * a future standalone minimization tool with a different execution backend.
 */

export interface MinimizeOptions {
  /** Maximum number of target re-executions. Default: 10,000. 0 means unlimited. */
  maxIterations?: number;
  /** Maximum wall-clock time in ms for the entire minimization phase. Default: 5,000. 0 means unlimited. */
  timeLimitMs?: number;
}

const DEFAULT_MAX_ITERATIONS = 10_000;
const DEFAULT_TIME_LIMIT_MS = 5_000;

/**
 * Minimize a crashing input to the smallest byte sequence that still triggers
 * the crash. Uses a two-pass strategy:
 *
 * 1. Truncation: binary search on input prefix length (O(log n) executions).
 * 2. Byte deletion: walk and remove one byte at a time (O(n) executions in the
 *    length of the post-truncation input).
 *
 * :param input: The original crashing input.
 * :param testCandidate: Returns true if the candidate still crashes.
 * :param options: Budget limits for iteration count and wall-clock time.
 * :returns: The smallest crashing input found within budget.
 */
export async function minimize(
  input: Buffer,
  testCandidate: (candidate: Buffer) => Promise<boolean>,
  options?: MinimizeOptions,
): Promise<Buffer> {
  const maxIterations = options?.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const timeLimitMs = options?.timeLimitMs ?? DEFAULT_TIME_LIMIT_MS;
  const startTime = Date.now();
  let execCount = 0;
  let best: Buffer = Buffer.from(input);

  process.stderr.write(
    `vitiate: minimizing crash input (${input.length} bytes)...\n`,
  );

  function budgetExhausted(): boolean {
    if (maxIterations > 0 && execCount >= maxIterations) return true;
    if (timeLimitMs > 0 && Date.now() - startTime >= timeLimitMs) return true;
    return false;
  }

  async function tryCandidate(candidate: Buffer): Promise<boolean> {
    execCount++;
    return testCandidate(candidate);
  }

  // Pass 1: Truncation - binary search on input prefix length.
  // lo is the shortest known-bad length, hi is the longest known-good length.
  // We converge on the minimal prefix that still crashes.
  if (best.length > 0 && !budgetExhausted()) {
    let lo = 0;
    let hi = best.length;

    while (lo < hi && !budgetExhausted()) {
      const mid = lo + Math.floor((hi - lo) / 2);
      const candidate = best.subarray(0, mid);
      if (await tryCandidate(candidate)) {
        // Prefix of length mid still crashes - try shorter
        hi = mid;
      } else {
        // Too short - need more bytes
        lo = mid + 1;
      }
    }

    if (hi < best.length) {
      // Copy: best is used as the source for subarray in pass 2, so it must
      // own its own memory rather than aliasing the original input.
      best = Buffer.from(best.subarray(0, hi));
    }
  }

  // Pass 2: Byte deletion - walk and remove one byte at each position
  if (best.length > 0 && !budgetExhausted()) {
    let pos = 0;
    while (pos < best.length && !budgetExhausted()) {
      // Remove the byte at pos
      const candidate = Buffer.concat([
        best.subarray(0, pos),
        best.subarray(pos + 1),
      ]);

      if (await tryCandidate(candidate)) {
        // Deletion succeeded - keep it, stay at same position
        // (next byte now occupies this index)
        best = candidate;
      } else {
        // Deletion failed - restore and advance
        pos++;
      }
    }
  }

  process.stderr.write(
    `vitiate: minimization pass complete: ${best.length} bytes (${execCount} executions)\n`,
  );

  return best;
}
