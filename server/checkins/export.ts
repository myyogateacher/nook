import { audit } from "../db";
import { CSV_EXPORT_ROWS, csvText } from "../csvExport";
import { answerText } from "../questions/service";
import type { Question } from "../../shared/questions";
import { checkinRow } from "./store";
import { roundsPage, roundView } from "./views";

/**
 * A standup's answers as CSV (D1387), the rounds the viewer can read, newest first (at most 100
 * rounds): what the round page shows them, through the same `roundView`. A named standup has one row
 * per participant (answered, late, skipped, or still pending); an anonymous one has one row per
 * answer, without names or times of day, and nothing for a round still under its answer threshold.
 * Audited (`checkins.export`).
 */

const STATUS: Record<string, string> = { pending: "Not answered", answered: "Answered", late: "Answered late", skipped: "Skipped", out: "Out" };

export function checkinCsv(ref: string, userId: string, maxRounds = 100) {
  const checkin = checkinRow(ref);
  const rounds = roundsPage(ref, userId, null, maxRounds).items;
  const questions = new Map<string, Question>();
  const lines: Array<{ date: string; person: string; status: string; submitted: string; answers: Record<string, string> }> = [];
  for (const item of rounds) {
    const view = roundView(item.id, userId);
    if (view.hiddenUntil !== null) continue;
    const anonymous = view.checkin.anonymous;
    for (const set of Object.values(view.sets)) for (const question of set.questions) if (!questions.has(question.id)) questions.set(question.id, question);
    const textOf = (answer: (typeof view.answers)[number]) => {
      const set = view.sets[String(answer.setVersion)];
      return Object.fromEntries((set?.questions ?? []).map((question) => [question.id, answerText(question, answer.answers[question.id])]));
    };
    if (anonymous) {
      for (const answer of view.answers) lines.push({ date: view.round.date, person: "Anonymous", status: "Answered", submitted: answer.submittedAt?.slice(0, 10) ?? "", answers: textOf(answer) });
    } else {
      const byPerson = new Map(view.answers.filter((answer) => answer.person).map((answer) => [answer.person!.id, answer]));
      for (const participant of view.participants) {
        const answer = byPerson.get(participant.person.id);
        lines.push({ date: view.round.date, person: participant.person.name, status: STATUS[participant.status] ?? participant.status, submitted: answer?.submittedAt ?? "", answers: answer ? textOf(answer) : {} });
      }
    }
    if (lines.length >= CSV_EXPORT_ROWS) break;
  }
  const columns = [...questions.values()];
  const rows = lines.slice(0, CSV_EXPORT_ROWS).map((line) => [line.date, line.person, line.status, line.submitted, ...columns.map((question) => line.answers[question.id] ?? "")]);
  audit(userId, null, "checkins.export", { checkinId: checkin?.id ?? null, rounds: rounds.length, rows: rows.length });
  return { name: checkin?.name ?? "standup", text: csvText(["Date", "Person", "Status", "Submitted", ...columns.map((question) => question.title)], rows, lines.length > CSV_EXPORT_ROWS) };
}
