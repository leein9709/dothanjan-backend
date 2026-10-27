-- No profile is saved here: existing/new players may keep a NULL cafe name.
-- Mirror ECMAScript trim whitespace, normalize Korean syllables and ignore ASCII case.
CREATE FUNCTION cafe_name_identity(value TEXT) RETURNS TEXT
LANGUAGE SQL IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT lower(normalize(btrim(value,
        U&' \0009\000A\000B\000C\000D\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'), NFC) COLLATE "C")
$$;

ALTER TABLE players ADD COLUMN cafe_name TEXT;
ALTER TABLE players ADD COLUMN cafe_name_key TEXT COLLATE "C"
    GENERATED ALWAYS AS (cafe_name_identity(cafe_name)) STORED;
ALTER TABLE players ADD CONSTRAINT players_cafe_name_valid
    CHECK (cafe_name IS NULL OR (
        char_length(cafe_name_key) BETWEEN 1 AND 64
        AND cafe_name !~ U&'[\0001-\001F\007F-\009F]'
    ));
ALTER TABLE players ADD CONSTRAINT players_cafe_name_key_unique UNIQUE (cafe_name_key);
