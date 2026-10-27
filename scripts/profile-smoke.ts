import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import Fastify from 'fastify';
import pg from 'pg';
import { readConfig } from '../src/config.js';
import { postgresLoginStore } from '../src/login-store.js';
import { hashSecret, registerAuthRoutes } from '../src/login-routes.js';

// Disposable isolated schema only; no actual account/profile/token is touched.
const schema = 'profile_test_' + randomBytes(8).toString('hex');
const admin = new pg.Pool({ connectionString: readConfig().databaseUrl });
const pool = new pg.Pool({ connectionString: readConfig().databaseUrl, options: `-c search_path=${schema}`, max: 8 });
const app = Fastify();
registerAuthRoutes(app, postgresLoginStore(pool), 'a'.repeat(64));
try {
  await admin.query(`CREATE SCHEMA ${schema}`);
  for (const name of (await readdir(new URL('../migrations/', import.meta.url))).filter(n => n.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL('../migrations/' + name, import.meta.url), 'utf8'));
  }
  async function account() {
    const id: string = (await pool.query('INSERT INTO players DEFAULT VALUES RETURNING id')).rows[0].id;
    const token = randomBytes(32).toString('base64url');
    await pool.query("INSERT INTO auth_sessions(token_hash,player_id,expires_at) VALUES($1,$2,now()+interval '15 minutes')", [hashSecret(token), id]);
    return { id, token, headers: { authorization: 'Bearer ' + token } };
  }
  const a = await account(), b = await account(), c = await account();
  const setup = (user: typeof a, owner: string, name: string) => app.inject({ method: 'POST', url: '/v1/auth/cafe/setup', headers: user.headers, payload: { owner_character_id: owner, cafe_name: name } });
  assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/cafe/setup', payload: { owner_character_id: 'cat-black', cafe_name: '도트한잔' } })).statusCode, 401);
  assert.equal((await setup(a, 'rabbit-gray', '도트한잔')).statusCode, 400);
  assert.equal((await setup(a, 'cat-black', '공백 이름')).statusCode, 400);
  assert.equal((await pool.query('SELECT owner_character_id FROM players WHERE id=$1', [a.id])).rows[0].owner_character_id, null);
  const created = await setup(a, 'cat-black', '도트한잔'.normalize('NFD'));
  assert.equal(created.statusCode, 200);
  assert.deepEqual(created.json().player, { id: a.id, owner_character_id: 'cat-black', cafe_name: '도트한잔' });
  const repeated = await Promise.all([setup(a, 'cat-black', '도트한잔'), setup(a, 'cat-black', '도트한잔')]);
  assert.ok(repeated.every(r => r.statusCode === 200));
  assert.equal((await setup(a, 'fox-white', '다른이름')).json().error, 'profile_already_set');
  assert.equal((await setup(b, 'human-male', '도트한잔')).json().error, 'cafe_name_taken');
  const racing = await Promise.all([setup(b, 'human-male', 'SameTea'), setup(c, 'human-female', 'sametea')]);
  assert.deepEqual(racing.map(r => r.statusCode).sort(), [200, 409]);
  const winner = racing[0]!.statusCode === 200 ? b : c;
  const loser = winner === b ? c : b;
  assert.equal((await pool.query('SELECT owner_character_id FROM players WHERE id=$1', [loser.id])).rows[0].owner_character_id, null, 'Conflict rolls the entire setup back');
  const sameAccountRace = await Promise.all([setup(loser, 'fox-white', '설원찻집'), setup(loser, 'rabbit-white', '토끼찻집')]);
  assert.deepEqual(sameAccountRace.map(r => r.statusCode).sort(), [200, 409]);
  // Database, not just endpoint, rejects edits and clears after finalization.
  for (const sql of ["UPDATE players SET cafe_name='수정' WHERE id=$1", "UPDATE players SET owner_character_id='fox-orange' WHERE id=$1", 'UPDATE players SET cafe_name=NULL,owner_character_id=NULL WHERE id=$1']) {
    await assert.rejects(pool.query(sql, [a.id]), (e: { code?: string }) => e.code === '23514');
  }
  await pool.query("UPDATE players SET email='fixture@example.test' WHERE id=$1", [a.id]);
  const reread = await postgresLoginStore(pool).me(hashSecret(a.token));
  assert.equal(reread?.owner_character_id, 'cat-black');
  assert.equal(reread?.cafe_name, '도트한잔');
  assert.deepEqual((await app.inject({ url: '/v1/auth/me', headers: a.headers })).json().player, created.json().player);
  await pool.query("UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1", [hashSecret(a.token)]);
  assert.equal((await setup(a, 'cat-black', '도트한잔')).statusCode, 401);
  console.log('Profile integration passed: authentication, allowed owners/names, NFC, atomic save, retries, concurrent name and account conflicts, immutable DB fields, persistence, me response and expired sessions.');
} finally {
  await app.close();
  await pool.end();
  assert.match(schema, /^profile_test_[a-f0-9]{16}$/);
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
}
