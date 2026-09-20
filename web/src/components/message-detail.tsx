import { useEffect, useRef, useState } from "react";

import {
  applyMessage,
  getLabels,
  getMessage,
  refreshMessageMetadata,
  reprocessMessage,
  retryMessage,
  submitCorrection,
} from "../api";
import {
  actionLabel,
  formatDateTime,
  formatRelative,
  gmailLink,
  humanize,
} from "../format";
import { useAction, useKeyedAction, useResource } from "../hooks";
import { navigate } from "../router";
import type { MessageDetail as MessageDetailData } from "../types";
import { Card, Empty, ErrorText, StateBadge } from "./ui";

type TriState = "" | "false" | "true";

interface ActionField {
  key: string;
  label: string;
  setValue: (value: TriState) => void;
  value: TriState;
}

interface CorrectionPayload {
  actions?: Record<string, boolean>;
  note?: string;
  topic?: string | null;
}

const triStateToValue = (value: TriState): boolean | undefined =>
  value === "" ? undefined : value === "true";

const buildCorrectionPayload = (
  topicChoice: string,
  actionFields: ActionField[],
  note: string
): CorrectionPayload => {
  const payload: CorrectionPayload = {};
  const actionValues: Record<string, boolean> = {};
  for (const field of actionFields) {
    const parsed = triStateToValue(field.value);
    if (parsed !== undefined) {
      actionValues[field.key] = parsed;
    }
  }
  if (Object.keys(actionValues).length > 0) {
    payload.actions = actionValues;
  }
  if (topicChoice === "__none__") {
    payload.topic = null;
  } else if (topicChoice !== "") {
    payload.topic = topicChoice;
  }
  if (note.trim().length > 0) {
    payload.note = note.trim();
  }
  return payload;
};

const BackButton = () => (
  <button
    onClick={() => {
      navigate("/messages");
    }}
    type="button"
  >
    Back to messages
  </button>
);

const SummaryCard = ({
  detail,
  error,
}: {
  detail: MessageDetailData;
  error: string | null;
}) => (
  <Card
    actions={
      <>
        <BackButton />
        <a
          className="button-link"
          href={gmailLink(detail.messageId)}
          rel="noreferrer"
          target="_blank"
        >
          Open in Gmail
        </a>
      </>
    }
    title={detail.subject ?? "(no subject)"}
  >
    <dl className="kv">
      <dt>From</dt>
      <dd>{detail.from ?? "—"}</dd>
      <dt>Received</dt>
      <dd>{formatDateTime(detail.receivedAt)}</dd>
      <dt>Message ID</dt>
      <dd className="mono">{detail.messageId}</dd>
      <dt>Processing</dt>
      <dd>
        <StateBadge state={detail.processingStatus} />{" "}
        <StateBadge state={detail.applicationStatus} />
        {detail.needsReview && <StateBadge state="needs review" />}
      </dd>
      <dt>Topic</dt>
      <dd>
        {detail.topic ? <span className="badge">{detail.topic}</span> : "—"}{" "}
        {detail.topicDecisionStatus && (
          <span className="muted small">({humanize(detail.topicDecisionStatus)})</span>
        )}
      </dd>
      <dt>Actions</dt>
      <dd>
        {(["urgent", "needs_reply", "to_do"] as const).map((name) => (
          <div key={name}>
            {name.replaceAll("_", " ")}: {actionLabel(detail.actions[name])}
          </div>
        ))}
      </dd>
      <dt>Review reasons</dt>
      <dd>{detail.reviewReasons.length > 0 ? detail.reviewReasons.join(", ") : "—"}</dd>
      <dt>Model</dt>
      <dd className="mono small">
        {detail.model ?? "—"} · {detail.taxonomyVersion ?? "—"} ·{" "}
        {detail.rubricVersion ?? "—"} · {detail.policyVersion ?? "—"}
      </dd>
      <dt>Metadata</dt>
      <dd>
        <StateBadge state={detail.gmailMetadata.status} />{" "}
        {detail.gmailMetadata.errorCode && (
          <span className="muted small">{detail.gmailMetadata.errorCode}</span>
        )}
      </dd>
    </dl>
    <ErrorText>{error}</ErrorText>
  </Card>
);

const JobDetails = ({ detail }: { detail: MessageDetailData }) => {
  if (!detail.job) {
    return <Empty>No job recorded for this message.</Empty>;
  }
  return (
    <dl className="kv">
      <dt>Job</dt>
      <dd className="mono small">{detail.job.id}</dd>
      <dt>Stage</dt>
      <dd>
        <StateBadge state={detail.job.stage} />{" "}
        <span className="muted small">
          {humanize(detail.job.kind)} · attempt {detail.job.attempts}
        </span>
      </dd>
      <dt>Deferred</dt>
      <dd>{humanize(detail.job.deferredReason)}</dd>
      <dt>Next attempt</dt>
      <dd>{formatRelative(detail.job.nextAttemptAt)}</dd>
      <dt>Last error</dt>
      <dd>{detail.job.errorCode ?? "—"}</dd>
      <dt>Updated</dt>
      <dd>{formatDateTime(detail.job.updatedAt)}</dd>
    </dl>
  );
};

const CorrectionForm = ({
  detail,
  onSaved,
  topics,
  actionFields,
}: {
  actionFields: ActionField[];
  detail: MessageDetailData;
  onSaved: () => void;
  topics: { key: string; name: string }[];
}) => {
  const [topicChoice, setTopicChoice] = useState("");
  const [note, setNote] = useState("");
  const correction = useKeyedAction(
    (key, messageId: string, payload: CorrectionPayload) =>
      submitCorrection(messageId, payload, key),
    () => {
      setTopicChoice("");
      setNote("");
      onSaved();
    }
  );

  const payload = buildCorrectionPayload(topicChoice, actionFields, note);
  const changesDimension = payload.actions !== undefined || "topic" in payload;

  return (
    <Card title="Correct classification">
      <div className="form-grid">
        <div className="field">
          <label htmlFor="correction-topic">Topic</label>
          <select
            id="correction-topic"
            onChange={(event) => setTopicChoice(event.target.value)}
            value={topicChoice}
          >
            <option value="">Leave unchanged</option>
            <option value="__none__">Remove topic labels</option>
            {topics.map((definition) => (
              <option key={definition.key} value={definition.key}>
                {definition.name}
              </option>
            ))}
          </select>
        </div>
        {actionFields.map((field) => (
          <div className="field" key={field.key}>
            <label htmlFor={`correction-${field.key}`}>{field.label}</label>
            <select
              id={`correction-${field.key}`}
              onChange={(event) => field.setValue(event.target.value as TriState)}
              value={field.value}
            >
              <option value="">Leave unchanged</option>
              <option value="true">Yes</option>
              <option value="false">No</option>
            </select>
          </div>
        ))}
      </div>
      <div className="field" style={{ marginTop: 12 }}>
        <label htmlFor="correction-note">Note (owner metadata)</label>
        <textarea
          id="correction-note"
          maxLength={1000}
          onChange={(event) => setNote(event.target.value)}
          value={note}
        />
      </div>
      <ErrorText>{correction.error}</ErrorText>
      <div className="row" style={{ marginTop: 12 }}>
        <button
          className="primary"
          disabled={correction.pending || !changesDimension}
          onClick={async () => {
            await correction.run(detail.messageId, payload);
          }}
          type="button"
        >
          {correction.pending ? "Saving…" : "Save correction"}
        </button>
        <span className="muted small">
          Corrections lock the changed dimensions. In dry-run mode they are stored and
          applied later.
        </span>
      </div>
    </Card>
  );
};

export const MessageDetail = ({
  messageId,
  mode,
}: {
  messageId: string;
  mode: string | null;
}) => {
  const resource = useResource(() => getMessage(messageId), {
    intervalMs: 20_000,
    key: messageId,
  });
  const labels = useResource(getLabels);
  const [notice, setNotice] = useState<string | null>(null);
  const [urgent, setUrgent] = useState<TriState>("");
  const [needsReply, setNeedsReply] = useState<TriState>("");
  const [toDo, setToDo] = useState<TriState>("");
  const detail = resource.data;

  const refreshDetail = () => {
    resource.refresh();
  };

  useEffect(() => {
    setUrgent("");
    setNeedsReply("");
    setToDo("");
    setNotice(null);
  }, [messageId]);

  const retry = useKeyedAction(
    (key, id: string) => retryMessage(id, key),
    () => {
      setNotice("Retry queued");
      refreshDetail();
    }
  );
  const reprocess = useKeyedAction(
    (key, id: string, reason: string) => reprocessMessage(id, reason, key),
    () => {
      setNotice("Reprocessing queued");
      refreshDetail();
    }
  );
  const apply = useKeyedAction(
    (key, id: string, classificationId: string) =>
      applyMessage(id, classificationId, key),
    () => {
      setNotice("Application queued");
      refreshDetail();
    }
  );
  const metadataRefresh = useAction(refreshMessageMetadata, () => {
    setNotice("Metadata refreshed");
    refreshDetail();
  });
  const metadataRequested = useRef<string | null>(null);

  // Fetch headers once when a message is opened without them. Later polls are
  // D1-only, so an open tab cannot hammer Gmail.
  useEffect(() => {
    if (
      !detail ||
      detail.metadataState === "available" ||
      detail.metadataState === "unavailable"
    ) {
      return;
    }
    if (metadataRequested.current === detail.messageId) {
      return;
    }
    metadataRequested.current = detail.messageId;
    metadataRefresh.run(detail.messageId);
  }, [detail, metadataRefresh]);

  if (!detail) {
    return (
      <Card actions={<BackButton />} title="Message">
        <ErrorText>{resource.error}</ErrorText>
        {!resource.error && <Empty>Loading…</Empty>}
      </Card>
    );
  }

  const definitions = labels.data?.definitions ?? [];
  const topics = definitions.filter((definition) => definition.kind === "topic");
  const actionFields: ActionField[] = [
    { key: "urgent", label: "Urgent", setValue: setUrgent, value: urgent },
    {
      key: "needs_reply",
      label: "Needs reply",
      setValue: setNeedsReply,
      value: needsReply,
    },
    { key: "to_do", label: "To do", setValue: setToDo, value: toDo },
  ].filter((field) =>
    definitions.some(
      (definition) => definition.kind === "action" && definition.key === field.key
    )
  );

  const canRetry = detail.job?.stage === "failed" || detail.job?.stage === "retry_wait";
  const canApply =
    mode === "apply" &&
    Boolean(detail.classificationId) &&
    !["applied", "no_change"].includes(detail.applicationStatus);

  return (
    <div className="stack">
      <SummaryCard detail={detail} error={resource.error} />

      <div className="detail-grid">
        <Card
          actions={
            <>
              <button
                disabled={retry.pending || !canRetry}
                onClick={async () => {
                  await retry.run(detail.messageId);
                }}
                type="button"
              >
                Retry job
              </button>
              <button
                disabled={reprocess.pending}
                onClick={async () => {
                  await reprocess.run(detail.messageId, "Dashboard reprocess");
                }}
                type="button"
              >
                Reprocess
              </button>
              <button
                disabled={metadataRefresh.pending}
                onClick={async () => {
                  await metadataRefresh.run(detail.messageId);
                }}
                type="button"
              >
                Refresh metadata
              </button>
              <button
                disabled={apply.pending || !canApply}
                onClick={async () => {
                  if (detail.classificationId) {
                    await apply.run(detail.messageId, detail.classificationId);
                  }
                }}
                type="button"
              >
                Apply saved result
              </button>
            </>
          }
          title="Work"
        >
          {notice && <p className="muted small">{notice}</p>}
          <ErrorText>
            {retry.error ?? reprocess.error ?? apply.error ?? metadataRefresh.error}
          </ErrorText>
          <JobDetails detail={detail} />
          {!canApply && mode !== "apply" && (
            <p className="muted small">
              Applying a saved result requires apply mode (currently {humanize(mode)}).
            </p>
          )}
        </Card>

        <CorrectionForm
          actionFields={actionFields}
          key={detail.messageId}
          detail={detail}
          onSaved={() => {
            setNotice("Correction saved");
            refreshDetail();
          }}
          topics={topics}
        />
      </div>

      <Card title="Correction history">
        {detail.corrections.length === 0 && <Empty>No corrections recorded.</Empty>}
        {detail.corrections.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Revision</th>
                <th>Changed</th>
                <th>Values</th>
                <th>Note</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {detail.corrections.map((entry) => (
                <tr key={entry.id}>
                  <td data-label="Revision">{entry.revision}</td>
                  <td className="small" data-label="Changed">
                    {entry.changedDimensions.join(", ")}
                  </td>
                  <td className="mono small" data-label="Values">
                    {JSON.stringify(entry.replacementValues)}
                  </td>
                  <td className="small muted" data-label="Note">
                    {entry.note ?? "—"}
                  </td>
                  <td className="small muted" data-label="When">
                    {formatDateTime(entry.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
};
