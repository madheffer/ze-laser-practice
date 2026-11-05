-- Steam sign-in (server/auth/), run history and replays.

-- Everyone who has signed in through Steam. The SteamID64 is the identity; the name is their persona at last sign-in.
CREATE TABLE players (
  steam_id    text         PRIMARY KEY CHECK (steam_id ~ '^[0-9]{17}$'),
  name        text         NOT NULL,
  avatar      text         NOT NULL DEFAULT '',
  created_at  timestamptz  NOT NULL DEFAULT now(),
  seen_at     timestamptz  NOT NULL DEFAULT now()
);

-- A run's player, when they were signed in (solo runs and public rooms only, as before: a private room's players
-- are never written). Leaderboards count a signed-in player once by this, whatever name they played under.
ALTER TABLE run_players ADD COLUMN steam_id text REFERENCES players (steam_id);
CREATE INDEX run_players_steam ON run_players (steam_id, run_id DESC) WHERE steam_id IS NOT NULL;

-- false: kept for its player's history, not shown on the home page's feed ("Share my runs" off)
ALTER TABLE runs ADD COLUMN listed boolean NOT NULL DEFAULT true;
DROP INDEX runs_recent;
CREATE INDEX runs_recent ON runs (finished_at DESC, id DESC) WHERE listed;

-- A solo run's replay (web/src/lib/replay-codec.js, gzipped): the player's position and view on every tick plus
-- their shots / E / fall damage. The stage is rebuilt from meta (seed, rules, stage), so nothing else is stored.
--   public: anyone with the run's id may watch it (shared to the feed, or from the player's history)
--   pinned: kept past the per-player cap (shared from the history)
--   views:  how many times others watched it (one per viewer per replay per 30 minutes)
-- Kept (server/db/store.js): a player's newest 200 + pinned; a guest's (owner NULL, only ever shared) 14 days.
CREATE TABLE replays (
  run_id      bigint       PRIMARY KEY REFERENCES runs (id) ON DELETE CASCADE,
  owner       text         REFERENCES players (steam_id) ON DELETE CASCADE,
  created_at  timestamptz  NOT NULL DEFAULT now(),
  public      boolean      NOT NULL,
  pinned      boolean      NOT NULL DEFAULT false,
  views       integer      NOT NULL DEFAULT 0 CHECK (views >= 0), -- watched by someone other than its owner (server/runs-http.js)
  meta        jsonb        NOT NULL,
  data        bytea        NOT NULL CHECK (octet_length(data) <= 1048576)
);
CREATE INDEX replays_owner ON replays (owner, run_id DESC) WHERE owner IS NOT NULL;
CREATE INDEX replays_guest ON replays (created_at) WHERE owner IS NULL;

-- ranked_runs, now with who the player is (new columns go last: CREATE OR REPLACE keeps the old ones in place)
CREATE OR REPLACE VIEW ranked_runs AS
SELECT r.id AS run_id, r.finished_at, r.kind, r.verified, r.map, r.stage_id, r.stage_name, r.mode,
       p.name, p.hits,
       CASE WHEN r.mode = 'endless' THEN p.survived_s ELSE r.time_s END AS time_s,
       p.steam_id
FROM runs r
JOIN run_players p ON p.run_id = r.id
WHERE NOT r.cheats AND p.removed = ''
  AND (r.mode = 'endless' OR (r.result = 'win' AND p.won));
