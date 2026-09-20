import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Sql {
  query<T = Record<string, any>>(sql: string, params?: any[]): Promise<{ rows: T[] }>;
  close(): Promise<void>;
}
export async function openDb(url?: string): Promise<Sql> {
  if (url?.startsWith('postgres')) {
    const pool = new pg.Pool({ connectionString: url });
    return { query: async <T>(s:string, p?:any[]) => ({ rows: (await pool.query(s,p)).rows as T[] }), close: () => pool.end() };
  }
  if (url?.startsWith('file://')) mkdirSync(dirname(url.slice(7)), { recursive: true });
  const db = new PGlite(url);
  await db.waitReady;
  return { query: (s, p) => db.query(s, p), close: () => db.close() };
}
export async function migrate(db: Sql) {
  // Each statement is safe to rerun; deployment runs migrations before replicas start.
  for (const sql of [
    `CREATE TABLE IF NOT EXISTS members (id text PRIMARY KEY, org text NOT NULL, team text NOT NULL, role text NOT NULL, tier text NOT NULL, active boolean NOT NULL DEFAULT true)`,
    `CREATE TABLE IF NOT EXISTS tasks (id text PRIMARY KEY, org text NOT NULL, team text NOT NULL, title text NOT NULL, status text NOT NULL CHECK(status IN ('todo','doing','done')), assignee text, version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS pages (id text PRIMARY KEY, org text NOT NULL, team text NOT NULL, title text NOT NULL, body text NOT NULL, task_ids jsonb NOT NULL DEFAULT '[]', version integer NOT NULL DEFAULT 1)`,
    `CREATE TABLE IF NOT EXISTS revisions (id text PRIMARY KEY, page_id text NOT NULL, version integer NOT NULL, body text NOT NULL, UNIQUE(page_id,version))`,
    `CREATE TABLE IF NOT EXISTS operations (key text PRIMARY KEY, actor text NOT NULL, fingerprint text NOT NULL, result jsonb, created_at timestamptz NOT NULL DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS approvals (id text PRIMARY KEY, actor text NOT NULL, fingerprint text NOT NULL, expires_at timestamptz NOT NULL, used boolean NOT NULL DEFAULT false)`,
    `CREATE TABLE IF NOT EXISTS usage (org text PRIMARY KEY, spent integer NOT NULL DEFAULT 0, reserved integer NOT NULL DEFAULT 0, allowance integer NOT NULL DEFAULT 1000)`,
    `CREATE TABLE IF NOT EXISTS reservations (id text PRIMARY KEY, org text NOT NULL, amount integer NOT NULL, actual integer, state text NOT NULL DEFAULT 'reserved')`,
    `CREATE TABLE IF NOT EXISTS jobs (id text PRIMARY KEY, actor text NOT NULL, org text NOT NULL, status text NOT NULL, input jsonb NOT NULL, result jsonb, lease_until timestamptz, attempts integer NOT NULL DEFAULT 0, expires_at timestamptz NOT NULL DEFAULT now()+interval '1 day')`,
    `CREATE TABLE IF NOT EXISTS audit (id text PRIMARY KEY, actor text NOT NULL, org text NOT NULL, operation text NOT NULL, outcome text NOT NULL, trace_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`,
  ]) await db.query(sql);
}
export async function seed(db: Sql) {
  for (const m of [
    ['alice','acme','platform','admin','pro'],
    ['bob','acme','platform','member','pro'],
    ['viewer','acme','platform','viewer','pro'],
    ['sam','acme','sales','member','pro'],
    ['eve','rival','platform','admin','free'],
  ]) await db.query('INSERT INTO members(id,org,team,role,tier) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',m);
  for (const t of [
    ['task-1','acme','platform','Ship the search endpoint','done','alice'],
    ['task-2','acme','platform','Document retry behavior','doing','bob'],
    ['task-3','acme','sales','Prepare the customer briefing','todo','sam'],
    ['task-secret','rival','platform','Confidential launch','done','eve'],
  ]) await db.query('INSERT INTO tasks(id,org,team,title,status,assignee) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',t);
  await db.query(`INSERT INTO pages(id,org,team,title,body,task_ids) VALUES('page-1','acme','platform','Release checklist','Review completed tasks. Verify ownership. Publish after a human approves the exact draft.','["task-1"]') ON CONFLICT DO NOTHING`);
  await db.query(`INSERT INTO usage(org,allowance) VALUES('acme',1000),('rival',100) ON CONFLICT DO NOTHING`);
}
export const id = () => randomUUID();
