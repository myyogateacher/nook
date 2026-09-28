import { context, layout, note, type ContextRow } from "../layout";
import { appLink, paths } from "../links";
import { formatDay, formatInstant, plural } from "../format";
import { activityFooter, actorsPhrase, itemTitle, LIST_MAX } from "./common";
import { defineTemplate } from "./types";

// --- Sprint started or completed (#20), off by default (D236) -----------------------------------

export type SprintMail = {
  boardId: string;
  boardName: string;
  sprintName: string;
  event: "started" | "completed";
  actors: string[];
  startOn: string | null;
  endOn: string | null;
  /** Live cards in the sprint (started), or done and carried over (completed). */
  total: number;
  done: number;
  carried: number;
  /** The recipient's own assigned cards in it. */
  yours: { total: number; done: number; carried: number };
};

export const sprintTemplate = defineTemplate<SprintMail>({
  name: "tasks.sprint",
  class: "activity",
  category: "sprints",
  render(data, ctx) {
    const sprint = itemTitle(data.sprintName, "Sprint");
    const board = itemTitle(data.boardName);
    const who = actorsPhrase(data.actors);
    const started = data.event === "started";
    const dates = data.startOn && data.endOn ? `${formatDay(data.startOn)} – ${formatDay(data.endOn)}` : data.endOn ? `Ends ${formatDay(data.endOn)}` : null;
    const rows: ContextRow[] = [{
      title: sprint,
      meta: [dates, started ? plural(data.total, "card") : `${data.done} done · ${data.carried} carried over`].filter(Boolean).join(" · ")
    }, {
      title: "Your cards",
      meta: started ? `${plural(data.yours.total, "card")} assigned to you` : `${data.yours.done} done · ${data.yours.carried} carried over`
    }];
    return layout({
      instanceName: ctx.instanceName,
      subject: started ? `${sprint} started on ${board}` : `${sprint} is complete on ${board}`,
      preheader: started ? `${plural(data.yours.total, "card")} of yours are in it.` : `${data.done} done, ${data.carried} carried over.`,
      eyebrow: started ? "Tasks · Sprint started" : "Tasks · Sprint complete",
      title: started ? `${who} started ${sprint}` : `${who} completed ${sprint}`,
      lead: `On the board ${board}.`,
      blocks: [context(rows)],
      action: { label: "Open sprints", href: appLink(paths.sprints(data.boardId)) },
      footer: activityFooter("sprints", "You got this because cards assigned to you are in this sprint.", ctx)
    });
  },
  fixture: () => ({
    boardId: "5f0c5a6e-1b2d-4c3e-8f4a-111111111111",
    boardName: "Launch",
    sprintName: "Sprint 12",
    event: "started",
    actors: ["Priya Shah"],
    startOn: "2026-09-28",
    endOn: "2026-10-09",
    total: 14,
    done: 0,
    carried: 0,
    yours: { total: 3, done: 0, carried: 0 }
  })
});

// --- Items leaving your Bin in 3 days (#29), off by default (D243) -----------------------------

export type BinExpiringMail = { items: Array<{ kind: string; title: string }>; total: number; soonest: string };

export const binExpiringTemplate = defineTemplate<BinExpiringMail>({
  name: "bin.expiring",
  class: "activity",
  category: "bin",
  render(data, ctx) {
    const rows: ContextRow[] = data.items.slice(0, LIST_MAX).map((item) => ({ title: itemTitle(item.title), meta: item.kind }));
    return layout({
      instanceName: ctx.instanceName,
      subject: `${plural(data.total, "item")} ${data.total === 1 ? "leaves" : "leave"} your Bin within 3 days`,
      preheader: "Restore anything you still need before it is deleted for good.",
      eyebrow: "Bin · Clean-up",
      title: `${plural(data.total, "item")} will be deleted for good`,
      lead: `The first is deleted on ${formatInstant(data.soonest, ctx.tz)}. Restore anything you still need from the Bin.`,
      blocks: [context(rows, { more: data.total - rows.length }), note("Nook deletes Bin items 30 days after they were moved there. This email comes at most once a week.")],
      action: { label: "Open the Bin", href: appLink(paths.bin()) },
      footer: activityFooter("bin", "You got this because you turned on Bin clean-up emails.", ctx)
    });
  },
  fixture: () => ({
    items: [{ kind: "Note", title: "Old meeting notes" }, { kind: "File", title: "draft-v1.pdf" }, { kind: "Card", title: "Try the old parser" }],
    total: 3,
    soonest: "2026-10-01T09:00:00.000Z"
  })
});
