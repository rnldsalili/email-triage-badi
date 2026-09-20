export const TOPIC_KEYS = [
  "credit_cards",
  "receipts",
  "payslips",
  "bills",
  "github",
  "job_alerts",
  "applications",
  "work",
  "personal",
  "security",
  "newsletters",
  "promotions",
] as const;

export type TopicKey = (typeof TOPIC_KEYS)[number];

export const ACTION_KEYS = ["urgent", "needs_reply", "to_do"] as const;

export type ActionKey = (typeof ACTION_KEYS)[number];

export type LabelKey = TopicKey | ActionKey;

export interface LabelDefinition {
  readonly key: LabelKey;
  readonly name: string;
  readonly kind: "topic" | "action";
}

export const LABEL_DEFINITIONS: Record<LabelKey, LabelDefinition> = {
  applications: {
    key: "applications",
    kind: "topic",
    name: "Career/Applications & Interviews",
  },
  bills: {
    key: "bills",
    kind: "topic",
    name: "Finance/Bills & Subscriptions",
  },
  credit_cards: {
    key: "credit_cards",
    kind: "topic",
    name: "Finance/Credit Cards",
  },
  github: { key: "github", kind: "topic", name: "Development/GitHub" },
  job_alerts: { key: "job_alerts", kind: "topic", name: "Career/Job Alerts" },
  needs_reply: {
    key: "needs_reply",
    kind: "action",
    name: "Action/Needs Reply",
  },
  newsletters: { key: "newsletters", kind: "topic", name: "Newsletters" },
  payslips: { key: "payslips", kind: "topic", name: "Finance/Payslips" },
  personal: { key: "personal", kind: "topic", name: "Personal" },
  promotions: { key: "promotions", kind: "topic", name: "Promotions" },
  receipts: {
    key: "receipts",
    kind: "topic",
    name: "Finance/Receipts & Confirmations",
  },
  security: { key: "security", kind: "topic", name: "Accounts & Security" },
  to_do: { key: "to_do", kind: "action", name: "Action/To Do" },
  urgent: { key: "urgent", kind: "action", name: "Action/Urgent" },
  work: { key: "work", kind: "topic", name: "Work" },
};

export const LEGACY_LABEL_MAPPINGS: readonly {
  readonly oldName: string;
  readonly key: LabelKey;
}[] = [
  { key: "credit_cards", oldName: "Credit Card" },
  { key: "github", oldName: "Github" },
  { key: "job_alerts", oldName: "Job Alerts" },
  { key: "payslips", oldName: "Payslips" },
  { key: "urgent", oldName: "SOS Need Urgent Attention" },
  { key: "receipts", oldName: "Transaction Receipt and Confirmation" },
];

export const PARENT_CONTAINERS = ["Finance", "Development", "Career", "Action"] as const;

export const LABEL_KEYS: readonly LabelKey[] = [...TOPIC_KEYS, ...ACTION_KEYS];

export const labelKeyForName = (name: string): LabelKey | undefined => {
  const normalized = name.trim().toLowerCase();
  for (const key of LABEL_KEYS) {
    if (LABEL_DEFINITIONS[key].name.toLowerCase() === normalized) {
      return key;
    }
  }
  for (const mapping of LEGACY_LABEL_MAPPINGS) {
    if (mapping.oldName.toLowerCase() === normalized) {
      return mapping.key;
    }
  }
  return undefined;
};
