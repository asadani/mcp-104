# 03 · Stateless is not asynchronous

Stateless MCP puts complete request context on each request and avoids sticky
sessions. That suits serverless and edge runtimes but a normal tool call can
still complete synchronously. A task/job lifecycle is the slow lane: accept,
persist, lease, retry, expose status and expire.

Batching matters when waiting creates material savings, such as GPU inference,
large exports or indexing. Artificially delaying a cheap database lookup rarely
earns enough to justify another service tier.
