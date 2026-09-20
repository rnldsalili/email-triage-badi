import { createApp } from "./app";
import { handleScheduled } from "./scheduled";

const app = createApp();

export default {
  fetch: app.fetch,
  scheduled: handleScheduled,
} satisfies ExportedHandler<Env>;
