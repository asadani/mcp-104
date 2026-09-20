# UX Contract

## Product context

- Audience: engineers learning MCP server and host implementation.
- Primary jobs: inspect team data, compare route candidates and cost ledgers,
  inspect policy rejections, and approve publication.
- Active locale/timezone: English; timestamps are ISO/UTC in technical views.
- Accessibility: WCAG 2.2 AA.

## Business-context sources

| Scope | Source | Reviewed |
|---|---|---|
| Permissions, lifecycle, plan | `PRODUCT.md` | 2026-09-20 |
| API and validation | `src/product.ts`, `src/policy.ts` | 2026-09-20 |

## Visual contract

`DESIGN.md` mirrors canonical tokens in `web/styles.css`. Light theme is the
course baseline. The app owns its visible focus and scrollbar treatment.

## Canonical UI Map

| Capability | Owner | Variant | Verification |
|---|---|---|---|
| Select | native select | platform popup accepted | keyboard E2E |
| Search | `App` search region | 300ms local filter | UI E2E |
| Dialog | approval dialog | modal | UI E2E |
| Toast | live status region | status/error | UI E2E |
| CRUD | product services | pessimistic | integration tests |

## Flow ledger

| Operation | Pending | Success | Failure | Focus |
|---|---|---|---|---|
| Search | preserve rows | update counts | status region | input retained |
| Prepare | stable busy button | open approval | status region | dialog heading |
| Publish | stable dialog | close and refresh | preserve draft | trigger/status |
| Cancel | none | close dialog | n/a | workflow trigger |

Writes are pessimistic, operation-keyed and conflict-aware. No automatic retry
is permitted for a non-idempotent mutation. Search requests are replaceable;
the current UI uses local teaching data, while 103 adds cancellation to remote
search. Authorization failures stay explicit and never fall back to broader
data. Native dialogs are forbidden.
