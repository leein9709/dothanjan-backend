ALTER TABLE login_attempts ADD COLUMN provider TEXT NOT NULL DEFAULT 'kakao'
    CHECK (provider IN ('kakao', 'naver'));
