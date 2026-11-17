import { moduleItemMail } from "../mail/moduleItemMail";

/**
 * Time's email (D1370): a week submitted for a manager's approval, a person's week approved, returned,
 * or unlocked, and a project's budget alerts (80% and 100%). Ids and enums only in the payload; the
 * project is read again as the recipient when the mail is sent (server/mail/moduleItemMail.ts).
 */
export const TIME_MAIL_TEMPLATE = "time.update";
const WEEK = /^\d{4}-\d{2}-\d{2}$/;

export const timeMailTemplates = {
  [TIME_MAIL_TEMPLATE]: moduleItemMail({
    name: TIME_MAIL_TEMPLATE,
    category: "time",
    eyebrow: "Time",
    reason: "You got this because you manage this time project or log time on it.",
    describe: ({ payload, actor, summary }) => {
      const week = typeof payload.weekStart === "string" && WEEK.test(payload.weekStart) ? payload.weekStart : null;
      switch (payload.topic) {
        case "time.approval":
          return week ? { title: `${actor ?? "Someone"} submitted the week of ${week}`, lead: "A week of time is waiting for your approval.", meta: `Week of ${week} · Waiting for approval`, action: "Review approvals", path: `${summary.href}?tab=approvals` } : null;
        case "time.approval_decided": {
          const decision = payload.decision === "approve" ? "approved" : payload.decision === "reject" ? "returned" : payload.decision === "unlock" ? "unlocked" : null;
          if (!week || !decision) return null;
          return {
            title: `Your week of ${week} was ${decision}`,
            lead: `${actor ?? "A manager"} ${decision} your week${decision === "returned" ? ". Check it and submit it again" : ""}.`,
            meta: `Week of ${week}`, action: "Open your timesheet", path: `/time/timesheet?week=${week}`
          };
        }
        case "time.budget": {
          const threshold = payload.threshold === 100 ? 100 : payload.threshold === 80 ? 80 : null;
          if (!threshold) return null;
          return {
            title: threshold === 100 ? "A project is over its budget" : "A project has used 80% of its budget",
            lead: threshold === 100 ? "Time logged on this project is now over its budget." : "Time logged on this project has reached 80% of its budget.",
            meta: `Budget · ${threshold}% used`
          };
        }
        default:
          return null;
      }
    },
    fixture: () => ({
      title: "Priya Shah submitted the week of 2026-11-09", lead: "A week of time is waiting for your approval.", item: "Website redesign",
      meta: "Week of 2026-11-09 · Waiting for approval", href: "https://nook.example/time/projects/website-redesign-k7f3q2ab01?tab=approvals", action: "Review approvals"
    })
  })
};
