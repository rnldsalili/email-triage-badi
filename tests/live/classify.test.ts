import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import messageFull from "../../fixtures/gmail/message-full.json";
import { classifyMessage } from "../../src/classifier/jev";
import { normalizeMessage } from "../../src/email/normalize";
import type { GmailMessage } from "../../src/gmail/types";
import { testConfig } from "../helpers/config";

describe("live Jev classification", () => {
  it("classifies the synthetic invoice with one four-question call", async () => {
    const normalized = await normalizeMessage(messageFull as unknown as GmailMessage, {
      maxBodyCharacters: 12_000,
    });
    const started = Date.now();
    const outcome = await classifyMessage(env.AI, normalized, testConfig(), Date.now(), {
      gatewayId: "email-triage-badi-dev",
    });

    console.log(
      JSON.stringify({
        durationMs: outcome.durationMs,
        event: "live_classification",
        model: outcome.modelVersion,
        needsReply: outcome.decisions.needsReply,
        toDo: outcome.decisions.toDo,
        topic: outcome.decisions.topic,
        urgent: outcome.decisions.urgent,
        usage: outcome.usage,
        wallMs: Date.now() - started,
      })
    );

    expect(outcome.modelVersion).toMatch(/^jev-/u);
    expect(outcome.decisions.topic.status).toBe("accepted");
    expect(outcome.usage.input_tokens).toBeGreaterThan(0);
  });
});
