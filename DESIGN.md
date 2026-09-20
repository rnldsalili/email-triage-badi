---
name: Badi
description: A calm classification ledger for reviewing uncertain Gmail labels before they are applied.
colors:
  paper: "#eef3f0"
  paper-deep: "#e2ebe7"
  sheet: "#fbfcfa"
  sheet-blue: "#f0f6f6"
  ink: "#142f38"
  ink-soft: "#405c64"
  ink-faint: "#5d7479"
  rule: "#c9d7d4"
  rule-strong: "#9eb4b1"
  nav: "#e4eeea"
  nav-active: "#d4e8e1"
  nav-hover: "#dceae5"
  primary: "#0b5a69"
  primary-deep: "#084552"
  primary-soft: "#d9ecef"
  danger: "#a0443d"
  danger-soft: "#f8e3df"
  ok: "#28664e"
  ok-soft: "#dceee4"
  warn: "#8b5c13"
  warn-soft: "#fff0c9"
  control: "#f7faf8"
  control-hover: "#eaf3f0"
  control-border-hover: "#789693"
  on-primary: "#fff"
  danger-deep: "#84352f"
  focus: "#3c8ea0"
  nav-active-border: "#b4d0c9"
  review-border: "#b9cfce"
  review-rule: "#bdd1d0"
  review-action-border: "#8eb5b1"
  badge: "#e4ecea"
  badge-border: "#d1dfdc"
  ok-border: "#bddacb"
  warn-border: "#ebd28c"
  danger-border: "#e9bbb4"
  focus-shadow: "rgb(11 90 105 / 13%)"
typography:
  body:
    fontFamily: 'Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'
    fontSize: "14px"
    lineHeight: "1.45"
  headline:
    fontSize: "24px"
    fontWeight: 700
    letterSpacing: "-0.035em"
  title:
    fontSize: "16px"
    fontWeight: 700
    letterSpacing: "-0.01em"
  brand:
    fontSize: "26px"
    fontWeight: 750
    letterSpacing: "-0.045em"
  label:
    fontSize: "11px"
    fontWeight: 700
    letterSpacing: "0.055em"
  badge:
    fontSize: "11px"
    fontWeight: 650
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
    fontSize: "12px"
rounded:
  small: "4px"
  control: "4px"
  card: "6px"
  pill: "999px"
spacing:
  control: "8px 13px"
  card: "20px"
  stack: "18px"
components:
  button-default:
    backgroundColor: "{colors.control}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "{spacing.control}"
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.control}"
    padding: "{spacing.control}"
  button-danger:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.control}"
    padding: "{spacing.control}"
  input:
    backgroundColor: "{colors.control}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "8px 10px"
  card:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    padding: "{spacing.card}"
  navigation-item:
    backgroundColor: "transparent"
    textColor: "{colors.ink-soft}"
    rounded: "{rounded.small}"
    padding: "9px 11px"
  badge:
    backgroundColor: "{colors.badge}"
    textColor: "{colors.ink-soft}"
    rounded: "{rounded.pill}"
    padding: "3px 8px"
---

# Design System: Badi

## Overview

**Creative North Star: “The Classification Ledger”**

Badi is a private mailbox finding aid: a calm records desk where the owner verifies evidence before it becomes a Gmail label. The redesign replaces the dark generic console with a cool paper workspace, ruled sections, indexed navigation, and explicit review marks. It is an operating surface, so the visual world earns trust through legibility, stable affordances, and named states rather than decoration.

The physical scene is an owner at a desk in clear morning light, reading a small stack of records. The shell is the index, the overview is the open review ledger, and message detail is the accession record. The interface remains compact enough for frequent desktop use and deliberately reflows into a touch-friendly reading list on a phone.

**Key Characteristics:**

- Cool paper ground with blue-black ink and pale blue ledger sheets.
- Ruled dividers and quiet tonal layering instead of anonymous floating cards.
- Teal for trusted actions and navigation; amber for verification; coral only for blocked or consequential work.
- System sans for work, compact monospace for IDs, versions, and measurements.

## Colors

The palette is light because the owner reads and reviews at a desk; the ink is cool and high-contrast, while signals are reserved for decisions.

### Primary

- **Ledger Teal** (`#0b5a69`): primary actions, selected navigation, and links.
- **Deep Teal** (`#084552`): pressed and high-emphasis action states.

### Semantic

- **Verification Amber** (`#8b5c13` on `#fff0c9`): uncertainty, review, and pending work.
- **Quiet Green** (`#28664e` on `#dceee4`): ready, applied, and healthy states.
- **Record Coral** (`#a0443d` on `#f8e3df`): failures, conflicts, authentication requirements, and consequential confirmation.

### Neutral

- **Paper** (`#eef3f0`) and **Paper Deep** (`#e2ebe7`): application canvas and row hover.
- **Sheet** (`#fbfcfa`) and **Ledger Blue** (`#f0f6f6`): content sheets and the review queue.
- **Ink** (`#142f38`), **Soft Ink** (`#405c64`), and **Faint Ink** (`#5d7479`): hierarchy for content, metadata, and labels.
- **Rule** (`#c9d7d4`) and **Strong Rule** (`#9eb4b1`): grouping and control boundaries.

**The Named State Rule.** Signal color never stands alone. Every amber, green, or coral mark carries a readable state or action label.

## Typography

The interface uses a stable system sans stack for operational reading. A compact system monospace face is reserved for identifiers, build versions, and measured values; it is never used as a mood costume.

### Hierarchy

- **Headline** (700, 24px): route titles such as “Review desk,” with tight tracking.
- **Title** (700, 16px): sheet and section headings.
- **Brand** (750, 26px): Badi wordmark in the rail.
- **Body** (400, 14px / 1.45): controls, prose, and operational content.
- **Label** (700, 11px, tracked uppercase): field labels, table heads, and metadata labels.
- **Badge** (650, 11px): state pills and review marks.
- **Mono** (12px): technical identifiers and version strings.

## Layout

The authenticated shell is a two-column index rail and ledger workspace. The rail is 246px on wide screens and becomes a horizontal indexed header below 720px. The workspace uses a max-width of 1380px with generous side padding on desktop and safe-area-aware 14px padding on phones.

The overview leads with one wide review ledger. Its entries are ruled records: subject, sender, topic, review reason, relative time, and a direct Review action. Mode and run controls follow in a two-column support area; status figures and activity are secondary. Other routes retain dense tables but transform each row into a labeled record below 880px. Detail key/value lists stack labels above values on narrow screens. Controls reach at least 44px on coarse pointers.

## Elevation & Depth

The system is mostly flat and paper-like. Rules and pale surface shifts carry grouping. The review ledger alone receives a soft, low-opacity shadow to distinguish the current work sheet from the canvas; there are no gradients, blur effects, or hard offset shadows. Focus uses a clear teal outline and a restrained matching ring.

## Shapes

Controls and sheets use small 4–6px corners: approachable but not playful. Status marks are the only fully rounded shape. Ruled dividers, not thick colored rails, provide structure. Inputs share the same light control surface and strong rule as buttons. Links underline on hover with a deliberate offset.

## Components

### Navigation

The rail uses authored one-weight SVG line glyphs with text labels. The active destination receives a pale green-blue tab treatment and `aria-current="page"`; hover and focus are explicit. The account block stays at the bottom on desktop and follows navigation on mobile.

### Review ledger

The review ledger is the primary overview component. It names why a classification needs attention and keeps Review as the single dominant action. Empty and loading states explain what Badi is doing; errors name the unavailable queue rather than presenting a blank surface.

### Buttons and fields

Buttons use consistent ruled controls. Teal is reserved for the primary action, coral for consequential confirmation, and the neutral control for supporting actions. Labels remain visible above inputs. Disabled, loading, error, hover, active, and keyboard focus states are explicit.

### Tables and records

Desktop tables use light ruled rows and restrained hover. On narrow screens each row becomes a record with its column name printed above the value. Message subjects remain real links, and technical values remain monospace.

## Do's and Don'ts

### Do:

- Lead with messages that need a human decision, not a metric grid.
- Pair every state color with text and preserve the product's uncertainty policy.
- Keep Gmail as the reading destination and Badi as the review/orchestration layer.
- Preserve normal HTML controls, keyboard order, screen-reader labels, and touch targets.
- Keep the ledger grammar consistent across navigation, forms, detail, activity, and labels.

### Don't:

- Reintroduce the incumbent dark dashboard or anonymous card wall.
- Use color as the only indication of urgency, uncertainty, success, or failure.
- Use monospace as decoration, gradients, glass, or large ornamental illustrations.
- Hide destructive or apply-mode actions behind unclear labels.
- Invent mailbox claims, automation outcomes, or visual assets that the product cannot prove.
