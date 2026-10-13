-- Social identity foundation only. Provider authentication is not connected yet.
CREATE TABLE players (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE social_identities (
    provider TEXT NOT NULL CHECK (provider IN ('kakao', 'naver', 'apple')),
    provider_subject TEXT NOT NULL,
    player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (provider, provider_subject)
);
-- No password column; do not join identities by email automatically.
