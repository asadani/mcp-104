# 03 · Stateless is not asynchronous

Stateless MCP puts complete request context on each request and avoids sticky
sessions. That suits serverless and edge runtimes but a normal tool call can
still complete synchronously. A task/job lifecycle is the slow lane: accept,
persist, lease, retry, expose status and expire.

Batching matters when waiting creates material savings, such as GPU inference,
large exports or indexing. Artificially delaying a cheap database lookup rarely
earns enough to justify another service tier.

Inherited from 103: operation records are deleted by `cleanupOperationalData()` seven days
after they were created, so a retry after that is a new operation and the write runs again.
Design any queueing delay, and any client retry policy, to finish well inside that window.
