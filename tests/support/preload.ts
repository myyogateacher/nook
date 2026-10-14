import { afterAll } from "bun:test";

// The server log (server/log.ts) stays silent under tests unless a test captures it (captureLogs).
process.env.LOG_LEVEL ??= "silent";

// Runs once after every test file. See tests/support/harness.ts for why the
// harness cannot clean up from its own module scope.
afterAll(() => {
  (globalThis as { __mynotesHarnessCleanup?: () => void }).__mynotesHarnessCleanup?.();
});
