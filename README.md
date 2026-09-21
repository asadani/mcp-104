# MCP 104 · Economics, gateways and futures

MCP 104 uses the production Teamspace system to test claims about server cost,
fast and slow tiers, tool routing, gateways, nested model calls and MCP-to-MCP
composition. It separates behavior in the current protocol from design
predictions.

The runnable baseline targets MCP `2026-07-28`, `@modelcontextprotocol/*` v2 and
Node 22+. Every experiment is deterministic and needs no model key.

## Interactive tutorial

Read the hosted course at **[tech.anujsadani.in/mcp-104](https://tech.anujsadani.in/mcp-104/)**. The repository root is the tutorial page, a single self-contained `index.html` in the same format as MCP 101 (no build step; every JSON-RPC frame on it was captured from this repository’s running server, and every code excerpt is pulled from `src/`); the runnable economics lab remains available locally at `http://127.0.0.1:5173/app.html`.

Every chapter can also be listened to: about 30 minutes of narration, one track per chapter, in an AI voice (Kokoro-82M) by default. A switch beside *Listen straight through* flips to Anuj's own voice (about 33 minutes) on `author.html`, and the page remembers the choice as you move between the courses. The scripts are in `narration/`, and `tools/README.md` explains how the audio is made.

## Run

```powershell
npm install
npm run dev
npm run ui
npm run lab
npm test
```

The web UI shows a routing decision, every rejected provider and a cost split
between vendor infrastructure and the client's model. Change the constraints in
`labs/economics.ts` to test priority, batch, residency and semantic mismatches.

## Findings encoded in the experiments

- MCP is not free to a vendor. Wrapper compute is often small; product APIs,
  search, model-backed tools, abuse control and agent retry amplification are
  the larger variables.
- Stateless MCP is a request architecture, not an asynchronous queue. It enables
  elastic/serverless hosting. Durable work uses a task or job lifecycle.
- Fast and slow lanes are plausible as plan priority or execution modes within a
  stable server surface. Duplicating near-identical servers adds discovery and
  selection ambiguity.
- A gateway can centralize discovery, OAuth, policy, audit, budgets and routing.
  It must preserve end-user identity and cannot turn unlike tools into safe
  substitutes.
- Model routing is easier because models often share text interfaces. Tool
  routing must also match semantics, permissions, side effects, freshness,
  residency and trust.
- An LLM inside a tool is justified when synthesis is the product. Its token
  spend, model, latency and data policy should be visible to the caller.
- MCP-to-MCP composition is valuable for stable workflows and gateways when the
  chain carries identity, trace, deadline, budget and visited hops.

## Router contract

[`src/economics.ts`](src/economics.ts) treats capability name as only one
constraint. It rejects providers for semantic mismatch before comparing cost.
Writes require explicit write support; live requests reject cached paths;
residency, mode, latency, budget, availability and provider verification are
hard constraints. With no valid route, the result is a refusal rather than a
silent downgrade.

The `explain_route` MCP tool returns the same evidence but does not execute the
routed operation. This keeps routing policy inspectable and deterministic.

## Course

The ten checkpoints in [`course/`](course) move from cost accounting to a
bounded forecast. The final chapter labels current facts, likely developments
and speculative ideas separately. MCP 103 remains the implementation reference
for rate limits, jobs, URL ingestion, retries and operations.

```powershell
npm run typecheck
npm test
npm run build
npm run test:ui
```

Protocol facts use the MCP
[`2026-07-28` release notes](https://blog.modelcontextprotocol.io/posts/2026-07-28/),
the [Tasks extension](https://tasks.extensions.modelcontextprotocol.io/specification/draft/tasks),
and the [TypeScript SDK v2 protocol guide](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions).
Forecasts in chapter 10 are explicitly labeled as likely or speculative.

## Operational notes

- **`GET /healthz`** answers 200 after a `SELECT 1`, or 503 if the database is unreachable. It needs no token, so a container or load-balancer health check can use it.
- **`/mcp` challenges instead of failing.** A missing, invalid, expired or wrong-audience token gets `401` with `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource"`. The check (`requireToken` in `src/auth.ts`) runs in Express *before* the MCP handler: an error thrown inside the handler factory is reported by the SDK as a 500, which would hide the challenge from the client.
- **Demo data is development-only.** Members and tasks are seeded unless `NODE_ENV=production`; set `SEED_DEMO_DATA=1` to opt in deliberately.
- **Writes and operation results commit atomically.** `once()` runs the idempotency claim, product write and stored result in one database transaction. A crash before commit rolls everything back; a lost response after commit is replayed by the same key.
- **One pipeline for every tool.** `guarded()` in `src/mcp.ts` identifies the caller, takes a rate-limit permit, runs the tool, writes an audit row (outcome `success`, `failure` or `throttled`) and answers in one structured shape. That includes `explain_route`, the job tools and `import_url`.
- **The URL importer validates and pins destinations.** It compares addresses numerically (IPv4-mapped IPv6 unwrapped, `100.64.0.0/10` blocked, IPv6 allow-listed to global unicast), then connects to the checked address while preserving the hostname for TLS.
- **A refused resource read is a structured not-found.** `resources/read` for a page that is missing, in another team or in another organisation answers with the SDK’s `ResourceNotFoundError` (JSON-RPC `-32602`, with the URI in `data`), never a bare internal error.
- **The circuit breaker guards the product APIs.** `Downstream` keeps one breaker per API. It counts only outages (unreachable, 5xx, blown deadlines), never a definite refusal such as `NOT_FOUND`.
- **Production needs its settings.** With `NODE_ENV=production` the server refuses to start unless `DATABASE_URL`, `TOKEN_SECRET` and `PUBLIC_ORIGIN` are set.
- **Rate limiting is shared.** `SharedRate` keeps the per-member token bucket in PostgreSQL (`rate_buckets`), so the allowance is one number for every replica. The concurrency caps (three per organisation, two per member) stay per process on purpose.
- **Budget holds expire.** A reservation lives five minutes and is swept by the next reservation. Settlement never charges more than was reserved, and `import_url` names its size-and-budget ceiling `maxKilobytes`.
- **The inherited production controls are closed.** URL imports pin the validated IP, `/api/ops` is admin-only, and a maintenance sweep applies retention to operational tables.
- **Jobs have a worker.** `src/worker.ts` runs in the process (`WORKER=off` disables it) or on its own with `npm run worker` against a shared PostgreSQL. A lease records its owner, only the owner may complete the job, and a job is dead-lettered after three attempts.
- **A composite tool uses `nextHop()`.** `draft_release_note` reads the completed tasks and the checklist page as two hops under one deadline, one budget and one route, and stops at a draft.
- **Deployment files are written, not proven.** `Dockerfile` and `infra/aws/template.yaml` were not built, linted or deployed where they were written. See `infra/aws/README.md`.
