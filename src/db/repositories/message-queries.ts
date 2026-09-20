import { sql } from "drizzle-orm";

import type { Db } from "../client";

export interface MessageListFilters {
  needsReview?: boolean;
  processingStatus?: string;
  topic?: string;
  limit: number;
  cursor?: { firstSeenAt: number; id: string };
}

export interface MessageListRow {
  id: string;
  gmailMessageId: string;
  threadId: string;
  receivedAt: number;
  firstSeenAt: number;
  processingStatus: string;
  applicationStatus: string;
  classificationId: string | null;
  classifiedAt: number | null;
  decisionJson: string | null;
  reviewFlag: number | null;
  reviewReasonsJson: string | null;
  modelVersion: string | null;
  taxonomyVersion: string | null;
  rubricVersion: string | null;
  policyVersion: string | null;
  fromAddress: string | null;
  metadataErrorCode: string | null;
  metadataFetchedAt: number | null;
  metadataState: string;
  subject: string | null;
}

export const listMessageRows = (
  db: Db,
  accountId: string,
  filters: MessageListFilters
): Promise<MessageListRow[]> => {
  const conditions: ReturnType<typeof sql>[] = [sql`m.account_id = ${accountId}`];
  if (filters.needsReview !== undefined) {
    conditions.push(sql`c.review_flag = ${filters.needsReview ? 1 : 0}`);
  }
  if (filters.processingStatus) {
    conditions.push(sql`m.processing_status = ${filters.processingStatus}`);
  }
  if (filters.topic) {
    conditions.push(sql`json_extract(c.decision_json, '$.topic.key') = ${filters.topic}`);
  }
  if (filters.cursor) {
    conditions.push(
      sql`(m.first_seen_at < ${filters.cursor.firstSeenAt} OR (m.first_seen_at = ${filters.cursor.firstSeenAt} AND m.id < ${filters.cursor.id}))`
    );
  }
  const where = sql.join(conditions, sql` AND `);

  return db.all<MessageListRow>(sql`
    SELECT
      m.id,
      m.gmail_message_id AS gmailMessageId,
      m.thread_id AS threadId,
      m.received_at AS receivedAt,
      m.first_seen_at AS firstSeenAt,
      m.processing_status AS processingStatus,
      m.application_status AS applicationStatus,
      m.from_address AS fromAddress,
      m.metadata_error_code AS metadataErrorCode,
      m.metadata_fetched_at AS metadataFetchedAt,
      m.metadata_state AS metadataState,
      m.subject AS subject,
      c.id AS classificationId,
      c.created_at AS classifiedAt,
      c.decision_json AS decisionJson,
      c.review_flag AS reviewFlag,
      c.review_reasons_json AS reviewReasonsJson,
      c.model_version AS modelVersion,
      c.taxonomy_version AS taxonomyVersion,
      c.rubric_version AS rubricVersion,
      c.policy_version AS policyVersion
    FROM messages m
    LEFT JOIN classifications c ON c.id = m.latest_classification_id
    WHERE ${where}
    ORDER BY m.first_seen_at DESC, m.id DESC
    LIMIT ${filters.limit}
  `);
};

export const getMessageDetailRow = (
  db: Db,
  accountId: string,
  gmailMessageId: string
): Promise<
  | (MessageListRow & {
      answerJson: string | null;
      appOwnedLabelIdsJson: string;
      dimensionLocksJson: string;
      lastObservedLabelIdsJson: string;
    })
  | undefined
> =>
  db.get(sql`
    SELECT
      m.id,
      m.gmail_message_id AS gmailMessageId,
      m.thread_id AS threadId,
      m.received_at AS receivedAt,
      m.first_seen_at AS firstSeenAt,
      m.processing_status AS processingStatus,
      m.application_status AS applicationStatus,
      m.app_owned_label_ids_json AS appOwnedLabelIdsJson,
      m.dimension_locks_json AS dimensionLocksJson,
      m.last_observed_label_ids_json AS lastObservedLabelIdsJson,
      m.from_address AS fromAddress,
      m.metadata_error_code AS metadataErrorCode,
      m.metadata_fetched_at AS metadataFetchedAt,
      m.metadata_state AS metadataState,
      m.subject AS subject,
      c.id AS classificationId,
      c.created_at AS classifiedAt,
      c.decision_json AS decisionJson,
      c.answer_json AS answerJson,
      c.review_flag AS reviewFlag,
      c.review_reasons_json AS reviewReasonsJson,
      c.model_version AS modelVersion,
      c.taxonomy_version AS taxonomyVersion,
      c.rubric_version AS rubricVersion,
      c.policy_version AS policyVersion
    FROM messages m
    LEFT JOIN classifications c ON c.id = m.latest_classification_id
    WHERE m.account_id = ${accountId} AND m.gmail_message_id = ${gmailMessageId}
    LIMIT 1
  `);
