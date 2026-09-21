import { z } from 'zod';
import type { Sql } from './db.js';
import { id } from './db.js';
import { type Actor, Fault, writeAllowed, once, useApproval } from './policy.js';

export const searchSchema = z.object({ query:z.string().max(200).default(''), status:z.enum(['todo','doing','done']).optional(), offset:z.number().int().min(0).max(10000).default(0), limit:z.number().int().min(1).max(50).default(10) }).strict();
export const createTaskSchema = z.object({ title:z.string().trim().min(1).max(200), assignee:z.string().max(80).optional(), operationKey:z.string().min(8).max(100) }).strict();
export const updateTaskSchema = z.object({ id:z.string(), status:z.enum(['todo','doing','done']), version:z.number().int().positive(), operationKey:z.string().min(8).max(100) }).strict();
export const pageSchema = z.object({ title:z.string().trim().min(1).max(200), body:z.string().min(1).max(20000), taskIds:z.array(z.string()).max(50).default([]), operationKey:z.string().min(8).max(100), approvalId:z.string().optional() }).strict();

export class Product {
  constructor(public db: Sql) {}
  async searchTasks(a: Actor, raw: unknown) {
    const p = searchSchema.parse(raw);
    const values = [a.org,a.team,`%${p.query}%`,p.status ?? null];
    const where = 'org=$1 AND team=$2 AND title ILIKE $3 AND ($4::text IS NULL OR status=$4)';
    const total = Number((await this.db.query(`SELECT count(*) AS n FROM tasks WHERE ${where}`,values)).rows[0].n);
    const rows = (await this.db.query(`SELECT * FROM tasks WHERE ${where} ORDER BY id LIMIT $5 OFFSET $6`,[...values,p.limit,p.offset])).rows;
    return {items:rows,total,offset:p.offset,nextOffset:p.offset+rows.length<total?p.offset+rows.length:null};
  }
  async getTask(a: Actor, taskId: string) {
    const t = (await this.db.query('SELECT * FROM tasks WHERE id=$1 AND org=$2 AND team=$3',[taskId,a.org,a.team])).rows[0];
    if (!t) throw new Fault('NOT_FOUND','Task not found in your team.',404);
    return t;
  }
  async createTask(a: Actor, raw: unknown) {
    writeAllowed(a); const p = createTaskSchema.parse(raw);
    if(p.assignee && !(await this.db.query('SELECT id FROM members WHERE id=$1 AND org=$2 AND team=$3 AND active=true',[p.assignee,a.org,a.team])).rows.length) throw new Fault('INVALID_ASSIGNEE','Choose an active member of this team.');
    return once(this.db,a,p.operationKey,{op:'create_task',...p},async tx=>{
      const taskId=id();
      return (await tx.query(`INSERT INTO tasks(id,org,team,title,status,assignee) VALUES($1,$2,$3,$4,'todo',$5) RETURNING *`,[taskId,a.org,a.team,p.title,p.assignee??a.id])).rows[0];
    });
  }
  async updateTask(a: Actor, raw: unknown) {
    writeAllowed(a); const p = updateTaskSchema.parse(raw); await this.getTask(a,p.id);
    return once(this.db,a,p.operationKey,{op:'update_task',...p},async tx=>{
      const r = await tx.query('UPDATE tasks SET status=$1,version=version+1 WHERE id=$2 AND org=$3 AND team=$4 AND version=$5 RETURNING *',[p.status,p.id,a.org,a.team,p.version]);
      if (!r.rows.length) throw new Fault('CONFLICT','The task changed. Reload it before saving.',409);
      return r.rows[0];
    });
  }
  async searchPages(a: Actor, raw: unknown) {
    const p=searchSchema.parse(raw);
    const values=[a.org,a.team,`%${p.query}%`];
    const where='org=$1 AND team=$2 AND (title ILIKE $3 OR body ILIKE $3)';
    const total=Number((await this.db.query(`SELECT count(*) AS n FROM pages WHERE ${where}`,values)).rows[0].n);
    const items=(await this.db.query(`SELECT id,title,version,task_ids FROM pages WHERE ${where} ORDER BY id LIMIT $4 OFFSET $5`,[...values,p.limit,p.offset])).rows;
    return {items,total,offset:p.offset,nextOffset:p.offset+items.length<total?p.offset+items.length:null};
  }
  async readPage(a: Actor, pageId: string) {
    const p=(await this.db.query('SELECT * FROM pages WHERE id=$1 AND org=$2 AND team=$3',[pageId,a.org,a.team])).rows[0];
    if(!p) throw new Fault('NOT_FOUND','Page not found in your team.',404);
    return p;
  }
  async publishPage(a: Actor, raw: unknown) {
    writeAllowed(a); const p=pageSchema.parse(raw);
    for(const taskId of p.taskIds) await this.getTask(a,taskId);
    const {approvalId,...operation}=p;
    return once(this.db,a,p.operationKey,{op:'publish_page',...operation},async tx=>{
      await useApproval(tx,a,approvalId??'',{op:'publish_page',...operation});
      const pageId=id();
      return (await tx.query('INSERT INTO pages(id,org,team,title,body,task_ids) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[pageId,a.org,a.team,p.title,p.body,JSON.stringify(p.taskIds)])).rows[0];
    });
  }
  async revisePage(a: Actor, pageId: string, body: string, version: number) {
    writeAllowed(a); z.string().min(1).max(20000).parse(body); z.number().int().positive().parse(version);
    await this.readPage(a,pageId);
    const r=await this.db.query(`WITH updated AS (UPDATE pages SET body=$1,version=version+1 WHERE id=$2 AND org=$3 AND team=$4 AND version=$5 RETURNING *) INSERT INTO revisions(id,page_id,version,body) SELECT $6,id,version,body FROM updated RETURNING *`,[body,pageId,a.org,a.team,version,id()]);
    if(!r.rows.length) throw new Fault('CONFLICT','This page changed. Reload before saving.',409);
    return this.readPage(a,pageId);
  }
}
