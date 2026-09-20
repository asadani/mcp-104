# 08 · LLMs inside tools

Use a server-owned model when synthesis, extraction or domain Q&A is the tool's
actual capability. Return model provenance, cost/usage where appropriate,
freshness and citations. Enforce a deadline and token budget.

Avoid a hidden second agent for routine orchestration. It compounds
non-determinism, latency and prompt-injection exposure while making failures and
spend difficult for the host to explain.
