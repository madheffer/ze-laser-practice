-- Every finished run on this server: co-op / versus rounds (run and checked by the server) and solo runs
-- (reported by the player's page, unchecked). Leaderboards and the home page's feed are both read from here.

CREATE TABLE runs (
  id           bigserial    PRIMARY KEY,
  finished_at  timestamptz  NOT NULL DEFAULT now(),
  kind         text         NOT NULL CHECK (kind IN ('solo', 'coop', 'versus')),
  verified     boolean      NOT NULL,              -- true: the server ran the round; false: a page reported it
  map          text         NOT NULL,              -- the map folder name, e.g. ze_ffxii_westersand_v8
  stage_id     text         NOT NULL,              -- the scenario's id (web/public/scenarios/<map>.json)
  stage_name   text         NOT NULL,
  mode         text         NOT NULL CHECK (mode IN ('normal', 'endless')),
  result       text         NOT NULL CHECK (result IN ('win', 'lose', 'over', 'draw')),
  time_s       double precision NOT NULL CHECK (time_s >= 0), -- stage time when the run ended
  players      smallint     NOT NULL CHECK (players >= 1),
  named        boolean      NOT NULL,              -- false: a private room, nobody in it is named or stored
  room_name    text         NOT NULL DEFAULT '',   -- public rooms only
  cheats       boolean      NOT NULL DEFAULT false, -- the room's rules had a cheat on (god mode, ...)
  cause        text         NOT NULL DEFAULT ''    -- solo deaths: what killed you
);

-- Who played a run. Only for solo runs and public rooms: a private room's players are never written.
CREATE TABLE run_players (
  run_id      bigint    NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  slot        smallint  NOT NULL,
  name        text      NOT NULL,
  won         boolean   NOT NULL,
  hits        integer   CHECK (hits >= 0),
  survived_s  double precision NOT NULL CHECK (survived_s >= 0), -- how long this player stayed alive
  removed     text      NOT NULL DEFAULT '',             -- the anti-cheat removed them ('spawn', 'teleport', ...)
  PRIMARY KEY (run_id, slot)
);

CREATE INDEX runs_recent ON runs (finished_at DESC);
CREATE INDEX runs_board ON runs (map, stage_id, mode, kind) WHERE NOT cheats;
CREATE INDEX run_players_name ON run_players (lower(name));

-- One row per player per run that can be ranked: no cheat rules, not removed by the anti-cheat; normal runs only
-- when they cleared the stage. Rank normal by time then hits, endless by survived_s (longest first).
CREATE VIEW ranked_runs AS
SELECT r.id AS run_id, r.finished_at, r.kind, r.verified, r.map, r.stage_id, r.stage_name, r.mode,
       p.name, p.hits,
       CASE WHEN r.mode = 'endless' THEN p.survived_s ELSE r.time_s END AS time_s
FROM runs r
JOIN run_players p ON p.run_id = r.id
WHERE NOT r.cheats AND p.removed = ''
  AND (r.mode = 'endless' OR (r.result = 'win' AND p.won));
