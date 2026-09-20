import { describe, expect, it } from "vitest";

import type { DecisionSet } from "../src/classifier/policy";
import { computeLabelDiff, detectManualChanges } from "../src/services/label-diff";
import type { LabelMappingInfo } from "../src/services/label-diff";

const MAPPINGS: LabelMappingInfo[] = [
  { aliasIds: [], canonicalId: "Label_bills", semanticKey: "bills" },
  {
    aliasIds: ["Label_legacy_receipts"],
    canonicalId: "Label_receipts",
    semanticKey: "receipts",
  },
  { aliasIds: [], canonicalId: "Label_work", semanticKey: "work" },
  {
    aliasIds: ["Label_legacy_urgent"],
    canonicalId: "Label_urgent",
    semanticKey: "urgent",
  },
  { aliasIds: [], canonicalId: "Label_needs_reply", semanticKey: "needs_reply" },
  { aliasIds: [], canonicalId: "Label_to_do", semanticKey: "to_do" },
];

const APPROVED = new Set([
  "Label_bills",
  "Label_receipts",
  "Label_legacy_receipts",
  "Label_work",
  "Label_urgent",
  "Label_legacy_urgent",
  "Label_needs_reply",
  "Label_to_do",
]);

const decisions = (overrides: Partial<DecisionSet> = {}): DecisionSet => ({
  needsReply: { probability: 0.05, status: "negative" },
  needsReview: false,
  reviewReasons: [],
  toDo: { probability: 0.05, status: "negative" },
  topic: {
    confidence: 0.95,
    key: "bills",
    probability: 0.95,
    status: "accepted",
    topKey: "bills",
  },
  urgent: { probability: 0.05, status: "negative" },
  ...overrides,
});

describe(computeLabelDiff, () => {
  it("adds the canonical label for an accepted topic", () => {
    const diff = computeLabelDiff({
      approvedUserLabelIds: APPROVED,
      decisions: decisions(),
      mappings: MAPPINGS,
      state: { appOwnedLabelIds: [], currentLabelIds: ["INBOX"], dimensionStates: {} },
    });
    expect(diff.add).toStrictEqual(["Label_bills"]);
    expect(diff.remove).toStrictEqual([]);
  });

  it("treats an existing legacy alias as satisfying the desired label", () => {
    const diff = computeLabelDiff({
      approvedUserLabelIds: APPROVED,
      decisions: decisions({
        topic: {
          confidence: 0.9,
          key: "receipts",
          probability: 0.9,
          status: "accepted",
          topKey: "receipts",
        },
      }),
      mappings: MAPPINGS,
      state: {
        appOwnedLabelIds: [],
        currentLabelIds: ["INBOX", "Label_legacy_receipts"],
        dimensionStates: {},
      },
    });
    expect(diff.add).toStrictEqual([]);
    expect(diff.remove).toStrictEqual([]);
  });

  it("preserves everything for an uncertain topic", () => {
    const diff = computeLabelDiff({
      approvedUserLabelIds: APPROVED,
      decisions: decisions({
        topic: {
          confidence: 0.5,
          key: null,
          probability: 0.5,
          status: "uncertain",
          topKey: "bills",
        },
      }),
      mappings: MAPPINGS,
      state: {
        appOwnedLabelIds: ["Label_bills"],
        currentLabelIds: ["INBOX", "Label_bills"],
        dimensionStates: {},
      },
    });
    expect(diff.add).toStrictEqual([]);
    expect(diff.remove).toStrictEqual([]);
    expect(diff.preserved).toContain("topic");
  });

  it("removes obsolete app-owned topic labels when the topic changes", () => {
    const diff = computeLabelDiff({
      approvedUserLabelIds: APPROVED,
      decisions: decisions({
        topic: {
          confidence: 0.9,
          key: "work",
          probability: 0.9,
          status: "accepted",
          topKey: "work",
        },
      }),
      mappings: MAPPINGS,
      state: {
        appOwnedLabelIds: ["Label_bills"],
        currentLabelIds: ["INBOX", "Label_bills"],
        dimensionStates: {},
      },
    });
    expect(diff.add).toStrictEqual(["Label_work"]);
    expect(diff.remove).toStrictEqual(["Label_bills"]);
  });

  it("preserves user-owned topic labels it did not add", () => {
    const diff = computeLabelDiff({
      approvedUserLabelIds: APPROVED,
      decisions: decisions({
        topic: {
          confidence: 0.9,
          key: "work",
          probability: 0.9,
          status: "accepted",
          topKey: "work",
        },
      }),
      mappings: MAPPINGS,
      state: {
        appOwnedLabelIds: [],
        currentLabelIds: ["INBOX", "Label_bills"],
        dimensionStates: {},
      },
    });
    expect(diff.add).toStrictEqual(["Label_work"]);
    expect(diff.remove).toStrictEqual([]);
  });

  it("removes only app-owned action labels on a negative decision", () => {
    const diff = computeLabelDiff({
      approvedUserLabelIds: APPROVED,
      decisions: decisions({ toDo: { probability: 0.1, status: "negative" } }),
      mappings: MAPPINGS,
      state: {
        appOwnedLabelIds: ["Label_to_do"],
        currentLabelIds: ["INBOX", "Label_to_do", "Label_urgent"],
        dimensionStates: {},
      },
    });
    expect(diff.remove).toStrictEqual(["Label_to_do"]);
    expect(diff.remove).not.toContain("Label_urgent");
  });

  it("adds an action label independently of the topic", () => {
    const diff = computeLabelDiff({
      approvedUserLabelIds: APPROVED,
      decisions: decisions({ urgent: { probability: 0.97, status: "positive" } }),
      mappings: MAPPINGS,
      state: { appOwnedLabelIds: [], currentLabelIds: ["INBOX"], dimensionStates: {} },
    });
    expect(diff.add).toContain("Label_urgent");
    expect(diff.add).toContain("Label_bills");
  });

  it("preserves locked and user-controlled dimensions", () => {
    const locked = computeLabelDiff({
      approvedUserLabelIds: APPROVED,
      decisions: decisions(),
      mappings: MAPPINGS,
      state: {
        appOwnedLabelIds: [],
        currentLabelIds: ["INBOX"],
        dimensionStates: { topic: { locked: true, userControlled: false } },
      },
    });
    expect(locked.add).toStrictEqual([]);
    expect(locked.preserved).toContain("topic");

    const controlled = computeLabelDiff({
      approvedUserLabelIds: APPROVED,
      decisions: decisions(),
      mappings: MAPPINGS,
      state: {
        appOwnedLabelIds: [],
        currentLabelIds: ["INBOX"],
        dimensionStates: { topic: { locked: false, userControlled: true } },
      },
    });
    expect(controlled.add).toStrictEqual([]);
    expect(controlled.userControlled).toContain("topic");
  });

  it("removes app-owned topic labels for a confident other", () => {
    const diff = computeLabelDiff({
      approvedUserLabelIds: APPROVED,
      decisions: decisions({
        topic: {
          confidence: 0.9,
          key: "other",
          probability: 0.9,
          status: "accepted",
          topKey: "other",
        },
      }),
      mappings: MAPPINGS,
      state: {
        appOwnedLabelIds: ["Label_bills"],
        currentLabelIds: ["INBOX", "Label_bills"],
        dimensionStates: {},
      },
    });
    expect(diff.add).toStrictEqual([]);
    expect(diff.remove).toStrictEqual(["Label_bills"]);
  });

  it("never proposes system labels or unapproved ids", () => {
    const diff = computeLabelDiff({
      approvedUserLabelIds: APPROVED,
      decisions: decisions({
        topic: {
          confidence: 0.9,
          key: "work",
          probability: 0.9,
          status: "accepted",
          topKey: "work",
        },
        urgent: { probability: 0.05, status: "negative" },
      }),
      mappings: MAPPINGS,
      state: {
        appOwnedLabelIds: ["Label_bills", "UNREAD"],
        currentLabelIds: ["INBOX", "UNREAD", "Label_bills"],
        dimensionStates: {},
      },
    });
    for (const id of [...diff.add, ...diff.remove]) {
      expect(APPROVED.has(id)).toBeTruthy();
    }
    expect(diff.remove).not.toContain("UNREAD");
  });
});

describe(detectManualChanges, () => {
  it("flags a dimension whose app-owned label disappeared", () => {
    const changed = detectManualChanges({
      appOwnedLabelIds: ["Label_bills"],
      currentLabelIds: ["INBOX"],
      lastObservedLabelIds: ["INBOX", "Label_bills"],
      mappings: MAPPINGS,
    });
    expect(changed).toStrictEqual(["topic"]);
  });

  it("flags a dimension where an approved label appeared outside a recorded mutation", () => {
    const changed = detectManualChanges({
      appOwnedLabelIds: [],
      currentLabelIds: ["INBOX", "Label_work"],
      lastObservedLabelIds: ["INBOX"],
      mappings: MAPPINGS,
    });
    expect(changed).toStrictEqual(["topic"]);
  });

  it("ignores unrelated labels", () => {
    const changed = detectManualChanges({
      appOwnedLabelIds: [],
      currentLabelIds: ["INBOX", "Label_travel"],
      lastObservedLabelIds: ["INBOX"],
      mappings: MAPPINGS,
    });
    expect(changed).toStrictEqual([]);
  });
});
