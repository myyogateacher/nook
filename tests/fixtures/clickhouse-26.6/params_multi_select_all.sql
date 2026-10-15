SELECT route, count() AS n FROM myt.myt_chat_escalation WHERE empty({routes:Array(String)}) OR route IN {routes:Array(String)} GROUP BY route
