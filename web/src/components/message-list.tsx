import { useState } from "react";

import { getLabels, listMessages } from "../api";
import { actionLabel, formatDateTime, truncate } from "../format";
import { useResource } from "../hooks";
import { navigate } from "../router";
import { Card, Empty, ErrorText, StateBadge } from "./ui";

const PROCESSING_STATUSES = [
  "pending",
  "classifying",
  "classified",
  "applying",
  "retry_wait",
  "completed",
  "failed",
  "skipped",
];

export const MessageList = () => {
  const [topic, setTopic] = useState("");
  const [needsReview, setNeedsReview] = useState("");
  const [processingStatus, setProcessingStatus] = useState("");
  const [limit, setLimit] = useState(25);
  const [cursor, setCursor] = useState<string | null>(null);
  const [history, setHistory] = useState<(string | null)[]>([]);

  const labels = useResource(getLabels);
  const topics = (labels.data?.definitions ?? []).filter(
    (definition) => definition.kind === "topic"
  );

  const key = [topic, needsReview, processingStatus, limit, cursor ?? ""].join("|");
  const resource = useResource(
    () =>
      listMessages({
        cursor,
        limit,
        needsReview: needsReview === "" ? undefined : needsReview === "true",
        processingStatus: processingStatus || undefined,
        topic: topic || undefined,
      }),
    { key }
  );

  const resetPaging = () => {
    setCursor(null);
    setHistory([]);
  };

  const items = resource.data?.items ?? [];

  return (
    <Card title="Messages">
      <div className="filters">
        <div className="field">
          <label htmlFor="filter-topic">Topic</label>
          <select
            id="filter-topic"
            onChange={(event) => {
              setTopic(event.target.value);
              resetPaging();
            }}
            value={topic}
          >
            <option value="">Any topic</option>
            {topics.map((definition) => (
              <option key={definition.key} value={definition.key}>
                {definition.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="filter-review">Review</label>
          <select
            id="filter-review"
            onChange={(event) => {
              setNeedsReview(event.target.value);
              resetPaging();
            }}
            value={needsReview}
          >
            <option value="">Any</option>
            <option value="true">Needs review</option>
            <option value="false">No review needed</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="filter-status">Processing</label>
          <select
            id="filter-status"
            onChange={(event) => {
              setProcessingStatus(event.target.value);
              resetPaging();
            }}
            value={processingStatus}
          >
            <option value="">Any status</option>
            {PROCESSING_STATUSES.map((value) => (
              <option key={value} value={value}>
                {value.replaceAll("_", " ")}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="filter-limit">Per page</label>
          <select
            id="filter-limit"
            onChange={(event) => {
              setLimit(Number(event.target.value));
              resetPaging();
            }}
            value={String(limit)}
          >
            {[10, 25, 50, 100].map((value) => (
              <option key={value} value={String(value)}>
                {value}
              </option>
            ))}
          </select>
        </div>
      </div>

      <ErrorText>{resource.error}</ErrorText>
      {resource.loading && items.length === 0 && <Empty>Loading…</Empty>}
      {!resource.loading && items.length === 0 && (
        <Empty>No messages match these filters.</Empty>
      )}

      {items.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Message</th>
              <th>Received</th>
              <th>Topic</th>
              <th>Actions</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr
                className="clickable"
                key={item.messageId}
                onClick={() =>
                  navigate(`/messages/${encodeURIComponent(item.messageId)}`)
                }
              >
                <td className="subject-cell">
                  <a
                    className="subject"
                    href={`#/messages/${encodeURIComponent(item.messageId)}`}
                    onClick={(event) => event.stopPropagation()}
                  >
                    {truncate(item.subject, 90)}
                  </a>
                  <div className="from">
                    {truncate(item.from, 60)}
                    {item.metadataState !== "available" && (
                      <span className="muted"> · metadata {item.metadataState}</span>
                    )}
                  </div>
                </td>
                <td className="small muted" data-label="Received">
                  {formatDateTime(item.receivedAt)}
                </td>
                <td data-label="Topic">
                  {item.topic ? (
                    <span className="badge">{item.topic}</span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td className="small" data-label="Actions">
                  {(["urgent", "needs_reply", "to_do"] as const).map((name) => (
                    <div key={name} className="muted">
                      {name.replaceAll("_", " ")}: {actionLabel(item.actions[name])}
                    </div>
                  ))}
                </td>
                <td data-label="Status">
                  <StateBadge state={item.processingStatus} />
                  {item.needsReview && <StateBadge state="needs review" />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="row" style={{ marginTop: 12 }}>
        <button
          disabled={history.length === 0 || resource.loading}
          onClick={() => {
            const next = [...history];
            const previous = next.pop() ?? null;
            setHistory(next);
            setCursor(previous);
          }}
          type="button"
        >
          Previous
        </button>
        <button
          disabled={resource.loading || !resource.data?.nextCursor}
          onClick={() => {
            setHistory((value) => [...value, cursor]);
            setCursor(resource.data?.nextCursor ?? null);
          }}
          type="button"
        >
          Next
        </button>
        <span className="muted small">
          {items.length} shown{history.length > 0 ? ` · page ${history.length + 1}` : ""}
        </span>
      </div>
    </Card>
  );
};
