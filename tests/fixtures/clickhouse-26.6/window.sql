SELECT id, sum(v) OVER (PARTITION BY d ORDER BY id) AS running FROM myt.events
