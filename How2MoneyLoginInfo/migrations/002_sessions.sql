-- 002: login sessions.
--
-- A row per logged-in browser. session_id is a random token that lives in an
-- httpOnly cookie; the row is the server's record that the token is valid.

CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    userid     INTEGER NOT NULL REFERENCES login_info(userid) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_userid_idx     ON sessions (userid);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at);
