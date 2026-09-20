# Teamspace product contract

Teamspace gives an organization separate team workspaces for tasks and Markdown
knowledge. The course uses it because the domain is familiar while still having
real authorization, concurrency and cross-system boundaries.

## Invariants

- A member belongs to one organization and team in this teaching model.
- A task or page is visible only when both organization and team match the
  validated actor.
- Admins and members may write; viewers may read.
- Subscription tier enables product capacity or features. It never grants data
  permission and never upgrades a role.
- Task status is `todo`, `doing`, or `done`.
- Writes use optimistic versions. A stale version fails with `CONFLICT`.
- Reusing an operation key with different arguments fails. An uncertain
  operation is inspected before retry.
- Publishing knowledge requires approval for the exact title, body, linked task
  IDs and operation key.

The SQL constraints and server authorization are authoritative. Tool
descriptions, annotations and UI visibility are guidance rather than controls.
