import { db } from "../db";
import { moduleItemMail } from "../mail/moduleItemMail";

/**
 * Goals' email (D1370): a goal at risk or off track, a check-in due, and being made a goal's owner or
 * a contributor. Ids and enums only in the payload; the goal is read again as the recipient when the
 * mail is sent (server/mail/moduleItemMail.ts). A health mail whose goal has recovered meanwhile, or a
 * check-in mail for a goal checked in since, is not sent.
 */
export const GOALS_MAIL_TEMPLATE = "goals.update";

const goalNow = (id: string) => db.query("SELECT health, state, owner_id, last_checkin_at FROM goals WHERE id = ? AND deleted_at IS NULL").get(id) as { health: string; state: string; owner_id: string; last_checkin_at: string | null } | null;

export const goalsMailTemplates = {
  [GOALS_MAIL_TEMPLATE]: moduleItemMail({
    name: GOALS_MAIL_TEMPLATE,
    category: "goals",
    eyebrow: "Goals",
    reason: "You got this because you own or contribute to this goal, or own the goal above it.",
    describe: ({ payload, actor, recipient }) => {
      const goal = goalNow(payload.id);
      if (!goal) return null;
      switch (payload.topic) {
        case "goals.health_changed": {
          if (goal.health !== "at_risk" && goal.health !== "off_track") return null;
          const words = goal.health === "at_risk" ? "at risk" : "off track";
          return { title: `A goal is ${words}`, lead: `${actor ?? "Someone"} marked this goal ${words}.`, meta: `Goal · ${goal.health === "at_risk" ? "At risk" : "Off track"}` };
        }
        case "goals.checkin_due": {
          const since = typeof payload.at === "string" ? payload.at : null;
          if (goal.state !== "active" || (since && goal.last_checkin_at && goal.last_checkin_at > since)) return null;
          return { title: "A goal is due a check-in", lead: goal.last_checkin_at ? "It's time for this goal's check-in." : "This goal has no check-in yet.", meta: "Goal · Check-in due", action: "Check in" };
        }
        case "goals.assigned": {
          const owner = payload.role === "owner";
          if (owner && goal.owner_id !== recipient.id) return null;
          return {
            title: owner ? "You own a goal now" : "You were added to a goal",
            lead: owner ? `${actor ?? "Someone"} made you this goal's owner.` : `${actor ?? "Someone"} added you as a contributor.`,
            meta: owner ? "Goal · Owner" : "Goal · Contributor"
          };
        }
        default:
          return null;
      }
    },
    fixture: () => ({
      title: "A goal is at risk", lead: "Priya Shah marked this goal at risk.", item: "Grow monthly revenue to $50k",
      meta: "Goal · At risk", href: "https://nook.example/goals/grow-monthly-revenue-k7f3q2ab01", action: "Open the goal"
    })
  })
};
