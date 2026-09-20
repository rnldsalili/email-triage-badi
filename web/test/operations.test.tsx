import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { App } from "../src/app";
import {
  configFixture,
  jsonResponse,
  labelsFixture,
  statusFixture,
  stubFetch,
} from "./harness";

const navigateTo = (hash: string) => {
  window.location.hash = hash;
  fireEvent(window, new HashChangeEvent("hashchange"));
};

const baseHandlers = {
  "GET /api/v1/auth/session": () => jsonResponse({ authenticated: true }),
  "GET /api/v1/config": () => jsonResponse(configFixture),
  "GET /api/v1/labels": () => jsonResponse(labelsFixture),
  "GET /api/v1/status": () => jsonResponse(statusFixture()),
};

describe("activity view", () => {
  it("queues a bounded backfill with an increasing date range", async () => {
    const { calls } = stubFetch({
      ...baseHandlers,
      "GET /api/v1/operations": () =>
        jsonResponse({
          items: [
            {
              completedAt: "2026-09-21T08:00:00.000Z",
              createdAt: "2026-09-21T07:59:00.000Z",
              id: "op-1",
              kind: "backfill",
              lastError: null,
              progress: { discovered: 12, scanned: 40 },
              request: { maxMessages: 200 },
              startedAt: "2026-09-21T07:59:00.000Z",
              status: "completed",
            },
          ],
          nextCursor: null,
        }),
      "POST /api/v1/backfills": () => jsonResponse({ operationId: "op-2" }, 202),
    });

    render(<App />);
    navigateTo("#/activity");

    await expect(screen.findByText("Scan older inbox mail")).resolves.toBeDefined();
    expect(screen.getByText("discovered: 12, scanned: 40")).toBeDefined();

    fireEvent.change(screen.getByLabelText("Received after"), {
      target: { value: "2026-08-01" },
    });
    fireEvent.change(screen.getByLabelText("Received before"), {
      target: { value: "2026-08-31" },
    });
    fireEvent.change(screen.getByLabelText("Max messages"), { target: { value: "50" } });
    fireEvent.click(screen.getByRole("button", { name: "Start backfill" }));

    await waitFor(() => {
      const backfill = calls.find(
        (call) => call.method === "POST" && call.path === "/api/v1/backfills"
      );
      expect(backfill?.body).toStrictEqual({
        maxMessages: 50,
        receivedAfter: "2026-08-01T00:00:00.000Z",
        receivedBefore: "2026-08-31T00:00:00.000Z",
      });
    });
  });
});

describe("labels view", () => {
  it("blocks migration until apply mode and surfaces conflicts", async () => {
    stubFetch({
      ...baseHandlers,
      "GET /api/v1/labels": () =>
        jsonResponse({
          ...labelsFixture,
          conflicts: ["work"],
          mappings: [
            ...labelsFixture.mappings,
            {
              aliasIds: ["Label_legacy"],
              currentName: "Work",
              gmailLabelId: "Label_2",
              migrationState: "conflict",
              semanticKey: "work",
            },
          ],
        }),
      "GET /api/v1/status": () =>
        jsonResponse(
          statusFixture({
            labels: { conflicts: 1, mapped: 14, migration: "not_ready" },
            mode: "dry_run",
          })
        ),
    });

    render(<App />);
    navigateTo("#/labels");

    await expect(screen.findByText(/label mapping conflict/u)).resolves.toBeDefined();
    const migrate = screen.getByRole("button", { name: "Run label migration" });
    expect((migrate as HTMLButtonElement).disabled).toBeTruthy();
  });

  it("confirms the migration and passes the plan operation id", async () => {
    const { calls } = stubFetch({
      ...baseHandlers,
      "GET /api/v1/status": () =>
        jsonResponse(
          statusFixture({
            labels: { conflicts: 0, mapped: 15, migration: "ready" },
            mode: "apply",
          })
        ),
      "POST /api/v1/labels/migrate": () =>
        jsonResponse({ operationId: "migrate-1", planOperationId: "plan-1" }, 202),
      "POST /api/v1/labels/migration-plan": () =>
        jsonResponse({ coalesced: false, operationId: "plan-1" }, 202),
    });

    render(<App />);
    navigateTo("#/labels");

    fireEvent.change(await screen.findByLabelText("Plan operation"), {
      target: { value: "plan-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Run label migration" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm migration" }));

    await waitFor(() => {
      const migrate = calls.find(
        (call) => call.method === "POST" && call.path === "/api/v1/labels/migrate"
      );
      expect(migrate?.body).toStrictEqual({ planOperationId: "plan-1" });
    });
  });
});
