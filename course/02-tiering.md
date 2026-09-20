# 02 · Tiering without duplicate servers

The clean design keeps one semantic surface and applies plan quotas, priority,
freshness and feature entitlement after identity is known. Separate servers are
appropriate when trust domains or products differ. Near-duplicate “fast” and
“slow” servers burden discovery and tempt an agent to choose on name alone.

The router's standard and priority providers share `teamspace-v1`; the choice is
therefore safe only within the operation's latency, cost and write constraints.
