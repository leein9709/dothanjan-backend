-- Tighten the current policy without altering previously applied migrations or names.
-- Spaces, punctuation, emoji, and non-Hangul/non-ASCII scripts are not allowed.
ALTER TABLE players ADD CONSTRAINT players_cafe_name_characters
    CHECK (cafe_name IS NULL OR cafe_name COLLATE "C" ~
        U&'^[A-Za-z0-9\1100-\11FF\3130-\318F\A960-\A97F\AC00-\D7A3\D7B0-\D7FF]+$');
