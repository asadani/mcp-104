---
version: alpha
name: "Teamspace"
description: "A calm operations ledger that makes system boundaries visible."
colors:
  ink: "#11231f"
  muted: "#60736c"
  paper: "#f4f7f2"
  card: "#ffffff"
  line: "#cad7d0"
  jade: "#087b62"
  mint: "#a9e5cf"
  warning: "#d57d1f"
  danger: "#b6433c"
  focus: "#006fff"
typography:
  sans:
    fontFamily: "Aptos, Segoe UI, system-ui, sans-serif"
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace"
rounded:
  DEFAULT: "0.5rem"
  sm: "0.3125rem"
  lg: "1rem"
spacing:
  control: "0.625rem"
  panel: "1.75rem"
  page-max: "73.75rem"
components:
  button: {}
  card: {}
  dialog: {}
  search: {}
  status: {}
---

# Teamspace Design System

## Overview

The North Star is an operations notebook: dense enough for daily work, calm
enough to trust, with the architecture trace treated like a first-class ledger.
The audience is engineers learning MCP through a real product. The register is
product-first. The memorable signature is the visible HOST → MCP → PRODUCT API
boundary; CRUD controls remain familiar. Avoid generic gradient SaaS cards and
terminal cosplay. Runtime CSS in `web/styles.css` is canonical and this file
mirrors its accepted tokens.

## Colors

Paper and jade communicate an internal tool rather than a marketing surface.
Semantic status always includes text. `focus` is reserved for keyboard focus.
Forced colors retain native outlines and scrollbar behavior.

## Typography

Aptos/Segoe UI carries application text; monospace identifies protocol layers,
IDs and trace events. Headings use tight tracking but body text stays at a
comfortable line height and measure.

## Layout

The 1180px workspace uses paired task/knowledge columns and collapses to one
column below 760px. Lists own their natural page scroll. Dialog bodies own
overflow only when the viewport is short.

## Elevation & Depth

Borders and tonal surfaces establish hierarchy. Shadows are limited to the
toast and modal backdrop; normal content is flat.

## Shapes

Controls use 8px radii; major panels use 16px. Status tags use compact 5px
corners rather than pills.

## Components

Buttons expose hover, focus, disabled and busy states. Search always offers a
label and immediate clear control. Modal approval names the consequence and
keeps Cancel separate. Motion is unnecessary; reduced-motion is honored.

## Do's and Don'ts

- **Do:** show which layer performed an action.
- **Do:** keep identity, role and tier visible during permission labs.
- **Don't:** suggest a tool annotation enforces policy.
- **Don't:** hide errors or partial results behind decorative feedback.
