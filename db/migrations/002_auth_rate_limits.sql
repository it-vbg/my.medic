CREATE TABLE medic.auth_rate_limits (
  key_hash bytea PRIMARY KEY CHECK (octet_length(key_hash) = 32),
  attempts integer NOT NULL CHECK (attempts > 0),
  expires_at timestamptz NOT NULL
);
CREATE INDEX auth_rate_limits_expiry ON medic.auth_rate_limits (expires_at);
