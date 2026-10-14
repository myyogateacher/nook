/**
 * Work budgets in tests are measured in CPU time, not wall time. Several `bun test` runs share a
 * host, and an oversubscribed CPU stretches wall time two or three times (a 150 ms median read 160 ms
 * beside a second suite and a busy loop) while the work done stays the same. The process's CPU time
 * (user + system, all threads) counts only what this process did, so a slower query still fails its
 * budget and a busy neighbour does not.
 */

/** Milliseconds of CPU time this process spent running `work` (synchronous work only). */
export function cpuMs(work: () => unknown) {
  const before = process.cpuUsage();
  work();
  const used = process.cpuUsage(before);
  return (used.user + used.system) / 1000;
}

/**
 * The async form, for in-process work that awaits (no network peer: any other work the process does
 * while it waits is counted too, so keep the measured section free of unrelated timers).
 */
export async function cpuMsAsync(work: () => Promise<unknown>) {
  const before = process.cpuUsage();
  await work();
  const used = process.cpuUsage(before);
  return (used.user + used.system) / 1000;
}

/**
 * Per-test timeout for a test that does a second or more of CPU work unloaded (a migration run on a
 * fresh database, thousands of rows, 10 KB inputs through every template). Bun's 5 s default left
 * them no room when several suites shared the CPUs (load average 15-20 stretched them past 6 s).
 * Only for such tests; a test that waits on something waits on its condition instead.
 */
export const HEAVY_TEST_TIMEOUT_MS = 20_000;
