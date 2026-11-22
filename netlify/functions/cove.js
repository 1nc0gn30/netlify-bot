/**
 * Buffered function gateway for Cove's HTTP API.
 *
 * `netlify dev --live` tunnels Server responses as HTTP/1.1 chunked with a
 * hop-by-hop `Keep-Alive` header. The public *.netlify.live edge speaks
 * HTTP/2, which forbids that header, so browsers and curl --http2 get a 200
 * with an empty body. Functions are matched before Netlify Server and keep
 * Content-Length, which the live tunnel can forward safely.
 *
 * Long-running answers still work in `netlify dev` because local function
 * timeouts are not enforced the same way as production. A production deploy
 * should use Netlify Server (or a hosted provider) for long chat calls.
 */
import { handleRequest } from "../server/lib/app.js";
import { bufferResponse } from "../server/lib/guards.js";

export const config = {
  path: ["/api/*", "/netlify-ai.md"],
};

export default async (req) => {
  const response = await handleRequest(req);
  const type = response.headers.get("content-type") || "";
  if (type.includes("text/event-stream")) {
    return response;
  }
  const buf = Buffer.from(await response.arrayBuffer());
  const headers = {};
  for (const [name, value] of response.headers) {
    const lower = name.toLowerCase();
    if (lower === "connection" || lower === "keep-alive" || lower === "transfer-encoding") continue;
    headers[name] = value;
  }
  return bufferResponse(buf, response.status, headers);
};
