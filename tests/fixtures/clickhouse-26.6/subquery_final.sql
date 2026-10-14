SELECT route, count() FROM (SELECT route, argMax(outcome, _peerdb_version) AS o FROM myt.myt_chat_escalation FINAL GROUP BY route, batch_uuid) GROUP BY route
