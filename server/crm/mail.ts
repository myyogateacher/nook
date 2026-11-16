import { db } from "../db";
import { moduleItemMail } from "../mail/moduleItemMail";

/**
 * Contacts' email (D1370): a follow-up due, being made a deal's owner, and a deal you own won or lost.
 * Ids and enums only in the payload; the record is read again as the recipient when the mail is sent
 * (server/mail/moduleItemMail.ts), never a note's or a contact's details. A follow-up done meanwhile,
 * or a deal whose owner changed again, is not mailed.
 */
export const CRM_MAIL_TEMPLATE = "crm.update";

export const crmMailTemplates = {
  [CRM_MAIL_TEMPLATE]: moduleItemMail({
    name: CRM_MAIL_TEMPLATE,
    category: "crm",
    eyebrow: "Contacts",
    reason: "You got this because you own this deal or set this follow-up.",
    describe: ({ payload, actor, recipient, kindLabel }) => {
      switch (payload.topic) {
        case "crm.followup_due": {
          const row = typeof payload.followupId === "string"
            ? db.query("SELECT user_id, done_at FROM crm_followups WHERE id = ?").get(payload.followupId) as { user_id: string; done_at: string | null } | null
            : null;
          if (!row || row.done_at || row.user_id !== recipient.id) return null;
          return { title: `Follow up on a ${kindLabel.toLowerCase()}`, lead: "A follow-up you set is due.", meta: `${kindLabel} · Follow-up due` };
        }
        case "crm.deal_assigned": {
          const deal = db.query("SELECT owner_id FROM deals WHERE id = ? AND deleted_at IS NULL").get(payload.id) as { owner_id: string | null } | null;
          if (!deal || deal.owner_id !== recipient.id) return null;
          return { title: "You own a deal now", lead: `${actor ?? "Someone"} made you this deal's owner.`, meta: "Deal · Owner" };
        }
        case "crm.deal_won":
        case "crm.deal_lost": {
          const won = payload.topic === "crm.deal_won";
          return { title: won ? "A deal you own was won" : "A deal you own was lost", lead: `${actor ?? "Someone"} moved it to ${won ? "won" : "lost"}.`, meta: `Deal · ${won ? "Won" : "Lost"}` };
        }
        default:
          return null;
      }
    },
    fixture: () => ({
      title: "A deal you own was won", lead: "Sam Lee moved it to won.", item: "Acme annual plan",
      meta: "Deal · Won", href: "https://nook.example/contacts/deals/acme-annual-plan-k7f3q2ab01", action: "Open the deal"
    })
  })
};
