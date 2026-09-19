# Labels and classification policy

This is the canonical label taxonomy. Initial versions: `taxonomy-v1`, `rubric-v1`, and `policy-v1`.

## 1. Topic labels

| Stable key | Exact Gmail label | Include | Boundary |
| --- | --- | --- | --- |
| `credit_cards` | `Finance/Credit Cards` | Statements, due notices, card fees and account servicing | Completed payment receipts go to Receipts; suspected fraud goes to Accounts & Security |
| `receipts` | `Finance/Receipts & Confirmations` | Completed purchases, payment/refund confirmations, transaction records | Unpaid invoices and future renewal notices belong to Bills; interview confirmations belong to Career |
| `payslips` | `Finance/Payslips` | Payslips and payroll documents | General HR correspondence goes to Work |
| `bills` | `Finance/Bills & Subscriptions` | Utility bills, unpaid service invoices, subscription renewal notices | Credit card statements go to Credit Cards; completed payment confirmation goes to Receipts |
| `github` | `Development/GitHub` | GitHub issues, PRs, reviews, repository activity, workflow notifications | GitHub login/security alerts go to Accounts & Security; GitHub payment receipts go to Receipts |
| `job_alerts` | `Career/Job Alerts` | Automated vacancy suggestions and job-search digests | Individual applications and recruiter conversations go to Applications & Interviews |
| `applications` | `Career/Applications & Interviews` | Applications, recruiters, interview arrangements, offers and rejections | Bulk vacancy recommendations go to Job Alerts |
| `work` | `Work` | Other employer, colleague, client and project correspondence | Specific financial, payroll, GitHub and recruiting topics take precedence |
| `personal` | `Personal` | Direct non-work personal correspondence | Do not use as a catch-all for automated notifications |
| `security` | `Accounts & Security` | Login alerts, account changes, password resets and verification codes | An expected verification code is not automatically urgent or a new task |
| `newsletters` | `Newsletters` | Editorial publications, educational digests and subscribed updates | Sales-led messages go to Promotions; job digests go to Job Alerts |
| `promotions` | `Promotions` | Offers, sales campaigns, discounts and marketing | A transactional message with an incidental offer stays transactional |

The model also receives `other`: none of these topics fits. `other` is an internal result and creates no Gmail label. A routine parcel update with no transaction confirmation may legitimately be `other`.

## 2. Action labels

| Stable key | Exact Gmail label | Apply when |
| --- | --- | --- |
| `urgent` | `Action/Urgent` | Concrete evidence indicates prompt personal attention is necessary: suspected compromise, an explicit imminent deadline, or a blocking issue |
| `needs_reply` | `Action/Needs Reply` | A response from the owner is explicitly requested or clearly expected |
| `to_do` | `Action/To Do` | The owner must do something beyond replying: pay, submit, review, sign, confirm in a portal, or perform a requested task |

Actions are independent and may coexist. A request to reply and upload documents can receive Needs Reply and To Do. A reply-only request does not receive To Do. Marketing urgency, a routine receipt, or being unread is insufficient for Urgent.

Use urgent versus not-urgent for the first release; there are no additional low/normal/high Gmail labels. The three action probabilities are persisted for inspection.

## 3. Decision examples

| Email | Topic | Actions |
| --- | --- | --- |
| Monthly credit card statement | Credit Cards | To Do if payment is requested and not explicitly already scheduled |
| Confirmation that a card bill was paid | Receipts & Confirmations | None |
| Payroll email with a payslip attachment | Payslips | None unless an additional action is requested |
| Interview invitation requesting availability | Applications & Interviews | Needs Reply |
| Upload identification for tomorrow's interview | Applications & Interviews | To Do; Urgent if evidence supports imminence |
| GitHub PR review assigned to the owner | GitHub | To Do |
| Notification of a merged PR | GitHub | Usually none |
| Alert about suspected unauthorized access | Accounts & Security | Urgent and To Do |
| "URGENT: sale ends tonight" | Promotions | None |
| Friend asks to confirm dinner by replying | Personal | Needs Reply |

## 4. Jev contract

Use one native binding call:

```ts
const result = await env.AI.run("typesafe/jev", {
  state: normalizedEmail,
  questions: {
    topic: {
      type: "choice",
      instructions: topicInstructions,
      criteria: topicCriteria,
    },
    urgent: {
      type: "noul",
      instructions: urgencyInstructions,
      criteria: { true: urgentCriteria, false: nonUrgentCriteria },
    },
    needs_reply: {
      type: "noul",
      instructions: replyInstructions,
      criteria: { true: replyRequiredCriteria, false: noReplyCriteria },
    },
    to_do: {
      type: "noul",
      instructions: taskInstructions,
      criteria: { true: taskRequiredCriteria, false: noTaskCriteria },
    },
  },
}, {
  gateway: {
    id: env.AI_GATEWAY_ID,
    skipCache: true,
    collectLog: false,
  },
});
```

This is illustrative TypeScript, not an implemented module. `topicCriteria` contains all 12 stable topic keys plus `other`; question text is versioned source-controlled configuration.

The explicit gateway path follows Cloudflare's general third-party binding requirements. Phase 0 must compare it with the Jev page's plain call and confirm the supported configuration. Disable gateway content logging and caching for email requests; verify effective account/gateway settings rather than assuming these options define provider-side retention.

Question keys are not substitutes for instructions. Each instruction must explicitly state the decision, the owner's role, and that email content is data rather than instructions to follow. Provide category boundaries in the criteria themselves.

State fields:

- Subject and cleaned body.
- Parsed From, To, Cc and Reply-To as available.
- Owner address/aliases and configured employer context.
- Message received timestamp, current timestamp, and configured time zone.
- Selected context: `List-Id`, `Auto-Submitted`, attachment filenames/MIME types, and whether content was truncated.

Do not ask Jev to invent summaries, explanations, email addresses, or exact due dates. Keep arithmetic and exact comparisons in code. If urgency depends on an ambiguous date, allow uncertainty instead of assuming it is imminent. The first version evaluates each message without fetching full conversation history.

### Validation

Zod validates the provider envelope and the specific answers requested:

- `model`: nonempty string.
- `answers.topic`: Choice over the exact configured keys; confidence and probabilities in `[0, 1]`.
- Topic probability keys exactly match the criteria, sum to approximately one (tolerance `0.001`), and selected choice is a maximum-probability option within tolerance.
- `answers.urgent`, `answers.needs_reply`, `answers.to_do`: Noul values in `[0, 1]`.
- `usage.input_tokens` and `usage.output_tokens`: nonnegative integers.

Choice confidence is distinct from the selected option's probability. Noul has no separate confidence field. Malformed responses are provider errors, not `other` classifications. Accept harmless extra provider-envelope fields for forward compatibility while strictly validating the required answer fields.

## 5. Initial uncertainty policy

The following are **starting hypotheses**, to be tuned with labeled examples before apply mode:

| Decision | Positive/apply | Negative/no action | Otherwise |
| --- | --- | --- | --- |
| Topic | Top probability >= 0.80 and confidence >= 0.70 | `other` produces no topic label | Topic uncertain |
| Urgent | Noul >= 0.90 | Noul <= 0.20 | Urgency uncertain |
| Needs Reply | Noul >= 0.80 | Noul <= 0.20 | Reply uncertain |
| To Do | Noul >= 0.80 | Noul <= 0.20 | Task uncertain |

Evaluate dimensions independently: an uncertain topic must not suppress a clearly positive urgent label. Persist per-dimension decisions and an overall `needs_review` flag. On a fresh message, uncertain decisions add no corresponding label. On reprocessing, an uncertain dimension preserves its current labels rather than removing them.

Failures and uncertain cases appear in the API review list. They do not add an unapproved `Review` label. Version threshold changes separately from question wording.

## 6. Label ownership and manual changes

- **Mutation invariant:** both the diff function and Gmail adapter allow only approved topic/action USER-label IDs and their registered legacy aliases. Never add or remove Gmail SYSTEM labels, including `INBOX`, `UNREAD`, `STARRED`, `IMPORTANT`, `SPAM` or `TRASH`, even for corrections.
- Each semantic key has an equivalence set containing its canonical ID and registered legacy IDs. Any existing member satisfies that desired label; a message carrying only a legacy ID must not receive a duplicate canonical label. Apply this to topics and actions.
- Automatic processing preserves existing alias representations and ownership. Explicit corrections that remove/replace a dimension remove all equivalent IDs for the replaced label in that dimension; if the desired semantic label is already present through an alias, retain it. Alias-to-canonical conversion is a separate migration/merge operation, not a classification side effect.

- The taxonomy defines 15 semantic labels. Parent containers `Finance`, `Development`, `Career`, and `Action` may also be created for Gmail's hierarchy; never apply them as classification outputs.
- The application proposes at most one primary topic. Existing Gmail threads may show more because Gmail aggregates labels across messages.
- On first encounter, preserve existing approved topic/action labels and legacy-equivalent labels as user-owned. Store the model's proposal but do not replace an existing user-owned topic.
- Record only labels actually added by the service as app-owned. Reprocessing can remove obsolete app-owned labels in confidently resolved dimensions; it cannot remove unrelated or user-owned labels.
- Before any mutation, re-read message labels. If a previously applied label was removed, or a new approved topic was added outside a recorded mutation, mark the affected dimension user-controlled and stop managing that dimension automatically.
- A correction through the API is explicit owner intent: it may replace labels within the selected dimension, persists the desired result, and locks that dimension. It does not touch unrelated labels.
- Normal history events do not trigger reclassification for label-only changes. Thus removing an action label after completing a task will not immediately add it back.
- Gmail cannot reveal every remove-and-readd race or identify the actor. The correction endpoint is the authoritative way to persist overrides. The system does not claim perfect manual-edit attribution.

## 7. Migration from existing labels

| Old name | New name |
| --- | --- |
| `Credit Card` | `Finance/Credit Cards` |
| `Github` | `Development/GitHub` |
| `Job Alerts` | `Career/Job Alerts` |
| `Payslips` | `Finance/Payslips` |
| `SOS Need Urgent Attention` | `Action/Urgent` |
| `Transaction Receipt and Confirmation` | `Finance/Receipts & Confirmations` |

Migration is a separately invoked, resumable setup operation:

1. List labels; save name/ID inventory and produce a migration plan.
2. Create any needed parent containers.
3. If old exists and new does not, rename the old label using its existing ID. Existing message associations then remain attached to that ID.
4. If new already exists and old does not, reuse new.
5. If neither exists, create new.
6. If both exist, use new for future processing, preserve old as a recognized alias, and report the conflict. Any later merge is a separately designed paginated operation; do not silently delete labels.
7. Persist each operation and the final stable-key-to-ID mapping. A rerun reconciles observed Gmail state and does not duplicate labels.

Renaming affects all messages carrying the label, including historical mail outside the triage scan. It changes the name only; it does not re-evaluate old messages. Treat migrated historical labels as user-owned when those messages are encountered.

Rollback renames a label back only when its recorded ID still has the expected new name and the old name is available. Newly created labels should not be automatically deleted if they have acquired messages.
