-- Creates the table the login/signup flow expects, matching the columns the
-- readline CLI already uses (Username, Password, Useremail).
--
-- Run it once against the database named in connection_info.env:
--   psql -h <DB_HOST> -U <DB_USER> -d <DB_NAME> -f database/schema.sql
--
-- Safe to re-run: it only creates the table if it's missing.

CREATE TABLE IF NOT EXISTS login_info (
    Username  TEXT NOT NULL,
    Password  TEXT NOT NULL,
    Useremail TEXT NOT NULL
);

-- Signup rejects duplicate emails, so make that lookup fast and enforceable.
CREATE UNIQUE INDEX IF NOT EXISTS login_info_useremail_key
    ON login_info (Useremail);
