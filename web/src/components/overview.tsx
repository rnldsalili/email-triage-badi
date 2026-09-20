import { useState } from "react";

import {
  listMessages,
  listOperations,
  refreshMetadata,
  requestSync,
  runNow,
  setMode,
} from "../api";
import { formatProgress, formatRelative, humanize, truncate } from "../format";
import { useAction, useResource } from "../hooks";
import type { Resource } from "../hooks";
import { navigate } from "../router";
import type { MessageListItem, Mode, StatusResponse } from "../types";
import { Card, Empty, ErrorText, StateBadge, Stat } from "./ui";

const MODE_LABELS: Record<Mode, string> = {
  apply: "Apply labels",
  dry_run: "Dry run",
  paused: "Paused",
};

const MODE_HINTS: Record<Mode, string> = {
  apply: "Classify and write labels in Gmail",
  dry_run: "Classify and store results without touching Gmail",
  paused: "Stop starting new work; queued work waits",
};

const metadataHint = (status: StatusResponse): string => {
  if (status.messages.metadataErrors > 0) {
    return `${status.messages.metadataErrors} failed; retry from Run work`;
  }
  if (status.messages.missingMetadata > 0) {
    return "subjects not fetched yet";
  }
  return "all fetched";
};

const budgetTone = (percent: number): "danger" | "ok" | "warn" => {
  if (percent >= 90) {
    return "danger";
  }
  if (percent >= 70) {
    return "warn";
  }
  return "ok";
};

const ReviewEntry = ({ item }: { item: MessageListItem }) => (
  <article className="review-entry">
    <div className="review-entry-main">
      <div className="review-entry-heading">
        <a
          className="review-subject"
          href={`#/messages/${encodeURIComponent(item.messageId)}`}
        >
          {truncate(item.subject ?? "(no subject)", 92)}
        </a>
        <span className="review-time muted small">{formatRelative(item.receivedAt)}</span>
      </div>
      <p className="review-from">
        {truncate(item.from ?? "Sender unavailable", 72)}
        {item.topic && <span className="review-topic">{item.topic}</span>}
      </p>
      <div className="review-reasons">
        <span className="badge badge-warn">Needs review</span>
        {item.reviewReasons.length > 0 ? (
          item.reviewReasons.map((reason) => (
            <span className="reason" key={reason}>
              {humanize(reason)}
            </span>
          ))
        ) : (
          <span className="reason">Classification needs a second look</span>
        )}
      </div>
    </div>
    <button
      className="review-action"
      onClick={() => navigate(`/messages/${encodeURIComponent(item.messageId)}`)}
      type="button"
    >
      Review
    </button>
  </article>
);

const ReviewQueue = () => {
  const resource = useResource(() => listMessages({ limit: 5, needsReview: true }), {
    intervalMs: 20_000,
  });
  const items = resource.data?.items ?? [];

  return (
    <Card
      className="review-ledger"
      actions={
        <button
          className="button-text"
          onClick={() => navigate("/messages")}
          type="button"
        >
          Open message index
        </button>
      }
      title="Needs your review"
    >
      <div className="ledger-intro">
        <p>
          These classifications are uncertain. Verify the evidence before Badi writes a
          label to Gmail.
        </p>
        {resource.data && (
          <strong>
            {resource.data.items.length === 0
              ? "Clear for now"
              : `${resource.data.items.length} message${
                  resource.data.items.length === 1 ? "" : "s"
                } in this view`}
          </strong>
        )}
      </div>
      {resource.error && (
        <ErrorText>Review queue unavailable: {resource.error}</ErrorText>
      )}
      {resource.loading && items.length === 0 && (
        <div className="review-loading" role="status">
          Reading the latest review entries…
        </div>
      )}
      {!resource.loading && !resource.error && items.length === 0 && (
        <Empty>No messages are waiting for review.</Empty>
      )}
      {items.length > 0 && (
        <div className="review-list">
          {items.map((item) => (
            <ReviewEntry item={item} key={item.messageId} />
          ))}
        </div>
      )}
    </Card>
  );
};

const ModeCard = ({
  onChanged,
  status,
}: {
  onChanged: () => void;
  status: StatusResponse;
}) => {
  const [confirmApply, setConfirmApply] = useState(false);
  const modeAction = useAction(setMode, onChanged);

  return (
    <Card
      actions={
        <>
          {(Object.keys(MODE_LABELS) as Mode[]).map((mode) => (
            <button
              className={status.mode === mode ? "primary" : ""}
              disabled={modeAction.pending || status.mode === mode}
              key={mode}
              onClick={async () => {
                if (mode !== "apply") {
                  setConfirmApply(false);
                }
                if (mode === "apply" && !confirmApply) {
                  setConfirmApply(true);
                  return;
                }
                await modeAction.run(mode);
              }}
              type="button"
            >
              {confirmApply && mode === "apply"
                ? "Confirm apply mode"
                : MODE_LABELS[mode]}
            </button>
          ))}
        </>
      }
      title="Processing mode"
    >
      <p className="muted small">{MODE_HINTS[status.mode]}</p>
      <ErrorText>{modeAction.error}</ErrorText>
    </Card>
  );
};

const StatsGrid = ({ status }: { status: StatusResponse }) => {
  const budgetPercent =
    status.aiBudget.limit > 0
      ? Math.min(100, Math.round((status.aiBudget.used / status.aiBudget.limit) * 100))
      : 0;

  return (
    <div className="grid">
      <Card className="stat-card">
        <Stat
          hint={status.mailbox?.email ?? "not connected"}
          label="Mailbox"
          tone={status.mailbox?.authStatus === "ok" ? "ok" : "danger"}
          value={humanize(status.mailbox?.authStatus ?? "unknown")}
        />
      </Card>
      <Card className="stat-card">
        <Stat
          hint={`phase ${humanize(status.mailbox?.syncPhase)}`}
          label="Last discovery"
          value={formatRelative(status.mailbox?.lastSyncAt ?? null)}
        />
      </Card>
      <Card className="stat-card">
        <Stat
          hint={`${status.jobs.due} due now`}
          label="Queued jobs"
          value={status.jobs.queued}
        />
      </Card>
      <Card className="stat-card">
        <Stat
          hint={
            status.jobs.deferredByBudget > 0
              ? `${status.jobs.deferredByBudget} budget-deferred`
              : "none deferred"
          }
          label="Failed jobs"
          tone={status.jobs.failed > 0 ? "danger" : "ok"}
          value={status.jobs.failed}
        />
      </Card>
      <Card className="stat-card">
        <Stat
          hint={`resets ${formatRelative(status.aiBudget.resetsAt)}`}
          label="AI calls today"
          tone={budgetTone(budgetPercent)}
          value={`${status.aiBudget.used}/${status.aiBudget.limit}`}
        />
      </Card>
      <Card className="stat-card">
        <Stat
          hint={`${status.labels.mapped} mapped · ${status.labels.conflicts} conflicts`}
          label="Label setup"
          tone={status.labels.migration === "ready" ? "ok" : "warn"}
          value={humanize(status.labels.migration)}
        />
      </Card>
      <Card className="stat-card">
        <Stat
          hint={metadataHint(status)}
          label="Missing metadata"
          tone={
            status.messages.missingMetadata > 0 || status.messages.metadataErrors > 0
              ? "warn"
              : "ok"
          }
          value={status.messages.missingMetadata}
        />
      </Card>
      <Card className="stat-card">
        <Stat
          hint={`${status.versions.model} · ${status.versions.taxonomy} · ${status.versions.rubric}`}
          label="Build"
          value={<span className="mono small">{status.versions.build}</span>}
        />
      </Card>
    </div>
  );
};

const tickNotice = (status: string): string => {
  if (status === "completed") {
    return "Tick completed. Refresh to see the latest results.";
  }
  if (status === "lease_held") {
    return "Another run is already in progress; nothing was started.";
  }
  if (status === "paused") {
    return "Processing is paused, so no work was started.";
  }
  if (status === "auth_required" || status === "identity_mismatch") {
    return "Gmail authorization is failing; re-authorize before running work.";
  }
  if (status === "error") {
    return "The tick failed. Check Activity and the Worker logs for details.";
  }
  return `Tick finished with status: ${status}`;
};

const RunCard = ({ status }: { status: StatusResponse }) => {
  const [notice, setNotice] = useState<string | null>(null);
  const runAction = useAction(async () => {
    const result = await runNow();
    setNotice(tickNotice(result.status));
    return result;
  });
  const syncAction = useAction(requestSync, () => {
    setNotice("Discovery queued");
  });
  const metadataAction = useAction(refreshMetadata, () => {
    setNotice("Metadata refresh queued");
  });

  return (
    <Card
      actions={
        <>
          <button
            className="primary"
            disabled={runAction.pending}
            onClick={async () => {
              await runAction.run();
            }}
            type="button"
          >
            {runAction.pending ? "Running…" : "Process now"}
          </button>
          <button
            disabled={syncAction.pending}
            onClick={async () => {
              await syncAction.run();
            }}
            type="button"
          >
            Sync now
          </button>
          <button
            disabled={
              metadataAction.pending ||
              (status.messages.missingMetadata === 0 &&
                status.messages.metadataErrors === 0)
            }
            onClick={async () => {
              await metadataAction.run();
            }}
            type="button"
          >
            {status.messages.metadataErrors > 0
              ? "Fetch missing subjects (retry failures)"
              : "Fetch missing subjects"}
          </button>
          <button
            onClick={() => {
              navigate("/activity");
            }}
            type="button"
          >
            All activity
          </button>
        </>
      }
      title="Run work"
    >
      <p className="muted small">
        Work is processed automatically by the scheduled runner every five minutes.
        &ldquo;Process now&rdquo; starts a bounded run immediately.
      </p>
      {notice && <p className="muted small">{notice}</p>}
      <ErrorText>{runAction.error ?? syncAction.error ?? metadataAction.error}</ErrorText>
    </Card>
  );
};

const RecentActivity = () => {
  const operations = useResource(() => listOperations({ limit: 5 }), {
    intervalMs: 15_000,
  });
  const items = operations.data?.items ?? [];

  return (
    <Card title="Recent activity">
      {operations.error && <ErrorText>{operations.error}</ErrorText>}
      {!operations.error && items.length === 0 && (
        <Empty>No operations recorded yet.</Empty>
      )}
      {items.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Kind</th>
              <th>Status</th>
              <th>Created</th>
              <th>Progress</th>
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
                  {formatRelative(operation.createdAt)}
                </td>
                <td className="small muted" data-label="Progress">
                  {operation.lastError
                    ? operation.lastError.code
                    : formatProgress(operation.progress)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
};

export const Overview = ({ status }: { status: Resource<StatusResponse> }) => {
  const { data } = status;

  if (!data) {
    return (
      <Card title="Overview">
        <ErrorText>{status.error}</ErrorText>
        {!status.error && <Empty>Loading…</Empty>}
      </Card>
    );
  }

  return (
    <div className="stack">
      {data.mailbox?.authStatus === "auth_required" && (
        <div className="banner banner-danger">
          Gmail authorization is failing. Re-run{" "}
          <span className="mono">bun run oauth:bootstrap</span> locally, update the
          refresh-token secret, then deploy.
        </div>
      )}
      {data.lastError && (
        <div className="banner banner-warn">
          Last sync error: {data.lastError.code} at {formatRelative(data.lastError.at)}
        </div>
      )}

      <ReviewQueue />
      <div className="overview-support">
        <ModeCard
          onChanged={() => {
            status.refresh();
          }}
          status={data}
        />
        <RunCard status={data} />
      </div>
      <StatsGrid status={data} />
      <RecentActivity />
    </div>
  );
};
