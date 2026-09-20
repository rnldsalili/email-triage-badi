import { useState } from "react";

import { getLabels, migrateLabels, planLabelMigration } from "../api";
import { humanize } from "../format";
import { useAction, useKeyedAction, useResource } from "../hooks";
import { Card, Empty, ErrorText, StateBadge } from "./ui";

export const Labels = ({ mode }: { mode: string | null }) => {
  const resource = useResource(getLabels, { intervalMs: 30_000 });
  const [planOperationId, setPlanOperationId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const plan = useAction(planLabelMigration, () => {
    setNotice(
      "Inventory refresh queued. The plan appears here once the runner completes it."
    );
    resource.refresh();
  });
  const migrate = useKeyedAction(
    (key, planId: string | null) => migrateLabels(planId, key),
    () => {
      setConfirming(false);
      setNotice("Label migration queued.");
      resource.refresh();
    }
  );

  const { data } = resource;
  const mappings = data?.mappings ?? [];
  const conflicts = mappings.filter((mapping) => mapping.migrationState === "conflict");
  const pending = mappings.filter((mapping) => mapping.migrationState !== "ready");

  return (
    <div className="stack">
      {data && data.conflicts.length > 0 && (
        <div className="banner banner-danger">
          {data.conflicts.length} label mapping conflict(s). Resolve the duplicated names
          in Gmail before running the migration.
        </div>
      )}
      {notice && <div className="banner banner-warn">{notice}</div>}

      <Card
        actions={
          <>
            <button
              disabled={plan.pending}
              onClick={async () => {
                await plan.run();
              }}
              type="button"
            >
              Refresh inventory
            </button>
            {confirming ? (
              <span className="confirm-row">
                <button
                  className="danger"
                  disabled={migrate.pending}
                  onClick={async () => {
                    await migrate.run(planOperationId);
                  }}
                  type="button"
                >
                  Confirm migration
                </button>
                <button onClick={() => setConfirming(false)} type="button">
                  Cancel
                </button>
              </span>
            ) : (
              <button
                disabled={migrate.pending || mode !== "apply" || conflicts.length > 0}
                onClick={() => setConfirming(true)}
                type="button"
              >
                Run label migration
              </button>
            )}
          </>
        }
        title="Label setup"
      >
        <p className="muted small">
          {mappings.length === 0
            ? "No inventory has been recorded yet. Refresh the inventory to read the current Gmail labels."
            : `${mappings.length} labels mapped · ${pending.length} needing setup · ${
                conflicts.length
              } conflicts`}
        </p>
        {mode !== "apply" && (
          <p className="muted small">
            Running the migration requires apply mode (currently {humanize(mode)}).
          </p>
        )}
        <div className="row" style={{ marginTop: 10 }}>
          <div className="field">
            <label htmlFor="plan-operation">Plan operation</label>
            <input
              id="plan-operation"
              onChange={(event) => setPlanOperationId(event.target.value || null)}
              placeholder="optional plan operation id"
              value={planOperationId ?? ""}
            />
          </div>
          <span className="muted small">
            Record the migration plan this run is based on. Leave empty to migrate against
            the current Gmail inventory.
          </span>
        </div>
        <ErrorText>{plan.error ?? migrate.error}</ErrorText>
      </Card>

      <Card title="Mappings">
        {resource.error && <ErrorText>{resource.error}</ErrorText>}
        {mappings.length === 0 && !resource.error && <Empty>No mappings recorded.</Empty>}
        {mappings.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Key</th>
                <th>Target name</th>
                <th>Gmail label</th>
                <th>State</th>
                <th>Legacy aliases</th>
              </tr>
            </thead>
            <tbody>
              {mappings.map((mapping) => (
                <tr key={mapping.semanticKey}>
                  <td className="mono small" data-label="Key">
                    {mapping.semanticKey}
                  </td>
                  <td data-label="Target name">{mapping.currentName ?? "—"}</td>
                  <td className="mono small" data-label="Gmail label">
                    {mapping.gmailLabelId ?? "—"}
                  </td>
                  <td data-label="State">
                    <StateBadge state={mapping.migrationState} />
                  </td>
                  <td className="mono small" data-label="Legacy aliases">
                    {mapping.aliasIds.length > 0 ? mapping.aliasIds.join(", ") : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="Approved taxonomy">
        {data && (
          <table>
            <thead>
              <tr>
                <th>Key</th>
                <th>Name</th>
                <th>Kind</th>
              </tr>
            </thead>
            <tbody>
              {data.definitions.map((definition) => (
                <tr key={definition.key}>
                  <td className="mono small" data-label="Key">
                    {definition.key}
                  </td>
                  <td data-label="Name">{definition.name}</td>
                  <td data-label="Kind">{definition.kind}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
};
