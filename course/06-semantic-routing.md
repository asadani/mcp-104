# 06 · Semantic routing has hard constraints

Two tools named `search_tasks` may disagree about tenants, archived items,
ranking, freshness or returned identifiers. The router in `src/economics.ts`
requires the same semantic contract before considering price or latency.

Run `npm test -- --test-name-pattern="semantically"`. The fast lookalike is
rejected even though its advertised capability and price appear attractive.
