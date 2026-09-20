import type { ActionKey, TopicKey } from "../taxonomy/labels";
import type { ValidatedAnswers } from "./schemas";

export const THRESHOLDS = {
  needs_reply: { negative: 0.2, positive: 0.8 },
  to_do: { negative: 0.2, positive: 0.8 },
  topic: { confidence: 0.7, positive: 0.8 },
  urgent: { negative: 0.2, positive: 0.9 },
} as const;

export type TopicKeyOrOther = TopicKey | "other";

export interface TopicDecision {
  status: "accepted" | "uncertain";
  key: TopicKeyOrOther | null;
  topKey: TopicKeyOrOther;
  probability: number;
  confidence: number;
}

export interface ActionDecision {
  status: "positive" | "negative" | "uncertain";
  probability: number;
}

export interface DecisionSet {
  topic: TopicDecision;
  urgent: ActionDecision;
  needsReply: ActionDecision;
  toDo: ActionDecision;
  needsReview: boolean;
  reviewReasons: string[];
}

const decideAction = (dimension: ActionKey, probability: number): ActionDecision => {
  const threshold = THRESHOLDS[dimension];
  if (probability >= threshold.positive) {
    return { probability, status: "positive" };
  }
  if (probability <= threshold.negative) {
    return { probability, status: "negative" };
  }
  return { probability, status: "uncertain" };
};

export const decide = (
  answers: ValidatedAnswers,
  context: { bodyMissing: boolean }
): DecisionSet => {
  const reviewReasons: string[] = [];

  let topEntry: { key: string; probability: number } = {
    key: answers.topic.choice,
    probability: 0,
  };
  for (const [key, probability] of Object.entries(answers.topic.probabilities)) {
    if (probability > topEntry.probability) {
      topEntry = { key, probability };
    }
  }
  const topKey = topEntry.key as TopicKeyOrOther;
  const topicAccepted =
    topEntry.probability >= THRESHOLDS.topic.positive &&
    answers.topic.confidence >= THRESHOLDS.topic.confidence;

  const topic: TopicDecision = {
    confidence: answers.topic.confidence,
    key: topicAccepted ? topKey : null,
    probability: topEntry.probability,
    status: topicAccepted ? "accepted" : "uncertain",
    topKey,
  };
  if (!topicAccepted) {
    reviewReasons.push("topic_uncertain");
  }
  if (topicAccepted && topKey === "other") {
    reviewReasons.push("topic_other");
  }

  const urgent = decideAction("urgent", answers.urgent.noul);
  if (urgent.status === "uncertain") {
    reviewReasons.push("urgent_uncertain");
  }

  const needsReply = decideAction("needs_reply", answers.needsReply.noul);
  if (needsReply.status === "uncertain") {
    reviewReasons.push("needs_reply_uncertain");
  }

  const toDo = decideAction("to_do", answers.toDo.noul);
  if (toDo.status === "uncertain") {
    reviewReasons.push("to_do_uncertain");
  }

  if (context.bodyMissing) {
    reviewReasons.push("body_missing");
  }

  const needsReview =
    topic.status === "uncertain" ||
    urgent.status === "uncertain" ||
    needsReply.status === "uncertain" ||
    toDo.status === "uncertain" ||
    context.bodyMissing;

  return { needsReply, needsReview, reviewReasons, toDo, topic, urgent };
};
