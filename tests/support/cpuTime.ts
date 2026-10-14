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
