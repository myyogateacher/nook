WITH ['replied_in_chat', 'read_in_chat'] AS engaged SELECT route, countIf(anchor_outcome IN engaged) AS e FROM myt.myt_chat_escalation FINAL GROUP BY route
