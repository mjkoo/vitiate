/**
 * Crash input minimization: two-pass strategy (truncation + byte deletion).
 *
 * Accepts a testCandidate callback so the core logic can be reused by
 * a future standalone minimization tool with a different execution backend.
 */

export interface MinimizeOptions {
  /** Maximum number of target re-executions. Default: 10,000. */
  maxIterations?: number;
  /** Maximum wall-clock time in ms for the entire minimization phase. Default: 5,000. */
  timeLimitMs?: number;
}

const DEFAULT_MAX_ITERATIONS = 10_000;
const DEFAULT_TIME_LIMIT_MS = 5_000;

/**
 * Minimize a crashing input to the smallest byte sequence that still triggers
 * the crash. Uses a two-pass strategy:
 *
 * 1. Truncation: binary search on input prefix length (O(log n) executions).
 * 2. Byte deletion: walk and remove one byte at a time (O(n) executions).
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
  let best: Buffer = input;

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

  // Pass 1: Truncation — binary search on input prefix length
  if (best.length > 0 && !budgetExhausted()) {
    let lo = 0;
    let hi = best.length;

    while (lo < hi && !budgetExhausted()) {
      const mid = lo + Math.floor((hi - lo) / 2);
      if (mid === 0 && lo === 0) {
        // Try empty buffer
        const candidate = best.subarray(0, 0);
        if (await tryCandidate(candidate)) {
          best = Buffer.from(candidate);
          break;
        }
        lo = 1;
        continue;
      }

      const candidate = best.subarray(0, mid);
      if (await tryCandidate(candidate)) {
        // Shorter prefix still crashes — keep it and search shorter
        best = Buffer.from(candidate);
        hi = best.length;
        lo = 0;
      } else {
        // Too short — need more bytes
        lo = mid + 1;
      }
    }
  }

  // Pass 2: Byte deletion — walk and remove one byte at each position
  if (best.length > 0 && !budgetExhausted()) {
    let pos = 0;
    while (pos < best.length && !budgetExhausted()) {
      // Remove the byte at pos
      const candidate = Buffer.concat([
        best.subarray(0, pos),
        best.subarray(pos + 1),
      ]);

      if (await tryCandidate(candidate)) {
        // Deletion succeeded — keep it, stay at same position
        // (next byte now occupies this index)
        best = candidate;
      } else {
        // Deletion failed — restore and advance
        pos++;
      }
    }
  }

  process.stderr.write(
    `vitiate: minimization pass complete: ${best.length} bytes (${execCount} executions)\n`,
  );

  return best;
}
