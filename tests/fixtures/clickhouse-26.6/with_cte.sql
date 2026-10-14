WITH b AS (SELECT route, uuid FROM myt.myt_chat_escalation FINAL) SELECT route, count() FROM b GROUP BY route
