import { onShutdown, onStart } from "@netlify/server";
import { boot, handleRequest, stop } from "./lib/app.js";

export const config = {
  path: ["/api/*", "/netlify-ai.md"],
  includedFiles: ["../../knowledge/**"],
};

onStart(async () => {
  await boot();
});

onShutdown(async ({ drained }) => {
  stop();
  await drained;
});

export default handleRequest;
