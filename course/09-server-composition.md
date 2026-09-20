# 09 · Server-to-server composition

Composition works for gateways and stable high-level transactions. Carry actor,
tenant, scopes, trace, deadline, budget and visited hops. Cap depth, prevent
cycles, use audience-specific tokens and keep approval at the trusted host for
consequential effects.

Prefer direct product APIs inside a product-owned server when another MCP hop
adds no independent boundary. Protocol uniformity alone does not justify extra
latency and failure modes.
