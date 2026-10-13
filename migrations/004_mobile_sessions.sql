CREATE TABLE mobile_session_families (
    id UUID PRIMARY KEY,
    player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (provider IN ('kakao', 'naver')),
    current_token_hash TEXT NOT NULL,
    idle_expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX mobile_session_families_expiry_idx ON mobile_session_families(idle_expires_at);
CREATE INDEX mobile_session_families_player_idx ON mobile_session_families(player_id);

CREATE TABLE mobile_refresh_tokens (
    token_hash TEXT PRIMARY KEY,
    family_id UUID NOT NULL REFERENCES mobile_session_families(id) ON DELETE CASCADE,
    request_id UUID,
    rotated_at TIMESTAMPTZ,
    next_token_hash TEXT,
    access_token_hash TEXT,
    access_expires_at TIMESTAMPTZ,
    refresh_expires_at TIMESTAMPTZ,
    retry_until TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX mobile_refresh_tokens_family_idx ON mobile_refresh_tokens(family_id);

ALTER TABLE auth_sessions ADD COLUMN mobile_family_id UUID REFERENCES mobile_session_families(id) ON DELETE CASCADE;
CREATE INDEX auth_sessions_mobile_family_idx ON auth_sessions(mobile_family_id) WHERE mobile_family_id IS NOT NULL;
