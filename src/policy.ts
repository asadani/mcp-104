import { createHash } from 'node:crypto';
import type { Sql } from './db.js';
import { id } from './db.js';
export class Fault extends Error {
  constructor(public code: string, message: string, public status = 400, public retryable = false) { super(message); }
}
export type Actor = { id: string; org: string; team: string; role: 'admin'|'member'|'viewer'; tier: 'free'|'pro'; active: boolean };
export async function actor(db: Sql, subject: string): Promise<Actor> {
  const a = (await db.query<Actor>('SELECT * FROM members WHERE id=$1 AND active=true',[subject])).rows[0];
  if (!a) throw new Fault('UNAUTHORIZED','Your session is no longer authorized.',401);
  return a;
}
export function writeAllowed(a: Actor) {
  if (a.role === 'viewer') throw new Fault('FORBIDDEN','Your role can read but cannot change this team’s work.',403);
}
export function entitlement(a: Actor, feature: string) {
  if (a.tier !== 'pro') throw new Fault('PLAN_REQUIRED',`${feature} requires the Pro plan. Data permissions still apply.`,403);
}
export function fingerprint(value: unknown): string {
  const canonical = (x: any): any => Array.isArray(x) ? x.map(canonical) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])) : x;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export async function audit(db: Sql, a: Actor, operation: string, outcome: string, traceId: string) {
  // Deliberately excludes arguments, page bodies, tokens and scraped content.
  await db.query('INSERT INTO audit(id,actor,org,operation,outcome,trace_id) VALUES($1,$2,$3,$4,$5,$6)',[id(),a.id,a.org,operation,outcome,traceId]);
}
export async function approve(db: Sql, a: Actor, operation: unknown) {
  writeAllowed(a);
  const approval = id();
  await db.query(`INSERT INTO approvals(id,actor,fingerprint,expires_at) VALUES($1,$2,$3,now()+interval '5 minutes')`,[approval,a.id,fingerprint(operation)]);
  return approval;
}
export async function useApproval(db: Sql, a: Actor, approval: string, operation: unknown) {
  const r = await db.query(`UPDATE approvals SET used=true WHERE id=$1 AND actor=$2 AND fingerprint=$3 AND used=false AND expires_at>now() RETURNING id`,[approval,a.id,fingerprint(operation)]);
  if (!r.rows.length) throw new Fault('APPROVAL_REQUIRED','Review and approve this exact operation again.',403);
}
export async function once<T>(db: Sql, a: Actor, key: string, input: unknown, work: ()=>Promise<T>): Promise<T> {
  const scoped = `${a.org}:${a.id}:${key}`, hash = fingerprint(input);
  const claim = await db.query('INSERT INTO operations(key,actor,fingerprint) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING key',[scoped,a.id,hash]);
  if (!claim.rows.length) {
    const prior = (await db.query('SELECT * FROM operations WHERE key=$1',[scoped])).rows[0];
    if (prior.fingerprint !== hash) throw new Fault('IDEMPOTENCY_CONFLICT','This operation key was already used with different arguments.',409);
    if (prior.result === null) throw new Fault('OUTCOME_UNKNOWN','Operation in progress or interrupted. Inspect its outcome before retrying.',409);
    return prior.result as T;
  }
  // Product writes use their own stable IDs. A crash between write and recording outcome
  // is surfaced as OUTCOME_UNKNOWN, never blindly replayed. See the recovery lab.
  const result = await work();
  await db.query('UPDATE operations SET result=$2 WHERE key=$1',[scoped,JSON.stringify(result)]);
  return result;
}
