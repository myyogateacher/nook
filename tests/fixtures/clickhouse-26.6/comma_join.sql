SELECT count() FROM myt.events AS e, myt.myt_chat_escalation AS c WHERE toString(e.id) = c.uuid
