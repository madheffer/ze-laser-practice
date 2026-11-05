-- Only Steam accounts are ranked. A guest's run (a public room's player who wasn't signed in) is still a row of its
-- round, but no longer on a leaderboard: a typed name is nobody's identity (and anyone can type it). Solo runs come
-- only from signed-in players now (server/runs-http.js).
-- Same columns, same order as 002 (CREATE OR REPLACE VIEW keeps them in place).
CREATE OR REPLACE VIEW ranked_runs AS
SELECT r.id AS run_id, r.finished_at, r.kind, r.verified, r.map, r.stage_id, r.stage_name, r.mode,
       p.name, p.hits,
       CASE WHEN r.mode = 'endless' THEN p.survived_s ELSE r.time_s END AS time_s,
       p.steam_id
FROM runs r
JOIN run_players p ON p.run_id = r.id
WHERE NOT r.cheats AND p.removed = '' AND p.steam_id IS NOT NULL
  AND (r.mode = 'endless' OR (r.result = 'win' AND p.won));
