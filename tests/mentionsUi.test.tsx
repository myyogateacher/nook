import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownManager } from "@tiptap/markdown";
import { markdownOptions, noteContentExtensions } from "../src/editor/extensions";
import { parseMentionToken } from "../src/editor/mention";
import { closesOnSpace, findMentionTrigger, firstSelectable, insertMention, mentionKeyAction, moveSelection } from "../src/ui/mentions/mentionModel";
import { popoverPlace } from "../src/ui/mentions/MentionTextarea";
import { MentionChip, MentionList, MentionText } from "../src/ui/mentions/Mentions";
import { resetMentionAvatars, seedMentionAvatars } from "../src/ui/mentions/mentionAvatars";
import { RoleContext } from "../src/team/roleAccess";
import { mentionMarkdown, newMentionIds, splitMentions, type MentionCandidate } from "../shared/itemActivity";

/** The @mention picker, chips, and Markdown (docs/plan/MENTIONS.md §2, §3, §6, D1320–D1322, D1329). */

const ana = "0b7c1a52-3f5e-4d8e-9a51-0c6a7f2b9d11";
const ben = "1c8d2b63-4a6f-4e9f-8b62-1d7b803cae22";
const cy = "2d9e3c74-5b70-4fa0-9c73-2e8c914dbf33";
const people: MentionCandidate[] = [
  { id: ana, displayName: "Ana Silva", avatarUrl: null, canRead: true },
  { id: ben, displayName: "Ben Okafor", avatarUrl: null, canRead: false },
  { id: cy, displayName: "Cy Park", avatarUrl: null, canRead: true }
];

test("the trigger opens at the start, after whitespace or '(', never inside a word or an email", () => {
  expect(findMentionTrigger("@an", 3)).toEqual({ start: 0, query: "an" });
  expect(findMentionTrigger("hi @ana si", 10)).toEqual({ start: 3, query: "ana si" });
  expect(findMentionTrigger("ping (@cy", 9)).toEqual({ start: 6, query: "cy" });
  expect(findMentionTrigger("hi @", 4)).toEqual({ start: 3, query: "" });
  expect(findMentionTrigger("ana@example.com", 15)).toBeNull();
  expect(findMentionTrigger("line\n@", 6)).toEqual({ start: 5, query: "" });
  expect(findMentionTrigger("@an\nmore", 8)).toBeNull();
  // A mention already written out, a leading space, or too long a query does not reopen it.
  expect(findMentionTrigger(`${mentionMarkdown("Ana", ana)}`, 10)).toBeNull();
  expect(findMentionTrigger("email me @ 5", 12)).toBeNull();
  expect(findMentionTrigger(`@${"a".repeat(41)}`, 42)).toBeNull();
});

test("inserting replaces the query with the mention and one space, and puts the caret after it", () => {
  const text = "hi @an thanks";
  const trigger = findMentionTrigger(text, 6)!;
  const result = insertMention(text, trigger, 6, { id: ana, displayName: "Ana Silva" });
  expect(result.text).toBe(`hi ${mentionMarkdown("Ana Silva", ana)} thanks`);
  expect(result.text.slice(result.caret)).toBe("thanks");
  const end = insertMention("@an", { start: 0, query: "an" }, 3, { id: ana, displayName: "Ana [x]" });
  expect(end.text).toBe(`@[Ana x](user:${ana}) `);
  expect(end.caret).toBe(end.text.length);
});

test("keyboard: down and up wrap and skip people who cannot read; Enter and Tab pick; Escape closes; modifiers pass", () => {
  expect(firstSelectable(people)).toBe(0);
  expect(moveSelection(people, 0, 1)).toBe(2);
  expect(moveSelection(people, 2, 1)).toBe(0);
  expect(moveSelection(people, 0, -1)).toBe(2);
  expect(moveSelection(people, -1, -1)).toBe(2);
  expect(moveSelection([{ canRead: false }], 0, 1)).toBe(-1);
  expect(firstSelectable([{ canRead: false }])).toBe(-1);
  expect(mentionKeyAction("ArrowDown")).toBe("down");
  expect(mentionKeyAction("ArrowUp")).toBe("up");
  expect(mentionKeyAction("Enter")).toBe("pick");
  expect(mentionKeyAction("Tab")).toBe("pick");
  expect(mentionKeyAction("Tab", { shift: true })).toBeNull();
  expect(mentionKeyAction("Escape")).toBe("close");
  // ⌘Enter still sends the comment.
  expect(mentionKeyAction("Enter", { meta: true })).toBeNull();
  expect(mentionKeyAction("a")).toBeNull();
  expect(closesOnSpace("ana ", 0)).toBe(true);
  expect(closesOnSpace("ana ", 1)).toBe(false);
  expect(closesOnSpace("ana", 0)).toBe(false);
});

test("the list is a listbox; people who cannot read are greyed, aria-disabled, and say so", () => {
  const markup = renderToStaticMarkup(<MentionList id="m" people={people} active={0} loading={false} noun="card" onPick={() => undefined} onActive={() => undefined} />);
  expect(markup).toContain('role="listbox"');
  expect(markup).toContain('id="m-option-0" role="option" aria-selected="true"');
  expect(markup).toMatch(/id="m-option-1" role="option" aria-selected="false" aria-disabled="true" class="mention-option is-unavailable"/);
  expect(markup).toContain("Can&#x27;t see this card");
  expect(markup).not.toContain("<select");
  expect(renderToStaticMarkup(<MentionList id="m" people={[]} active={-1} loading={false} noun="card" onPick={() => undefined} onActive={() => undefined} />)).toContain("No one matches");
});

test("chips: a button to the profile for people who see the Team, text for guests; text keeps its words", () => {
  const member = renderToStaticMarkup(<RoleContext.Provider value="member"><MentionChip name="Ana Silva" userId={ana} /></RoleContext.Provider>);
  expect(member).toContain('<button type="button" class="mention-chip"');
  expect(member).toContain("Open Ana Silva&#x27;s profile");
  expect(member).toContain("<span>@Ana Silva</span>");
  const asGuest = renderToStaticMarkup(<RoleContext.Provider value="guest"><MentionChip name="Ana Silva" userId={ana} /></RoleContext.Provider>);
  expect(asGuest).toContain('<span class="mention-chip"');
  expect(asGuest).not.toContain("<button");
  const text = renderToStaticMarkup(<RoleContext.Provider value="member"><MentionText text={`Ask ${mentionMarkdown("Ana Silva", ana)} <b>now</b>`} /></RoleContext.Provider>);
  expect(text.startsWith("Ask ")).toBe(true);
  expect(text).toContain("&lt;b&gt;now&lt;/b&gt;");
  expect(text).not.toContain("user:");
  expect(splitMentions("plain")).toEqual([{ type: "text", text: "plain" }]);
  expect(newMentionIds(mentionMarkdown("A", ana), `${mentionMarkdown("A", ana)} ${mentionMarkdown("C", cy.toUpperCase())}`)).toEqual([cy]);
});

test("the popover stays in the viewport and flips above the caret when there is no room below", () => {
  expect(popoverPlace({ left: 100, top: 100, height: 20 }, { width: 1440, height: 900 }, 200)).toEqual({ left: 88, top: 126, width: 280 });
  expect(popoverPlace({ left: 380, top: 700, height: 20 }, { width: 390, height: 844 }, 200)).toEqual({ left: 98, top: 494, width: 280 });
  expect(popoverPlace({ left: 10, top: 10, height: 20 }, { width: 300, height: 844 }, 200).width).toBe(276);
});

test("rich editor: a mention round-trips through Markdown as one node, and odd text stays text", () => {
  const manager = new MarkdownManager({ extensions: noteContentExtensions(), markedOptions: markdownOptions });
  const markdown = `Owner: ${mentionMarkdown("Ana Silva", ana)} and ${mentionMarkdown("Cy", cy)}, thanks\n\n- [ ] ask ${mentionMarkdown("Ana Silva", ana)}`;
  const doc = manager.parse(markdown);
  const nodes = JSON.stringify(doc);
  expect(nodes).toContain(`"type":"mention","attrs":{"id":"${ana}","label":"Ana Silva"}`);
  expect(nodes).not.toContain("user:");
  expect(manager.serialize(doc)).toBe(markdown);
  // Not a mention: a link with another scheme, a bad id, and an email stay as they were.
  for (const plain of ["@[Ana](user:not-a-uuid)", "mail ana@example.com", "[Ana](https://example.com)"]) {
    expect(JSON.stringify(manager.parse(plain))).not.toContain('"mention"');
  }
  expect(parseMentionToken(`${mentionMarkdown("Ana", ana.toUpperCase())} rest`)).toEqual({ raw: mentionMarkdown("Ana", ana.toUpperCase()), id: ana, label: "Ana" });
  expect(parseMentionToken("@[Ana]")).toBeNull();
});

test("marks around a mention survive the round-trip; code keeps the Markdown as text (D1337)", () => {
  const manager = new MarkdownManager({ extensions: noteContentExtensions(), markedOptions: markdownOptions });
  const m = mentionMarkdown("Cy", cy);
  for (const markdown of [`**${m}**`, `**see ${m} now**`, `*${m}* and ~~${m}~~`, `[ask ${m}](https://example.com)`, `a \\* ${m} \\[b\\]`]) {
    const doc = manager.parse(markdown);
    expect(JSON.stringify(doc)).toContain('"type":"mention"');
    expect(manager.serialize(doc)).toBe(markdown);
  }
  const bold = JSON.stringify(manager.parse(`**${m}**`));
  expect(bold).toMatch(/"type":"mention","attrs":\{[^}]*\},"marks":\[\{"type":"bold"/);
  // Inside inline code or a code block it is text, and stays the same text.
  for (const markdown of [`\`${m}\``, `\`\`\`\n${m}\n\`\`\``]) {
    const doc = manager.parse(markdown);
    expect(JSON.stringify(doc)).not.toContain('"type":"mention"');
    expect(manager.serialize(doc)).toBe(markdown);
  }
});

test("a chip shows the person's picture once it is known (T353: only Nook's own avatar route)", () => {
  resetMentionAvatars();
  const url = `/api/users/${ana}/avatar?v=${cy}`;
  seedMentionAvatars([{ id: ana, avatarUrl: url }, { id: ben, avatarUrl: "https://evil.example/x.png" }]);
  const markup = renderToStaticMarkup(<RoleContext.Provider value="member"><MentionChip name="Ana Silva" userId={ana} /><MentionChip name="Ben" userId={ben} /></RoleContext.Provider>);
  expect(markup).toContain(`<img src="${url.replace("&", "&amp;")}"`);
  expect(markup).not.toContain("evil.example");
  resetMentionAvatars();
});

