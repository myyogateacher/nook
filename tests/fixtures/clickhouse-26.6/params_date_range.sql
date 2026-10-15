SELECT d, count() AS n FROM myt.events WHERE d >= {period_from:Date} AND d <= {period_to:Date} GROUP BY d ORDER BY d
