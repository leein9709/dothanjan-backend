ALTER TABLE players ADD COLUMN owner_character_id TEXT;
ALTER TABLE players ADD CONSTRAINT players_owner_allowed CHECK (
    owner_character_id IS NULL OR owner_character_id IN (
        'human-male', 'human-female', 'cat-ginger', 'cat-black', 'cat-white-gray',
        'fox-orange', 'fox-white', 'rabbit-white', 'rabbit-light-brown'
    )
);
ALTER TABLE players ADD CONSTRAINT players_owner_has_name
    CHECK (owner_character_id IS NULL OR cafe_name IS NOT NULL);

CREATE FUNCTION protect_cafe_profile() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.owner_character_id IS NOT NULL AND (
        NEW.owner_character_id IS DISTINCT FROM OLD.owner_character_id OR
        NEW.cafe_name IS DISTINCT FROM OLD.cafe_name
    ) THEN
        RAISE EXCEPTION 'cafe profile is already finalized' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER players_profile_immutable BEFORE UPDATE ON players
    FOR EACH ROW EXECUTE FUNCTION protect_cafe_profile();
