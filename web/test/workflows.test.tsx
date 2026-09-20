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
  "GET /api/v1/auth/session": () => jsonResponse({ authenticated: true }),
  "GET /api/v1/config": () => jsonResponse(configFixture),
  "GET /api/v1/labels": () => jsonResponse(labelsFixture),
  "GET /api/v1/status": () => jsonResponse(statusFixture()),
};

describe("session handling", () => {
  it("returns to the login form when a request is rejected as unauthenticated", async () => {
    let authenticated = true;
    stubFetch({
      ...baseHandlers,
      "GET /api/v1/auth/session": () => jsonResponse({ authenticated }),
      "GET /api/v1/operations": () => jsonResponse({ items: [], nextCursor: null }),
      "GET /api/v1/status": () =>
        authenticated
          ? jsonResponse(statusFixture())
          : jsonResponse(
              {
                error: {
                  code: "UNAUTHORIZED",
                  message: "Missing or invalid credentials",
                },
              },
              401
            ),
    });

    render(<App />);
    await expect(screen.findByText("Processing mode")).resolves.toBeDefined();

    authenticated = false;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await expect(screen.findByLabelText("Admin API token")).resolves.toBeDefined();
  });

  it("keeps the dashboard usable when the hash is malformed", async () => {
    stubFetch({
      ...baseHandlers,
      "GET /api/v1/messages": () =>
        jsonResponse({ items: [messageFixture()], nextCursor: null }),
    });

    render(<App />);
    navigateTo("#/messages/%E0%A4%A");

    // The malformed id is passed through rather than crashing the renderer.
    await expect(screen.findByText("Back to messages")).resolves.toBeDefined();
    expect(window.location.hash).toBe("#/messages/%E0%A4%A");
  });
});

describe("message paging", () => {
  it("walks forward and back through cursors", async () => {
    const requests: string[] = [];
    stubFetch({
      ...baseHandlers,
      "GET /api/v1/messages": () => {
        const cursor = requests.at(-1) ?? "";
        return jsonResponse(
          cursor.includes("cursor=page-2")
            ? {
                items: [messageFixture({ messageId: "gm-2", subject: "Second page" })],
                nextCursor: null,
              }
            : {
                items: [messageFixture({ subject: "First page" })],
                nextCursor: "page-2",
              }
        );
      },
    });

    const originalFetch = globalThis.fetch;
    const spy = originalFetch as unknown as (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => Promise<Response>;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      requests.push(url);
      return spy(input, init);
    }) as typeof fetch;

    render(<App />);
    navigateTo("#/messages");

    await expect(screen.findByText("First page")).resolves.toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await expect(screen.findByText("Second page")).resolves.toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    await expect(screen.findByText("First page")).resolves.toBeDefined();
    expect(requests.some((url) => url.includes("cursor=page-2"))).toBeTruthy();
  });
});

describe("corrections", () => {
  it("sends topic removal as an explicit null", async () => {
    const { calls } = stubFetch({
      ...baseHandlers,
      "GET /api/v1/messages/gm-1": () => jsonResponse(detailFixture()),
      "POST /api/v1/messages/gm-1/corrections": () =>
        jsonResponse({ applicationStatus: "pending_mode", revision: 1 }, 202),
    });

    render(<App />);
    navigateTo("#/messages/gm-1");

    fireEvent.change(await screen.findByLabelText("Topic"), {
      target: { value: "__none__" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save correction" }));

    await waitFor(() => {
      const correction = calls.find(
        (call) => call.method === "POST" && call.path.includes("/corrections")
      );
      expect(correction?.body).toStrictEqual({ topic: null });
    });
  });

  it("disables saving when only a note is provided", async () => {
    stubFetch({
      ...baseHandlers,
      "GET /api/v1/messages/gm-1": () => jsonResponse(detailFixture()),
    });

    render(<App />);
    navigateTo("#/messages/gm-1");

    fireEvent.change(await screen.findByLabelText("Note (owner metadata)"), {
      target: { value: "context only" },
    });

    const save = screen.getByRole("button", { name: "Save correction" });
    expect((save as HTMLButtonElement).disabled).toBeTruthy();
  });

  it("resets the correction form when another message is opened", async () => {
    stubFetch({
      ...baseHandlers,
      "GET /api/v1/messages/gm-1": () => jsonResponse(detailFixture()),
      "GET /api/v1/messages/gm-2": () =>
        jsonResponse(detailFixture({ messageId: "gm-2", subject: "Another message" })),
    });

    render(<App />);
    navigateTo("#/messages/gm-1");
    fireEvent.change(await screen.findByLabelText("Topic"), {
      target: { value: "work" },
    });
    fireEvent.change(screen.getByLabelText("Note (owner metadata)"), {
      target: { value: "typed for gm-1" },
    });

    navigateTo("#/messages/gm-2");
    await expect(screen.findByText("Another message")).resolves.toBeDefined();

    expect((screen.getByLabelText("Topic") as HTMLSelectElement).value).toBe("");
    expect(
      (screen.getByLabelText("Note (owner metadata)") as HTMLTextAreaElement).value
    ).toBe("");
  });
});

describe("request hygiene", () => {
  it("sends the dashboard header and reuses the idempotency key on retry", async () => {
    const calls: { headers: Headers; method: string; path: string }[] = [];
    stubFetch({
      ...baseHandlers,
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
          })
        ),
      "POST /api/v1/messages/gm-1/retry": () =>
        jsonResponse(
          { error: { code: "DEPENDENCY_UNAVAILABLE", message: "Gmail is unavailable" } },
          503
        ),
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({
        headers: new Headers(init.headers),
        method: init.method ?? "GET",
        path: new URL(url, "http://localhost").pathname,
      });
      return originalFetch(input, init);
    }) as typeof fetch;

    render(<App />);
    navigateTo("#/messages/gm-1");

    const retry = await screen.findByRole("button", { name: "Retry job" });
    fireEvent.click(retry);
    await waitFor(() => {
      expect(calls.filter((call) => call.path.endsWith("/retry"))).toHaveLength(1);
    });
    fireEvent.click(retry);
    await waitFor(() => {
      expect(calls.filter((call) => call.path.endsWith("/retry"))).toHaveLength(2);
    });

    const retries = calls.filter((call) => call.path.endsWith("/retry"));
    expect(
      retries.every((call) => call.headers.get("x-etb-csrf") === "dashboard")
    ).toBeTruthy();
    expect(retries[0]?.headers.get("idempotency-key")).toBeTruthy();
    expect(retries[0]?.headers.get("idempotency-key")).toBe(
      retries[1]?.headers.get("idempotency-key")
    );
  });

  it("keeps retry disabled for a completed job", async () => {
    stubFetch({
      ...baseHandlers,
      "GET /api/v1/messages/gm-1": () => jsonResponse(detailFixture()),
    });

    render(<App />);
    navigateTo("#/messages/gm-1");

    const retry = await screen.findByRole("button", { name: "Retry job" });
    expect((retry as HTMLButtonElement).disabled).toBeTruthy();
  });
});

describe("metadata recovery", () => {
  it("offers to retry failed subjects and sends the re-arm flag", async () => {
    const { calls } = stubFetch({
      ...baseHandlers,
      "GET /api/v1/operations": () => jsonResponse({ items: [], nextCursor: null }),
      "GET /api/v1/status": () =>
        jsonResponse(
          statusFixture({
            messages: { metadataErrors: 3, missingMetadata: 0 },
          })
        ),
      "POST /api/v1/messages/metadata-refresh": () =>
        jsonResponse(
          { coalesced: false, errors: 0, operationId: "op-1", pending: 3 },
          202
        ),
    });

    render(<App />);

    const button = await screen.findByRole("button", {
      name: "Fetch missing subjects (retry failures)",
    });
    expect((button as HTMLButtonElement).disabled).toBeFalsy();
    fireEvent.click(button);

    await waitFor(() => {
      const refresh = calls.find(
        (call) =>
          call.method === "POST" && call.path === "/api/v1/messages/metadata-refresh"
      );
      expect(refresh?.body).toStrictEqual({ retryErrors: true });
    });
  });

  it("disables the metadata button when nothing is pending", async () => {
    stubFetch({
      ...baseHandlers,
      "GET /api/v1/operations": () => jsonResponse({ items: [], nextCursor: null }),
      "GET /api/v1/status": () =>
        jsonResponse(
          statusFixture({ messages: { metadataErrors: 0, missingMetadata: 0 } })
        ),
    });

    render(<App />);

    const button = await screen.findByRole("button", { name: "Fetch missing subjects" });
    expect((button as HTMLButtonElement).disabled).toBeTruthy();
  });
});

describe("manual tick", () => {
  it("reports when another run already holds the lease", async () => {
    stubFetch({
      ...baseHandlers,
      "GET /api/v1/operations": () => jsonResponse({ items: [], nextCursor: null }),
      "POST /api/v1/run": () =>
        jsonResponse(
          { durationMs: 12, mode: "dry_run", status: "lease_held", triggered: true },
          202
        ),
    });

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Process now" }));

    await expect(
      screen.findByText("Another run is already in progress; nothing was started.")
    ).resolves.toBeDefined();
  });
});

describe("detail metadata", () => {
  it("fetches headers once when a message is opened without them", async () => {
    const { calls } = stubFetch({
      ...baseHandlers,
      "GET /api/v1/messages/gm-1": () =>
        jsonResponse(
          detailFixture({ from: null, metadataState: "missing", subject: null })
        ),
      "POST /api/v1/messages/gm-1/metadata": () =>
        jsonResponse(
          {
            errorCode: null,
            fetchedAt: "2026-09-21T08:00:00.000Z",
            from: "Sender <sender@example.test>",
            status: "available",
            subject: "Fetched subject",
          },
          200
        ),
    });

    render(<App />);
    navigateTo("#/messages/gm-1");

    await waitFor(() => {
      expect(
        calls.filter(
          (call) => call.method === "POST" && call.path.endsWith("/gm-1/metadata")
        )
      ).toHaveLength(1);
    });
  });

  it("does not fetch when stored headers already exist", async () => {
    const { calls } = stubFetch({
      ...baseHandlers,
      "GET /api/v1/messages/gm-1": () => jsonResponse(detailFixture()),
    });

    render(<App />);
    navigateTo("#/messages/gm-1");

    await expect(screen.findByText("Correct classification")).resolves.toBeDefined();
    expect(calls.filter((call) => call.path.endsWith("/gm-1/metadata"))).toStrictEqual(
      []
    );
  });
});
