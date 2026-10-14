SELECT e.id, c.route FROM myt.events AS e INNER JOIN myt.myt_chat_escalation AS c ON toString(e.id) = c.uuid
