import type { Pool, PoolClient } from 'pg';
import type { LoginIdentity, ProviderId } from './login-provider.js';
import { REFRESH_RETRY_SECONDS } from './session-tokens.js';

export type Player = { id: string };
export type LoginResult = { status: 'pending' | 'processing' | 'success' | 'failed' | 'claimed'; player_id: string | null; error_code: string | null; accessExpires?: Date; idleExpires?: Date };
export type MobileGrant = { familyId: string; refreshHash: string; idleExpires: Date };
export type RotationGrant = { refreshHash: string; accessHash: string; accessExpires: Date; idleExpires: Date };
export type RefreshResult = { status: 'success'; player: Player; provider: ProviderId; accessExpires: Date; idleExpires: Date }
  | { status: 'expired' | 'revoked' };
export interface LoginStore {
  start(id: string, stateHash: string, proofHash: string, expires: Date, provider?: ProviderId): Promise<void>;
  beginCallback(stateHash: string, provider?: ProviderId): Promise<string | undefined>;
  complete(id: string, identity: LoginIdentity, provider?: ProviderId): Promise<boolean>;
  fail(id: string, code: string): Promise<void>;
  claim(id: string, proofHash: string, tokenHash: string, expires: Date, provider: ProviderId, session: MobileGrant): Promise<LoginResult | undefined>;
  native(identity: LoginIdentity, tokenHash: string, expires: Date, provider?: ProviderId, mobile?: MobileGrant): Promise<Player>;
  refresh(tokenHash: string, requestId: string, grant: RotationGrant): Promise<RefreshResult>;
  revokeRefresh(tokenHash: string): Promise<void>;
  me(tokenHash: string): Promise<Player | undefined>;
  revoke(tokenHash: string): Promise<void>;
}

async function member(db: PoolClient, identity: LoginIdentity, provider: ProviderId): Promise<string> {
  // Serialize first-time sign-ins for the same provider subject, including concurrent devices.
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [provider + ':' + identity.subject]);
  // Email lookup is constrained by the authenticated provider and subject.
  let playerId: string | undefined;
  if (identity.email) {
    playerId = (await db.query<{ id: string }>(`SELECT p.id FROM players p JOIN social_identities i ON i.player_id=p.id
      WHERE lower(p.email)=$1 AND i.provider=$2 AND i.provider_subject=$3`, [identity.email, provider, identity.subject])).rows[0]?.id;
  }
  if (!playerId) {
    playerId = (await db.query<{ player_id: string }>('SELECT player_id FROM social_identities WHERE provider=$1 AND provider_subject=$2', [provider, identity.subject])).rows[0]?.player_id;
  }
  if (!playerId) {
    playerId = (await db.query<{ id: string }>('INSERT INTO players(email) VALUES($1) RETURNING id', [identity.email])).rows[0]!.id;
    await db.query('INSERT INTO social_identities(provider,provider_subject,player_id,email,last_login_at) VALUES($1,$2,$3,$4,now())', [provider, identity.subject, playerId, identity.email]);
  } else {
    await db.query('UPDATE social_identities SET email=$3,last_login_at=now() WHERE provider=$1 AND provider_subject=$2', [provider, identity.subject, identity.email]);
    await db.query('UPDATE players SET email=COALESCE($2,email) WHERE id=$1', [playerId, identity.email]);
  }
  return playerId;
}

export function postgresLoginStore(pool: Pool): LoginStore {
  async function transaction<T>(action: (db: PoolClient) => Promise<T>): Promise<T> {
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      const result = await action(db);
      await db.query('COMMIT');
      return result;
    } catch (error) { await db.query('ROLLBACK'); throw error; }
    finally { db.release(); }
  }
  return {
    async start(id, stateHash, proofHash, expires, provider = 'kakao') {
      await pool.query('DELETE FROM login_attempts WHERE expires_at <= now()');
      await pool.query('DELETE FROM auth_sessions WHERE expires_at <= now()');
      await pool.query('DELETE FROM mobile_session_families WHERE idle_expires_at <= now()');
      await pool.query("INSERT INTO login_attempts(id,state_hash,proof_hash,status,expires_at,provider) VALUES($1,$2,$3,'pending',$4,$5)", [id, stateHash, proofHash, expires, provider]);
    },
    async beginCallback(stateHash, provider = 'kakao') {
      return (await pool.query<{ id: string }>("UPDATE login_attempts SET status='processing' WHERE state_hash=$1 AND provider=$2 AND status='pending' AND expires_at>now() RETURNING id", [stateHash, provider])).rows[0]?.id;
    },
    async complete(id, identity, provider = 'kakao') {
      return transaction(async db => {
        const flow = await db.query("SELECT 1 FROM login_attempts WHERE id=$1 AND provider=$2 AND status='processing' AND expires_at>now() FOR UPDATE", [id, provider]);
        if (!flow.rowCount) return false;
        const player = await member(db, identity, provider);
        await db.query("UPDATE login_attempts SET status='success',player_id=$2 WHERE id=$1", [id, player]);
        return true;
      });
    },
    async fail(id, code) { await pool.query("UPDATE login_attempts SET status='failed',error_code=$2 WHERE id=$1 AND status='processing'", [id, code]); },
    async claim(id, proofHash, tokenHash, expires, provider, session) {
      return transaction(async db => {
        const result = (await db.query<LoginResult>('SELECT status,player_id,error_code FROM login_attempts WHERE id=$1 AND proof_hash=$2 AND provider=$3 AND expires_at>now() FOR UPDATE', [id, proofHash, provider])).rows[0];
        if (!result) return;
        if (result.status === 'claimed') {
          // A lost HTTP result response can be retried with the same proof for 120 seconds.
          const existing = (await db.query<{ access_expires: Date; idle_expires: Date }>(`SELECT s.expires_at AS access_expires,f.idle_expires_at AS idle_expires
            FROM auth_sessions s JOIN mobile_session_families f ON f.id=s.mobile_family_id
            WHERE s.token_hash=$1 AND s.player_id=$2 AND s.expires_at>now() AND f.provider=$3
              AND f.current_token_hash=$4 AND f.revoked_at IS NULL AND f.idle_expires_at>now()
              AND s.created_at>now()-($5 * interval '1 second') FOR UPDATE OF f`,
            [tokenHash,result.player_id,provider,session.refreshHash,REFRESH_RETRY_SECONDS])).rows[0];
          if (existing) return { ...result, status: 'success', accessExpires: existing.access_expires, idleExpires: existing.idle_expires };
          return result;
        }
        if (result.status === 'success' && result.player_id) {
          await db.query('INSERT INTO mobile_session_families(id,player_id,provider,current_token_hash,idle_expires_at) VALUES($1,$2,$3,$4,$5)', [session.familyId,result.player_id,provider,session.refreshHash,session.idleExpires]);
          await db.query('INSERT INTO mobile_refresh_tokens(token_hash,family_id) VALUES($1,$2)', [session.refreshHash,session.familyId]);
          await db.query('INSERT INTO auth_sessions(token_hash,player_id,expires_at,mobile_family_id) VALUES($1,$2,$3,$4)', [tokenHash,result.player_id,expires,session.familyId]);
          await db.query("UPDATE login_attempts SET status='claimed' WHERE id=$1", [id]);
          return { ...result, accessExpires: expires, idleExpires: session.idleExpires };
        }
        return result;
      });
    },
    async native(identity, tokenHash, expires, provider = 'kakao', mobile) {
      return transaction(async db => {
        const id = await member(db, identity, provider);
        await db.query('DELETE FROM auth_sessions WHERE expires_at<=now()');
        if (mobile) {
          await db.query('INSERT INTO mobile_session_families(id,player_id,provider,current_token_hash,idle_expires_at) VALUES($1,$2,$3,$4,$5)', [mobile.familyId,id,provider,mobile.refreshHash,mobile.idleExpires]);
          await db.query('INSERT INTO mobile_refresh_tokens(token_hash,family_id) VALUES($1,$2)', [mobile.refreshHash,mobile.familyId]);
        }
        await db.query('INSERT INTO auth_sessions(token_hash,player_id,expires_at,mobile_family_id) VALUES($1,$2,$3,$4)', [tokenHash,id,expires,mobile?.familyId ?? null]);
        return { id };
      });
    },
    async refresh(tokenHash, requestId, grant) {
      return transaction(async db => {
        const family = (await db.query<{ id: string; player_id: string; provider: ProviderId; current_token_hash: string; idle_expires_at: Date; revoked_at: Date | null }>(
          `SELECT f.* FROM mobile_session_families f JOIN mobile_refresh_tokens r ON r.family_id=f.id
           WHERE r.token_hash=$1 FOR UPDATE OF f`, [tokenHash])).rows[0];
        if (!family || family.idle_expires_at.getTime() <= Date.now()) return { status: 'expired' };
        if (family.revoked_at) return { status: 'revoked' };
        const previous = (await db.query<{ request_id: string | null; rotated_at: Date | null; next_token_hash: string | null; access_token_hash: string | null; access_expires_at: Date | null; refresh_expires_at: Date | null; retry_until: Date | null }>(
          'SELECT * FROM mobile_refresh_tokens WHERE token_hash=$1', [tokenHash])).rows[0]!;
        if (previous.rotated_at) {
          if (previous.request_id === requestId && previous.next_token_hash === family.current_token_hash
            && previous.next_token_hash === grant.refreshHash && previous.access_token_hash === grant.accessHash
            && previous.retry_until && previous.retry_until.getTime() > Date.now()
            && previous.access_expires_at && previous.refresh_expires_at) {
            return { status: 'success', player: { id: family.player_id }, provider: family.provider,
              accessExpires: previous.access_expires_at, idleExpires: previous.refresh_expires_at };
          }
          // Reusing a consumed refresh token outside its exact bounded retry revokes this device session.
          await db.query('UPDATE mobile_session_families SET revoked_at=now() WHERE id=$1', [family.id]);
          await db.query('DELETE FROM auth_sessions WHERE mobile_family_id=$1', [family.id]);
          return { status: 'revoked' };
        }
        if (family.current_token_hash !== tokenHash) {
          await db.query('UPDATE mobile_session_families SET revoked_at=now() WHERE id=$1', [family.id]);
          await db.query('DELETE FROM auth_sessions WHERE mobile_family_id=$1', [family.id]);
          return { status: 'revoked' };
        }
        await db.query(`UPDATE mobile_refresh_tokens SET request_id=$2,rotated_at=now(),next_token_hash=$3,
          access_token_hash=$4,access_expires_at=$5,refresh_expires_at=$6,retry_until=now()+($7 * interval '1 second') WHERE token_hash=$1`,
          [tokenHash,requestId,grant.refreshHash,grant.accessHash,grant.accessExpires,grant.idleExpires,REFRESH_RETRY_SECONDS]);
        await db.query('INSERT INTO mobile_refresh_tokens(token_hash,family_id) VALUES($1,$2)', [grant.refreshHash,family.id]);
        await db.query('UPDATE mobile_session_families SET current_token_hash=$2,idle_expires_at=$3,last_seen_at=now() WHERE id=$1', [family.id,grant.refreshHash,grant.idleExpires]);
        await db.query('DELETE FROM auth_sessions WHERE expires_at<=now()');
        await db.query('INSERT INTO auth_sessions(token_hash,player_id,expires_at,mobile_family_id) VALUES($1,$2,$3,$4)', [grant.accessHash,family.player_id,grant.accessExpires,family.id]);
        return { status: 'success', player: { id: family.player_id }, provider: family.provider, accessExpires: grant.accessExpires, idleExpires: grant.idleExpires };
      });
    },
    async revokeRefresh(tokenHash) {
      await transaction(async db => {
        const familyId = (await db.query<{ family_id: string }>('SELECT family_id FROM mobile_refresh_tokens WHERE token_hash=$1', [tokenHash])).rows[0]?.family_id;
        if (!familyId) return;
        await db.query('UPDATE mobile_session_families SET revoked_at=now() WHERE id=$1', [familyId]);
        await db.query('DELETE FROM auth_sessions WHERE mobile_family_id=$1', [familyId]);
      });
    },
    async me(tokenHash) {
      return (await pool.query<Player>(`SELECT s.player_id AS id FROM auth_sessions s LEFT JOIN mobile_session_families f ON f.id=s.mobile_family_id
        WHERE s.token_hash=$1 AND s.expires_at>now() AND (s.mobile_family_id IS NULL OR (f.revoked_at IS NULL AND f.idle_expires_at>now()))`, [tokenHash])).rows[0];
    },
    async revoke(tokenHash) {
      await transaction(async db => {
        const familyId = (await db.query<{ mobile_family_id: string | null }>('SELECT mobile_family_id FROM auth_sessions WHERE token_hash=$1', [tokenHash])).rows[0]?.mobile_family_id;
        if (familyId) {
          await db.query('UPDATE mobile_session_families SET revoked_at=now() WHERE id=$1', [familyId]);
          await db.query('DELETE FROM auth_sessions WHERE mobile_family_id=$1', [familyId]);
        } else await db.query('DELETE FROM auth_sessions WHERE token_hash=$1', [tokenHash]);
      });
    },
  };
}
