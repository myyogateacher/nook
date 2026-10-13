/**
 * Run as a separate `bun` process by tests/attachmentsUndoDurable.test.ts: a "restarted server" on the
 * harness's own data directory (the environment is inherited). It opens the database afresh, with no
 * in-process state from the test process, runs one Undo-record operation, and prints one JSON line.
 *
 * argv[2] is a JSON command:
 * - `{ "op": "relink", "userId", "input": { hostKind, hostId, documentId, partId? } }` → the relink
 *   outcome, or `{ "error": { status, code } }`;
 * - `{ "op": "removed", "userId", "kind", "hostId", "documentId", "nowMs"? }` → the live record or null.
 */
const command = JSON.parse(process.argv[2] ?? "{}") as Record<string, unknown>;
const { removedLink } = await import("../../server/attachments/undoTickets");
const { relinkAttachment } = await import("../../server/attachments/relink");
const { AttachmentError } = await import("../../server/attachments/service");

let result: unknown;
try {
  if (command.op === "relink") {
    result = await relinkAttachment(command.userId as string, command.input as Parameters<typeof relinkAttachment>[1]);
  } else if (command.op === "removed") {
    result = removedLink(command.userId as string, command.kind as "event", command.hostId as string, command.documentId as string, (command.nowMs as number | undefined) ?? Date.now());
  } else {
    result = { error: { code: "UNKNOWN_OP" } };
  }
} catch (error) {
  if (error instanceof AttachmentError) result = { error: { status: error.status, code: error.code } };
  else if (error && typeof error === "object" && "status" in error) result = { error: { status: (error as { status: number }).status, code: (error as { code?: string }).code ?? null } };
  else throw error;
}
console.log(JSON.stringify(result));
process.exit(0);
