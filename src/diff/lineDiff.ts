export type DiffLine = { kind: "same" | "add" | "remove"; text: string };

/**
 * A line diff (longest common subsequence) of two texts, shared by version history and the Inbox's
 * note draft proposals (agent inbox §9.2). Pure, so it is unit-tested.
 */
export function lineDiff(previous: string, current: string): DiffLine[] {
  const before = previous.split("\n");
  const after = current.split("\n");
  const rows = Array.from({ length: before.length + 1 }, () => Array(after.length + 1).fill(0)) as number[][];
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) rows[i]![j] = before[i] === after[j] ? rows[i + 1]![j + 1]! + 1 : Math.max(rows[i + 1]![j]!, rows[i]![j + 1]!);
  }
  const output: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      output.push({ kind: "same", text: before[i]! }); i += 1; j += 1;
    } else if (i < before.length && (j === after.length || rows[i + 1]![j]! >= rows[i]![j + 1]!)) {
      // Removals come before additions in a changed run, the way unified diffs read (− then +).
      output.push({ kind: "remove", text: before[i]! }); i += 1;
    } else {
      output.push({ kind: "add", text: after[j]! }); j += 1;
    }
  }
  return output;
}

/** "+18 −2 lines" for a diff. */
export function diffStats(lines: readonly DiffLine[]) {
  const added = lines.filter((line) => line.kind === "add").length;
  const removed = lines.filter((line) => line.kind === "remove").length;
  return { added, removed, label: `+${added} −${removed} lines` };
}
