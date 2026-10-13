ALTER TABLE players ADD COLUMN email TEXT;
CREATE INDEX players_email_idx ON players(lower(email)) WHERE email IS NOT NULL;
ALTER TABLE social_identities ADD COLUMN email TEXT;
ALTER TABLE social_identities ADD COLUMN last_login_at TIMESTAMPTZ;
CREATE INDEX social_identities_email_idx ON social_identities(provider, lower(email)) WHERE email IS NOT NULL;

CREATE TABLE login_attempts (
    id UUID PRIMARY KEY,
    state_hash TEXT NOT NULL UNIQUE,
    proof_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'success', 'failed', 'claimed')),
    error_code TEXT,
    player_id UUID REFERENCES players(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX login_attempts_expiry_idx ON login_attempts(expires_at);
CREATE TABLE auth_sessions (
    token_hash TEXT PRIMARY KEY,
    player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX auth_sessions_expiry_idx ON auth_sessions(expires_at);
