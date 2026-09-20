import { useState } from "react";

import { listOperations, requestBackfill } from "../api";
import { formatDateTime, formatProgress, humanize } from "../format";
import { useKeyedAction, useResource } from "../hooks";
import { Card, Empty, ErrorText, StateBadge } from "./ui";

const KIND_FILTERS = [
  "",
  "sync",
  "backfill",
  "metadata_refresh",
  "migration_plan",
  "migrate",
  "reprocess",
  "apply",
  "correction",
  "retry",
];

const isoDate = (date: Date): string => date.toISOString().slice(0, 10);

const defaultRange = (): { after: string; before: string } => {
  const before = new Date();
  const after = new Date(before.getTime() - 30 * 86_400_000);
  return { after: isoDate(after), before: isoDate(before) };
};

export const Activity = () => {
  const [kind, setKind] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [history, setHistory] = useState<(string | null)[]>([]);
  const [range, setRange] = useState(defaultRange);
  const [maxMessages, setMaxMessages] = useState(200);
  const [notice, setNotice] = useState<string | null>(null);

  const resource = useResource(
    () => listOperations({ cursor, kind: kind || undefined }),
    {
      intervalMs: 15_000,
      key: `${kind}|${cursor ?? ""}`,
    }
  );

  const backfill = useKeyedAction(
    (key, input: Parameters<typeof requestBackfill>[0]) => requestBackfill(input, key),
    () => {
      setNotice("Backfill queued. Track its progress below.");
      resource.refresh();
    }
  );

  const submitBackfill = (event: React.FormEvent) => {
    event.preventDefault();
    const receivedAfter = new Date(`${range.after}T00:00:00Z`);
    const receivedBefore = new Date(`${range.before}T00:00:00Z`);
    if (Number.isNaN(receivedAfter.getTime()) || Number.isNaN(receivedBefore.getTime())) {
      setNotice("Choose both a start and an end date.");
      return;
    }
    if (receivedBefore <= receivedAfter) {
      setNotice("The end date must be after the start date.");
      return;
    }
    if (!Number.isFinite(maxMessages) || maxMessages < 1) {
      setNotice("Max messages must be at least 1.");
      return;
    }
    backfill.run({
      maxMessages,
      receivedAfter: receivedAfter.toISOString(),
      receivedBefore: receivedBefore.toISOString(),
    });
  };

  const items = resource.data?.items ?? [];

  return (
    <div className="stack">
      <Card title="Scan older inbox mail">
        <form onSubmit={submitBackfill}>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="backfill-after">Received after</label>
              <input
                id="backfill-after"
                onChange={(event) =>
                  setRange((value) => ({ ...value, after: event.target.value }))
                }
                type="date"
                value={range.after}
              />
            </div>
            <div className="field">
              <label htmlFor="backfill-before">Received before</label>
              <input
                id="backfill-before"
                onChange={(event) =>
                  setRange((value) => ({ ...value, before: event.target.value }))
                }
                type="date"
                value={range.before}
              />
            </div>
            <div className="field">
              <label htmlFor="backfill-max">Max messages</label>
              <input
                id="backfill-max"
                max={5000}
                min={1}
                onChange={(event) => setMaxMessages(Number(event.target.value))}
                type="number"
                value={maxMessages}
              />
            </div>
          </div>
          <ErrorText>{backfill.error}</ErrorText>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="primary" disabled={backfill.pending} type="submit">
              {backfill.pending ? "Queueing…" : "Start backfill"}
            </button>
            <span className="muted small">
              Only inbox messages in the range are scanned; inference respects the daily
              AI budget.
            </span>
          </div>
        </form>
      </Card>

      <Card
        actions={
          <div className="field">
            <label htmlFor="operation-kind">Operation kind</label>
            <select
              id="operation-kind"
              onChange={(event) => {
                setKind(event.target.value);
                setCursor(null);
                setHistory([]);
              }}
              value={kind}
            >
              {KIND_FILTERS.map((value) => (
                <option key={value || "all"} value={value}>
                  {value ? humanize(value) : "All kinds"}
                </option>
              ))}
            </select>
          </div>
        }
        title="Operations"
      >
        {notice && <p className="muted small">{notice}</p>}
        <ErrorText>{resource.error}</ErrorText>
        {items.length === 0 && !resource.loading && (
          <Empty>No operations match this filter.</Empty>
        )}
        {items.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Kind</th>
                <th>Status</th>
                <th>Created</th>
                <th>Finished</th>
                <th>Progress</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {items.map((operation) => (
                <tr key={operation.id}>
                  <td data-label="Kind">{humanize(operation.kind)}</td>
                  <td data-label="Status">
                    <StateBadge state={operation.status} />
                  </td>
                  <td className="small muted" data-label="Created">
                    {formatDateTime(operation.createdAt)}
                  </td>
                  <td className="small muted" data-label="Finished">
                    {formatDateTime(operation.completedAt)}
                  </td>
                  <td className="small muted" data-label="Progress">
                    {formatProgress(operation.progress)}
                  </td>
                  <td className="small" data-label="Error">
                    {operation.lastError ? (
                      <span className="error-text">
                        {operation.lastError.code}
                        {operation.lastError.message
                          ? `: ${operation.lastError.message}`
                          : ""}
                      </span>
                    ) : (
                      "—"
                    )}
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
        </div>
      </Card>
    </div>
  );
};
