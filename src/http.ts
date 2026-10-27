import * as http from "http";
import { createHash, timingSafeEqual } from "crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

/**
 * Streamable HTTP transport options
 */
export interface HttpOptions {
  host: string;
  port: number;
  // Path the MCP endpoint is served on
  path: string;
  // When set, every MCP request must send "Authorization: Bearer <token>"
  authToken?: string;
}

/**
 * Load HTTP transport options from YTDLP_MCP_* environment variables
 */
export function loadHttpOptions(env: NodeJS.ProcessEnv = process.env): HttpOptions {
  const port = env.YTDLP_MCP_PORT ? parseInt(env.YTDLP_MCP_PORT, 10) : 3000;
  if (isNaN(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid YTDLP_MCP_PORT: ${env.YTDLP_MCP_PORT}`);
  }

  let mcpPath = env.YTDLP_MCP_PATH || "/mcp";
  if (!mcpPath.startsWith("/")) {
    mcpPath = `/${mcpPath}`;
  }

  return {
    host: env.YTDLP_MCP_HOST || "127.0.0.1",
    port,
    path: mcpPath,
    authToken: env.YTDLP_MCP_AUTH_TOKEN || undefined,
  };
}

/**
 * Compare bearer tokens in constant time. Hashing first gives both sides
 * equal length, which timingSafeEqual requires.
 */
function isAuthorized(header: string | undefined, token: string): boolean {
  const match = header?.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(match[1].trim()), digest(token));
}

function sendJsonRpcError(res: http.ServerResponse, status: number, message: string, headers: http.OutgoingHttpHeaders = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

/**
 * Build the HTTP request handler.
 *
 * The transport runs stateless: each POST gets a fresh McpServer and
 * transport, so any replica can serve any request and no session affinity
 * is needed behind a load balancer.
 */
export function createHttpHandler(createServer: () => McpServer, options: HttpOptions): http.RequestListener {
  return async (req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;

    if (pathname === "/healthz" || pathname === "/readyz") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }

    if (pathname !== options.path) {
      sendJsonRpcError(res, 404, "Not found");
      return;
    }

    if (options.authToken && !isAuthorized(req.headers.authorization, options.authToken)) {
      sendJsonRpcError(res, 401, "Unauthorized", { "WWW-Authenticate": "Bearer" });
      return;
    }

    // Stateless mode has no standalone SSE stream (GET) or session to end (DELETE)
    if (req.method !== "POST") {
      sendJsonRpcError(res, 405, "Method not allowed", { Allow: "POST" });
      return;
    }

    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error("[yt-dlp-mcp] Error handling MCP request:", error);
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, "Internal server error");
      }
    }
  };
}

/**
 * Start the Streamable HTTP server and drain it on SIGTERM/SIGINT.
 */
export async function startHttpServer(createServer: () => McpServer, options: HttpOptions): Promise<http.Server> {
  const httpServer = http.createServer(createHttpHandler(createServer, options));

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port, options.host, () => resolve());
  });

  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  console.error(`[yt-dlp-mcp] Streamable HTTP server listening on http://${options.host}:${port}${options.path}`);
  if (!options.authToken) {
    console.error("[yt-dlp-mcp] YTDLP_MCP_AUTH_TOKEN is not set; the MCP endpoint is unauthenticated");
  }

  const shutdown = (signal: string) => {
    console.error(`[yt-dlp-mcp] ${signal} received, draining connections`);
    httpServer.close(() => process.exit(0));
    httpServer.closeIdleConnections();
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));

  return httpServer;
}
