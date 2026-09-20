import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { App } from "../src/app";
import {
  configFixture,
  detailFixture,
  jsonResponse,
  labelsFixture,
  messageFixture,
  statusFixture,
  stubFetch,
} from "./harness";

const navigateTo = (hash: string) => {
  window.location.hash = hash;
  fireEvent(window, new HashChangeEvent("hashchange"));
};

const baseHandlers = {
  "GET /api/v1/config": () => jsonResponse(configFixture),
  "GET /api/v1/labels": () => jsonResponse(labelsFixture),
  "GET /api/v1/status": () => jsonResponse(statusFixture()),
};

describe("dashboard shell", () => {
  it("asks for the admin token when no session exists", async () => {
    stubFetch({
      ...baseHandlers,
      "GET /api/v1/auth/session": () => jsonResponse({ authenticated: false }),
    });

    render(<App />);

    await expect(screen.findByLabelText("Admin API token")).resolves.toBeDefined();
    expect(screen.queryByText("Overview")).toBeNull();
  });

  it("shows the overview with status figures after login", async () => {
    stubFetch({
      ...baseHandlers,
      "GET /api/v1/auth/session": () => jsonResponse({ authenticated: true }),
      "GET /api/v1/operations": () => jsonResponse({ items: [], nextCursor: null }),
    });

    render(<App />);

    await expect(screen.findByText("Processing mode")).resolves.toBeDefined();
    expect(screen.getAllByText("owner@example.test").length).toBeGreaterThan(0);
    expect(screen.getByText("12/500")).toBeDefined();
    expect(screen.getByText("Queued jobs")).toBeDefined();
  });

  it("surfaces label readiness and pending metadata on the overview", async () => {
    stubFetch({
      ...baseHandlers,
      "GET /api/v1/auth/session": () => jsonResponse({ authenticated: true }),
      "GET /api/v1/operations": () => jsonResponse({ items: [], nextCursor: null }),
    });

    render(<App />);

    await expect(screen.findByText("Missing metadata")).resolves.toBeDefined();
    expect(screen.getByText("Label setup")).toBeDefined();
    expect(screen.getByText("ready")).toBeDefined();
  });
});

describe("message review", () => {
  it("lists messages with subject, sender and uncertain actions", async () => {
    stubFetch({
      ...baseHandlers,
      "GET /api/v1/auth/session": () => jsonResponse({ authenticated: true }),
      "GET /api/v1/messages": () =>
        jsonResponse({ items: [messageFixture()], nextCursor: null }),
    });

    render(<App />);
    navigateTo("#/messages");

    await expect(screen.findByText("Invoice for September")).resolves.toBeDefined();
    expect(screen.getByText(/Sender <sender@example.test>/u)).toBeDefined();
    expect(screen.getByText("urgent: No")).toBeDefined();
    expect(screen.getByText("needs reply: Yes")).toBeDefined();
    expect(screen.getByText("to do: Uncertain")).toBeDefined();
  });

  it("submits only the dimensions the owner changed", async () => {
    const { calls } = stubFetch({
      ...baseHandlers,
      "GET /api/v1/auth/session": () => jsonResponse({ authenticated: true }),
      "GET /api/v1/messages/gm-1": () => jsonResponse(detailFixture()),
      "POST /api/v1/messages/gm-1/corrections": () =>
        jsonResponse({ applicationStatus: "pending_mode", revision: 1 }, 202),
    });

    render(<App />);
    navigateTo("#/messages/gm-1");

    await expect(screen.findByText("Correct classification")).resolves.toBeDefined();
    fireEvent.change(screen.getByLabelText("Topic"), { target: { value: "work" } });
    fireEvent.change(screen.getByLabelText("Needs reply"), {
      target: { value: "false" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save correction" }));

    await waitFor(() => {
      const correction = calls.find(
        (call) => call.method === "POST" && call.path.includes("/corrections")
      );
      expect(correction?.body).toStrictEqual({
        actions: { needs_reply: false },
        topic: "work",
      });
    });
  });

  it("requires apply mode before applying a saved result", async () => {
    stubFetch({
      ...baseHandlers,
      "GET /api/v1/auth/session": () => jsonResponse({ authenticated: true }),
      "GET /api/v1/messages/gm-1": () => jsonResponse(detailFixture()),
      "GET /api/v1/status": () => jsonResponse(statusFixture({ mode: "dry_run" })),
    });

    render(<App />);
    navigateTo("#/messages/gm-1");

    const apply = await screen.findByRole("button", { name: "Apply saved result" });
    expect((apply as HTMLButtonElement).disabled).toBeTruthy();
    expect(screen.getByText(/requires apply mode/u)).toBeDefined();
  });

  it("enables retry only for failed jobs and queues it", async () => {
    const { calls } = stubFetch({
      ...baseHandlers,
      "GET /api/v1/auth/session": () => jsonResponse({ authenticated: true }),
      "GET /api/v1/messages/gm-1": () =>
        jsonResponse(
          detailFixture({
            job: {
              attempts: 3,
              deferredReason: null,
              errorCode: "ai_timeout",
              errorMessage: "ai_timeout",
              id: "job-1",
              kind: "initial",
              nextAttemptAt: null,
              stage: "failed",
              updatedAt: "2026-09-21T07:30:00.000Z",
            },
            processingStatus: "failed",
          })
        ),
      "POST /api/v1/messages/gm-1/retry": () =>
        jsonResponse({ jobId: "job-1", stage: "pending" }, 202),
    });

    render(<App />);
    navigateTo("#/messages/gm-1");

    const retry = await screen.findByRole("button", { name: "Retry job" });
    expect((retry as HTMLButtonElement).disabled).toBeFalsy();
    fireEvent.click(retry);

    await waitFor(() => {
      expect(
        calls.some((call) => call.method === "POST" && call.path.endsWith("/gm-1/retry"))
      ).toBeTruthy();
    });
    await expect(screen.findByText("Retry queued")).resolves.toBeDefined();
  });
});
