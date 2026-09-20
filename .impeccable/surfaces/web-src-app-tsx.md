---
version: 1
slug: "web-src-app-tsx"
primary_target: "web/src/app.tsx"
related_targets: ["web/src/styles.css","web/src/components/overview.tsx","web/src/components/message-list.tsx","web/src/components/message-detail.tsx","web/src/components/activity.tsx","web/src/components/labels.tsx","web/src/components/login.tsx","web/src/components/ui.tsx"]
---

## Surface

Owner dashboard across the authenticated shell, overview, messages, activity, labels, message detail, and sign-in. Mode: Operate. The first viewport must make uncertain classifications and the safest next action obvious.

## Direction contract

### THESIS
Turn triage into a finding aid: the dashboard is a calm records desk where the owner verifies evidence before it becomes a Gmail label. Refuse the category-default grid of anonymous dark cards; use an indexed review ledger with one clear work queue and supporting operational controls.

### OWN-WORLD
The Classification Ledger uses cool paper surfaces, dark blue-black ink, ruled dividers, tab-like navigation, and restrained signal colors. Sections feel like open archival sheets rather than floating tiles. Uncertainty is a named “Needs review” mark with a warm verification color; success is a quiet confirmation stamp; danger is reserved for blocked or consequential work. System sans is the working face; compact mono is reserved for IDs, versions, and measurements.

### STORY
On arrival, the owner sees whether the mailbox is connected, how much work is waiting, and which messages need a human eye. They can open the review queue, inspect the evidence, correct only the needed dimensions, and hand off to Gmail. Processing mode, budget, failures, label setup, and activity remain available without competing with review.

### FIRST VIEWPORT
The shell has a slim indexed rail and a wide ledger workspace. The overview opens with a “Review desk” heading, a compact mailbox/mode status strip, and a prominent review queue showing flagged messages as ruled records with sender, subject, uncertainty reason, and a direct “Review” action. A quieter operational summary and bounded-run actions sit below, not above, the queue. The primary action is opening a message that needs review.

### FORM
Grounded candidate 5, the archive finding-aid / accession desk, selected from direction seed 46787e91. Build code-led because no image-generation tool is available in this session. Preserve standard HTML controls, keyboard flow, existing routes, API behavior, and phone usability; carry the ledger grammar through navigation, tables, forms, banners, badges, and loading/empty/error states.

### FINISH
unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
