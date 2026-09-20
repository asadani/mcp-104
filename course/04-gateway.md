# 04 · Gateway responsibilities

A useful MCP gateway owns server discovery, verified metadata, client OAuth,
delegated identity, policy, audit, quotas and route evidence. It does not mint a
more privileged downstream identity or hide which provider handled a write.

The gateway becomes a high-value failure and trust boundary. Design regional
availability, fail closed for policy, isolate tenant caches, sign catalog data
and make decisions explainable before optimizing route latency.
