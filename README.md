# MCP 104 · Economics, gateways and futures

MCP 104 uses the production Teamspace system to test claims about server cost,
fast and slow tiers, tool routing, gateways, nested model calls and MCP-to-MCP
composition. It separates behavior in the current protocol from design
predictions.

The runnable baseline targets MCP `2026-07-28`, `@modelcontextprotocol/*` v2 and
Node 22+. Every experiment is deterministic and needs no model key.

## Interactive tutorial

Read the hosted course at **[tech.anujsadani.in/mcp-104](https://tech.anujsadani.in/mcp-104/)**. The repository root is the tutorial page; the runnable economics lab remains available locally at `http://127.0.0.1:5173/app.html`.

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
