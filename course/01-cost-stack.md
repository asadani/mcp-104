# 01 · The cost stack

An MCP server creates real cost: edge and wrapper compute, product API work,
storage/search, outbound traffic, observability, abuse control, support, and any
model the tool itself calls. Agent fan-out and retries can turn cheap calls into
meaningful load. The client's model bill is a separate ledger and may dominate.

Run `npm run lab` and inspect `estimateCost` in `src/economics.ts`. Change one
variable at a time; do not compare vendor micro-costs with client token prices
without common units and workload volume.
