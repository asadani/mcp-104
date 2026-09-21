import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import type { Sql } from "./db.js";
import { id } from "./db.js";
import type { Actor } from "./policy.js";
import { entitlement, Fault, writeAllowed } from "./policy.js";

type Bucket = { tokens: number; at: number };
export type LimiterOptions = { localBucket?: boolean; perActor?: number };
export class FairLimiter {
  private buckets = new Map<string, Bucket>();
  private active = new Map<string, number>();
  private activeBy = new Map<string, number>();
  constructor(
    public capacity = 10,
    public refillPerSecond = 2,
    public concurrency = 3,
    private now = () => Date.now(),
    private options: LimiterOptions = {},
  ) {}
  enter(a: Actor, cost = 1) {
    const key = `${a.org}:${a.id}`,
      now = this.now(),
      b = this.buckets.get(key) ?? { tokens: this.capacity, at: now };
    b.tokens = Math.min(
      this.capacity,
      b.tokens + ((now - b.at) / 1000) * this.refillPerSecond,
    );
    b.at = now;
    // The bucket can be turned off when SharedRate (below) enforces the same limit for every replica.
    if (this.options.localBucket !== false && b.tokens < cost)
      throw new Fault(
        "RATE_LIMITED",
        "Your request allowance is temporarily exhausted. Retry later.",
        429,
        true,
      );
    const orgActive = this.active.get(a.org) ?? 0,
      mine = this.activeBy.get(key) ?? 0;
    if (orgActive >= this.concurrency)
      throw new Fault(
        "CONCURRENCY_LIMIT",
        "This organization has too many operations in flight.",
        429,
        true,
      );
    // One member may not hold every slot their organisation has, so a colleague can always get in.
    if (mine >= (this.options.perActor ?? Math.max(1, this.concurrency - 1)))
      throw new Fault(
        "CONCURRENCY_LIMIT",
        "You have too many operations in flight.",
        429,
        true,
      );
    b.tokens -= cost;
    this.buckets.set(key, b);
    this.active.set(a.org, orgActive + 1);
    this.activeBy.set(key, mine + 1);
    let left = false;
    return () => {
      if (!left) {
        left = true;
        this.active.set(a.org, Math.max(0, (this.active.get(a.org) ?? 1) - 1));
        this.activeBy.set(key, Math.max(0, (this.activeBy.get(key) ?? 1) - 1));
      }
    };
  }
}
// The token bucket in PostgreSQL, so the limit holds however many replicas serve the traffic.
// One statement both refills and spends, and a row lock makes it atomic across processes.
export class SharedRate {
  constructor(
    public db: Sql,
    public capacity = 10,
    public refillPerSecond = 2,
  ) {}
  async take(a: Actor, cost = 1) {
    const denied = () =>
      new Fault(
        "RATE_LIMITED",
        "Your request allowance is temporarily exhausted. Retry later.",
        429,
        true,
      );
    if (cost > this.capacity) throw denied();
    const refilled =
      "LEAST($2::float8, rate_buckets.tokens + EXTRACT(EPOCH FROM (now() - rate_buckets.at)) * $4::float8)";
    const r = await this.db.query(
      `INSERT INTO rate_buckets(key,tokens,at) VALUES($1,$2::float8-$3::float8,now()) ON CONFLICT (key) DO UPDATE SET tokens=${refilled}-$3::float8, at=now() WHERE ${refilled}>=$3::float8 RETURNING tokens`,
      [`${a.org}:${a.id}`, this.capacity, cost, this.refillPerSecond],
    );
    if (!r.rows.length) throw denied();
  }
}
export class Budget {
  constructor(
    public db: Sql,
    public ttlSeconds = 300,
  ) {}
  async reserve(a: Actor, estimate: number) {
    if (!Number.isInteger(estimate) || estimate < 1)
      throw new Fault("INVALID_COST", "Estimate must be a positive integer.");
    await this.sweep(a.org);
    // Check, hold and record in ONE statement: a crash cannot leave a hold that has no reservation row.
    const reservation = id();
    const r = await this.db.query(
      `WITH held AS (UPDATE usage SET reserved=reserved+$1 WHERE org=$2 AND spent+reserved+$1<=allowance RETURNING org) INSERT INTO reservations(id,org,amount,expires_at) SELECT $3,$2,$1,now()+make_interval(secs=>$4::float8) FROM held RETURNING id`,
      [estimate, a.org, reservation, this.ttlSeconds],
    );
    if (!r.rows.length)
      throw new Fault(
        "BUDGET_EXCEEDED",
        "The organization budget cannot reserve this work.",
        429,
      );
    return reservation;
  }
  // Release holds whose owner never settled them (a crash, a lost connection).
  async sweep(org: string) {
    await this.db.query(
      `WITH gone AS (UPDATE reservations SET state='expired' WHERE org=$1 AND state='reserved' AND expires_at<now() RETURNING amount) UPDATE usage SET reserved=reserved-(SELECT COALESCE(sum(amount),0) FROM gone)::int WHERE org=$1`,
      [org],
    );
  }
  async reconcile(a: Actor, reservation: string, actual: number) {
    const r = (
      await this.db.query(
        `SELECT amount,state FROM reservations WHERE id=$1 AND org=$2 AND state IN ('reserved','expired')`,
        [reservation, a.org],
      )
    ).rows[0];
    if (!r)
      throw new Fault(
        "INVALID_RESERVATION",
        "Reservation is missing or already settled.",
        409,
      );
    const claimed = await this.db.query(
      `UPDATE reservations SET actual=$1,state='settled' WHERE id=$2 AND org=$3 AND state=$4 RETURNING id`,
      [actual, reservation, a.org, r.state],
    );
    if (!claimed.rows.length)
      throw new Fault(
        "INVALID_RESERVATION",
        "Reservation is missing or already settled.",
        409,
      );
    // A reservation is a ceiling: callers bound their work by it, and settlement never charges more.
    const charge = Math.min(actual, r.amount);
    if (r.state === "reserved")
      await this.db.query(
        "UPDATE usage SET reserved=reserved-$1,spent=spent+$2 WHERE org=$3",
        [r.amount, charge, a.org],
      );
    else
      await this.db.query("UPDATE usage SET spent=spent+$1 WHERE org=$2", [
        charge,
        a.org,
      ]); // its hold was already released by the sweep
  }
}
// Internal and reserved address space, compared numerically. Matching text prefixes missed
// IPv4-mapped IPv6 (::ffff:127.0.0.1), the unspecified address :: and shared space 100.64.0.0/10.
// IPv6 is an allow-list: only global unicast (2000::/3) passes, minus the ranges that embed IPv4.
function unmapIpv4(raw: string) {
  const ip = raw.toLowerCase().split("%")[0];
  const dotted = /^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (dotted) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
  if (hex) {
    const hi = parseInt(hex[1], 16),
      lo = parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return ip;
}
function privateAddress(raw: string) {
  const ip = unmapIpv4(raw);
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    if ([a, b, c, d].some((n) => n > 255)) return true;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  if (!ip.includes(":")) return true;
  const globalUnicast = /^[23][0-9a-f]{3}:/.test(ip);
  const embedsIpv4 =
    /^2002:/.test(ip) || /^2001:0{0,4}:/.test(ip) || /^2001:db8:/.test(ip);
  return !globalUnicast || embedsIpv4;
}
type ResolvedTarget={url:URL;address:string;family:4|6};
type ImportResponse={status:number;headers:Record<string,string|undefined>;text:string};

async function pinnedHttpsGet(target:ResolvedTarget,signal:AbortSignal,maxBytes:number):Promise<ImportResponse>{
  return new Promise((resolve,reject)=>{
    const req=httpsRequest(target.url,{
      method:'GET',signal,servername:target.url.hostname,headers:{Accept:'text/html,text/plain'},
      lookup:(_hostname,_options,callback)=>callback(null,target.address,target.family),
    },response=>{
      const status=response.statusCode??502,headers:{[key:string]:string|undefined}={};
      for(const [key,value] of Object.entries(response.headers)) headers[key]=Array.isArray(value)?value.join(', '):value;
      const length=Number(headers['content-length']??0);
      if(length>maxBytes){response.destroy();reject(new Fault('TOO_LARGE','Remote content exceeds the import limit.',413));return;}
      const contentType=headers['content-type']?.toLowerCase();
      if(status>=200&&status<300&&(!contentType||(!contentType.startsWith('text/html')&&!contentType.startsWith('text/plain')))){
        response.destroy();reject(new Fault('UNSUPPORTED_CONTENT','Only HTML and plain text can be imported.',415));return;
      }
      let size=0;const chunks:Buffer[]=[];
      response.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>maxBytes){req.destroy(new Fault('TOO_LARGE','Remote content exceeds the import limit.',413));return;}chunks.push(chunk);});
      response.on('end',()=>resolve({status,headers,text:Buffer.concat(chunks).toString('utf8')}));
      response.on('error',reject);
    });
    req.on('error',reject);req.end();
  });
}
export class SafeImporter {
  constructor(
    public maxBytes = 256_000,
    public maxRedirects = 3,
    private resolve = lookup,
    private request=pinnedHttpsGet,
  ) {}
  async validate(raw: string) {
    const url = new URL(raw);
    if (url.protocol !== "https:")
      throw new Fault("URL_REJECTED", "Only HTTPS URLs are allowed.");
    if (url.username || url.password)
      throw new Fault("URL_REJECTED", "Credentials in URLs are not allowed.");
    const answers = await this.resolve(url.hostname, { all: true });
    if (!answers.length || answers.some((x) => privateAddress(x.address)))
      throw new Fault(
        "URL_REJECTED",
        "The URL resolves to a private or local network.",
      );
    const chosen=answers[0];
    return {url,address:chosen.address,family:chosen.family as 4|6};
  }
  async fetch(
    raw: string,
    signal = AbortSignal.timeout(5000),
    maxBytes = this.maxBytes,
  ) {
    let target = await this.validate(raw);
    for (let n = 0; n <= this.maxRedirects; n++) {
      const r = await this.request(target,signal,maxBytes);
      if (r.status >= 300 && r.status < 400) {
        const next = r.headers.location;
        if (!next || n === this.maxRedirects)
          throw new Fault(
            "URL_REJECTED",
            "Redirect chain is invalid or too long.",
          );
        target = await this.validate(new URL(next, target.url).href);
        continue;
      }
      if (r.status < 200 || r.status >= 300)
        throw new Fault(
          "IMPORT_FAILED",
          `Remote server returned HTTP ${r.status}.`,
          502,
          r.status >= 500,
        );
      return r.text
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    }
    throw new Fault("IMPORT_FAILED", "Import did not complete.", 502);
  }
}
export class Jobs {
  constructor(
    public db: Sql,
    public maxAttempts = 3,
    public leaseSeconds = 30,
  ) {}
  async create(a: Actor, input: unknown) {
    writeAllowed(a);
    entitlement(a, "Background jobs");
    const job = id();
    await this.db.query(
      `INSERT INTO jobs(id,actor,org,status,input) VALUES($1,$2,$3,'queued',$4)`,
      [job, a.id, a.org, JSON.stringify(input)],
    );
    return { jobId: job, status: "queued" };
  }
  async get(a: Actor, jobId: string) {
    const j = (
      await this.db.query(
        "SELECT id,status,result,attempts,expires_at FROM jobs WHERE id=$1 AND org=$2 AND actor=$3",
        [jobId, a.org, a.id],
      )
    ).rows[0];
    if (!j) throw new Fault("NOT_FOUND", "Job not found for this actor.", 404);
    return j;
  }
  // Take the next job, or one whose lease lapsed. A job that has used every attempt is dead-lettered, not run again.
  async lease(worker: string, seconds = this.leaseSeconds) {
    await this.db.query(
      `UPDATE jobs SET status='failed',result=$2,lease_until=null,lease_owner=null WHERE status='working' AND lease_until<now() AND attempts>=$1`,
      [this.maxAttempts, JSON.stringify({ error: "attempts exhausted" })],
    );
    return (
      await this.db.query(
        `UPDATE jobs SET status='working',lease_until=now()+make_interval(secs=>$1::float8),lease_owner=$2,attempts=attempts+1 WHERE id=(SELECT id FROM jobs WHERE (status='queued' OR (status='working' AND lease_until<now())) AND attempts<$3 AND expires_at>now() ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`,
        [seconds, worker, this.maxAttempts],
      )
    ).rows[0];
  }
  // Only the worker that holds an unexpired lease may finish the job, so a slow worker cannot overwrite the one that took over.
  async complete(jobId: string, result: unknown, worker: string) {
    return (
      (
        await this.db.query(
          `UPDATE jobs SET status='completed',result=$2,lease_until=null,lease_owner=null WHERE id=$1 AND status='working' AND lease_owner=$3 AND lease_until>now() RETURNING id`,
          [jobId, JSON.stringify(result), worker],
        )
      ).rows.length > 0
    );
  }
  // A failed attempt goes back to the queue, until the attempts run out.
  async fail(jobId: string, message: string, worker: string) {
    return (
      await this.db.query(
        `UPDATE jobs SET status=CASE WHEN attempts>=$4 THEN 'failed' ELSE 'queued' END,result=CASE WHEN attempts>=$4 THEN $2::jsonb ELSE result END,lease_until=null,lease_owner=null WHERE id=$1 AND status='working' AND lease_owner=$3 RETURNING status`,
        [jobId, JSON.stringify({ error: message }), worker, this.maxAttempts],
      )
    ).rows[0]?.status as string | undefined;
  }
}
export type Hop = {
  traceId: string;
  deadline: number;
  budget: number;
  visited: string[];
};
export function nextHop(h: Hop, server: string, cost: number): Hop {
  if (h.deadline <= Date.now())
    throw new Fault("DEADLINE", "Composite deadline expired.", 504);
  if (h.budget < cost)
    throw new Fault("BUDGET_EXCEEDED", "Composite cost budget exhausted.", 429);
  if (h.visited.includes(server))
    throw new Fault("RECURSION", "Composite server cycle detected.", 508);
  if (h.visited.length >= 5)
    throw new Fault("HOP_LIMIT", "Composite call depth exceeded.", 508);
  return { ...h, budget: h.budget - cost, visited: [...h.visited, server] };
}
export class ProductionControls {
  // The shared bucket enforces the per-member rate for every replica; the local limiter keeps the concurrency caps, which protect this process.
  limiter = new FairLimiter(10, 2, 3, () => Date.now(), { localBucket: false });
  rate: SharedRate;
  budget: Budget;
  jobs: Jobs;
  importer = new SafeImporter();
  constructor(db: Sql) {
    this.rate = new SharedRate(db);
    this.budget = new Budget(db);
    this.jobs = new Jobs(db);
  }
}
