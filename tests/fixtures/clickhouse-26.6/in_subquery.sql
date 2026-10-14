SELECT count() FROM myt.events WHERE id IN (SELECT id FROM myt.events WHERE v > 1)
