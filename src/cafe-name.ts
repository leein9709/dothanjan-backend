export const MAX_CAFE_NAME_LENGTH = 64;
export type CafeNameValidation = { ok: true; name: string }
  | { ok: false; reason: 'empty' | 'too_long' | 'invalid_characters' };

export function validateCafeName(value: unknown): CafeNameValidation {
  if (typeof value !== 'string') return { ok: false, reason: 'empty' };
  const name = value.normalize('NFC');
  if (!name) return { ok: false, reason: 'empty' };
  if ([...name].length > MAX_CAFE_NAME_LENGTH) return { ok: false, reason: 'too_long' };
  if (/[^A-Za-z0-9\u1100-\u11ff\u3130-\u318f\ua960-\ua97f\uac00-\ud7a3\ud7b0-\ud7ff]/u.test(name)) return { ok: false, reason: 'invalid_characters' };
  return { ok: true, name };
}
