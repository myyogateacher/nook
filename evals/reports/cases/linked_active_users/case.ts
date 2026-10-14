import type { EvalCase } from "../../types";

const QUALIFYING = "FROM eval_linked_active_users.sessions AS s\nINNER JOIN eval_linked_active_users.users AS u ON u.user_id = s.user_id\nWHERE u.is_internal = 0 AND NOT endsWith(u.email, '@nook.test') AND s.duration_s >= 60\n  AND s.started_at >= '2026-09-24 00:00:00' AND s.started_at < '2026-10-01 00:00:00'";

export default {
  id: "linked_active_users",
  title: "A metric defined on a linked page",
  traps: ["WAU is defined only on the linked page (3+ sessions of 60 s, internal and @nook.test accounts excluded)"],
  browseTools: ["read_note", "search_notes"],
  facts: [
    { id: "wau", label: "Weekly active users", kind: "number", value: 204, tolerance: 0 },
    { id: "sessions", label: "Qualifying sessions", kind: "number", value: 1621, tolerance: 0 }
  ],
  golden: {
    title: "Weekly engagement",
    queries: [
      { key: "wau", sql: `SELECT count() AS wau\nFROM (\n  SELECT s.user_id\n  ${QUALIFYING.replace(/\n/g, "\n  ")}\n  GROUP BY s.user_id\n  HAVING count() >= 3\n)`, purpose: "Weekly active users" },
      { key: "sessions", sql: `SELECT count() AS qualifying_sessions\n${QUALIFYING}`, purpose: "Qualifying sessions" }
    ],
    blocks: [
      { id: "wau", type: "kpi", title: "Weekly active users", intent: "headline", queryKey: "wau", column: "wau", format: "number", unit: "users" },
      { id: "sessions", type: "kpi", title: "Qualifying sessions", intent: "headline", queryKey: "sessions", column: "qualifying_sessions", format: "number", unit: "sessions" }
    ]
  },
  trap: {
    fails: ["wau", "sessions"],
    spec: {
      title: "Weekly engagement",
      queries: [
        { key: "wau", sql: "SELECT uniqExact(user_id) AS wau\nFROM eval_linked_active_users.sessions\nWHERE started_at >= '2026-09-24 00:00:00' AND started_at < '2026-10-01 00:00:00'", purpose: "Weekly active users" },
        { key: "sessions", sql: "SELECT count() AS qualifying_sessions\nFROM eval_linked_active_users.sessions\nWHERE started_at >= '2026-09-24 00:00:00' AND started_at < '2026-10-01 00:00:00'", purpose: "Sessions" }
      ],
      blocks: [
        { id: "wau", type: "kpi", title: "Weekly active users", intent: "headline", queryKey: "wau", column: "wau", format: "number", unit: "users" },
        { id: "sessions", type: "kpi", title: "Qualifying sessions", intent: "headline", queryKey: "sessions", column: "qualifying_sessions", format: "number", unit: "sessions" }
      ]
    }
  }
} satisfies EvalCase;
