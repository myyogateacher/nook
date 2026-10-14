SELECT route, argMax(outcome, _peerdb_version), countIf(status = 'open') FROM myt.myt_chat_escalation GROUP BY route
