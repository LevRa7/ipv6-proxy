#!/usr/bin/env node
/**
 * IPv6 Rotating Forward Proxy for Zen API + GODMODE injection.
 *
 * Runs on racknerd-5a24bf9 (VPS with /64 IPv6 range).
 * Binds each outgoing connection to a different source IPv6.
 * On HTTP 429, rotates to next IPv6 and retries.
 *
 * GODMODE: when enabled, injects jailbreak system prompt and prefill messages
 * into the request body before forwarding to the upstream API.
 *
 * Usage:
 *   npx tsx ipv6-rotating-proxy.ts [port] [target-url]
 *
 * Environment:
 *   PROXY_PORT           — listen port (default 8317)
 *   PROXY_TARGET         — upstream API URL (default https://opencode.ai/zen/v1)
 *   PROXY_POOL_SIZE      — number of IPv6 addresses (default 256)
 *   PROXY_COOLDOWN_MS    — rate-limit cooldown ms (default 60000)
 *   PROXY_API_KEY        — X-Api-Key for auth (empty = no auth)
 *   GODMODE_ENABLED      — enable godmode injection (default false)
 *   GODMODE_SYSTEM_PROMPT— jailbreak system prompt
 *   GODMODE_PREFILL_FILE — path to JSON array of prefill messages
 *
 * Endpoints:
 *   /health           — pool status
 *   /godmode          — godmode status + config (GET/POST)
 */

import http from "node:http";
import https from "node:https";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Ipv6Pool } from "./ipv6-pool.js";

const PORT = parseInt(process.env.PROXY_PORT || process.argv[2] || "8317", 10);
const TARGET = process.env.PROXY_TARGET || process.argv[3] || "https://opencode.ai/zen/v1";
const POOL_SIZE = parseInt(process.env.PROXY_POOL_SIZE || "256", 10);
const COOLDOWN_MS = parseInt(process.env.PROXY_COOLDOWN_MS || "60000", 10);
const MAX_RETRIES = 20;
const API_KEY = process.env.PROXY_API_KEY || "";
const ALLOWED_MODELS = process.env.ALLOWED_MODELS ? process.env.ALLOWED_MODELS.split(",") : ["big-pickle","deepseek-v4-flash-free","mimo-v2.5-free","nemotron-3-ultra-free","north-mini-code-free"];
const REQUIRE_API_KEY = API_KEY.length > 0;
const GODMODE_CONFIG_PATH = process.env.GODMODE_CONFIG_PATH || "/opt/ipv6-proxy/godmode.json";

const pool = new Ipv6Pool({ poolSize: POOL_SIZE, cooldownMs: COOLDOWN_MS, startSeq: 0 });

interface PrefillMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

interface GodmodeConfig {
  enabled: boolean;
  systemPrompt?: string;
  prefillMessages?: PrefillMessage[];
  prefillMessagesFile?: string;
}

const DEFAULT_GODMODE: GodmodeConfig = {
  enabled: process.env.GODMODE_ENABLED === "true",
  systemPrompt: process.env.GODMODE_SYSTEM_PROMPT || undefined,
  prefillMessagesFile: process.env.GODMODE_PREFILL_FILE || undefined,
};

function log(msg: string): void {
  const ts = new Date().toISOString();
  process.stderr.write(`[${ts}] [ipv6-proxy] ${msg}\n`);
}

// ── Godmode config persistence ──

function loadGodmodeConfig(): GodmodeConfig {
  try {
    if (!existsSync(GODMODE_CONFIG_PATH)) return { ...DEFAULT_GODMODE };
    const raw = readFileSync(GODMODE_CONFIG_PATH, "utf-8");
    return { ...DEFAULT_GODMODE, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_GODMODE };
  }
}

function saveGodmodeConfig(config: GodmodeConfig): void {
  const dir = dirname(GODMODE_CONFIG_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(GODMODE_CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

function loadPrefillMessages(filePath: string): PrefillMessage[] {
  try {
    if (!existsSync(filePath)) return [];
    const raw = readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data.filter(
      (m: unknown) => m && typeof m === "object" && (m as PrefillMessage).role && (m as PrefillMessage).content,
    ) as PrefillMessage[];
  } catch {
    return [];
  }
}

// ── GODMODE body injection ──

function applyGodmode(body: Buffer | null, config: GodmodeConfig): Buffer | null {
  if (!config.enabled) return body;
  if (!config.systemPrompt && !config.prefillMessages?.length && !config.prefillMessagesFile) return body;
  if (!body || body.length === 0) return body;

  try {
    const parsed = JSON.parse(body.toString());
    if (!parsed.messages || !Array.isArray(parsed.messages)) return body;

    const messages: Array<{ role: string; content: string }> = parsed.messages;

    // Prepend prefill messages (before the conversation)
    const prefills = config.prefillMessages?.length
      ? config.prefillMessages
      : config.prefillMessagesFile
        ? loadPrefillMessages(config.prefillMessagesFile)
        : [];

    const prefillEntries = prefills.map((pm) => ({
      role: pm.role,
      content: pm.content,
    }));

    // Inject system prompt as a system message at the front
    const injected: Array<{ role: string; content: string }> = [];
    if (config.systemPrompt?.trim()) {
      injected.push({ role: "system", content: config.systemPrompt.trim() });
    }
    injected.push(...prefillEntries);
    injected.push(...messages);

    parsed.messages = injected;
    return Buffer.from(JSON.stringify(parsed));
  } catch {
    return body;
  }
}

// ── Routing ──

function resolveTargetUrl(
  incomingUrl: string | undefined,
  rawHeaders: http.IncomingHttpHeaders,
  defaultTarget: string,
): string {
  const proxyTarget = rawHeaders["x-proxy-target"];
  if (typeof proxyTarget === "string" && proxyTarget.trim()) {
    return proxyTarget.trim();
  }

  const path = incomingUrl ?? "";
  const targetHasV1 = defaultTarget.endsWith("/v1") || defaultTarget.endsWith("/v1/");
  const cleanPath = targetHasV1 && path.startsWith("/v1") ? path.slice(3) : path;
  const base = defaultTarget.replace(/\/+$/, "");
  return `${base}${cleanPath || ""}`;
}

// ── Agent pool + sticky IPv6 ──
const agentPool = new Map<string, https.Agent>();
const MAX_SOCKETS_PER_AGENT = 100;
let currentIpv6: string | null = null;

function getAgent(): https.Agent {
  for (let i = 0; i < 256; i++) {
    if (!currentIpv6) {
      currentIpv6 = pool.next();
    }
    const existing = agentPool.get(currentIpv6);
    if (!existing || existing.maxSockets > activeRequests(existing)) {
      return getOrCreateAgent(currentIpv6);
    }
    // Agent saturated – try next IP
    currentIpv6 = pool.next();
  }
  return getOrCreateAgent(pool.next());
}

function activeRequests(agent: https.Agent): number {
  let total = 0;
  for (const key of Object.keys(agent.sockets || {})) {
    total += agent.sockets![key]!.length;
  }
  return total;
}

function getOrCreateAgent(ipv6: string): https.Agent {
  let agent = agentPool.get(ipv6);
  if (!agent) {
    agent = new https.Agent({
      localAddress: ipv6,
      family: 6,
      keepAlive: true,
      keepAliveMsecs: 60000,
      maxSockets: MAX_SOCKETS_PER_AGENT,
      maxFreeSockets: 2,
      scheduling: "fifo",
    });
    agentPool.set(ipv6, agent);
  }
  return agent;
}

// ── Forwarding ──

async function forwardRequest(
  targetUrl: string,
  method: string,
  reqHeaders: http.IncomingHttpHeaders,
  body: Buffer | null,
  sourceIpv6: string,
  clientRes: http.ServerResponse,
): Promise<{ piped: boolean; status?: number; body?: string }> {
  const url = new URL(targetUrl);

  return new Promise((resolve, reject) => {
    const agent = getAgent();
    const isStreaming = reqHeaders["accept"] === "text/event-stream" ||
      (body && body.toString().includes('"stream":true'));

    const filteredHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(reqHeaders)) {
      const lower = key.toLowerCase();
      if (
        lower !== "host" &&
        lower !== "x-proxy-target" &&
        lower !== "accept-encoding" &&
        !lower.startsWith("x-stainless-") &&
        lower !== "user-agent" &&
        typeof value === "string"
      ) {
        filteredHeaders[key] = value;
      }
    }
    // No User-Agent — same as opencode fetch()
    delete filteredHeaders["user-agent"];
    filteredHeaders["host"] = url.hostname;
    filteredHeaders["accept-encoding"] = "identity";

    const reqTimeout = isStreaming ? 300_000 : 120_000;
    const options: https.RequestOptions = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method,
      headers: filteredHeaders,
      agent,
      timeout: reqTimeout,
    };

    const req = https.request(options, (upRes) => {
      if (isStreaming) {
        clientRes.writeHead(upRes.statusCode ?? 200, {
          "Content-Type": upRes.headers["content-type"] || "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no",
          "Transfer-Encoding": "chunked",
        });
        upRes.on("data", (chunk: Buffer) => {
          clientRes.write(chunk);
        });
        upRes.on("end", () => {
          clientRes.end();
          resolve({ piped: true });
        });
        upRes.on("error", (_err: Error) => {
          // Stream already started — just end the response, don't reject
          clientRes.end();
          resolve({ piped: true });
        });
      } else {
        const chunks: Buffer[] = [];
        upRes.on("data", (chunk: Buffer) => chunks.push(chunk));
        upRes.on("end", () => {
          resolve({
            piped: false,
            status: upRes.statusCode ?? 502,
            body: Buffer.concat(chunks).toString(),
          });
        });
        upRes.on("error", reject);
      }
    });

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("Request timeout"));
    });

    if (body) req.write(body);
    req.end();
  });
}

// ── Request handler ──

function filterModelsResponse(body, allowedModels) {
  try {
    const parsed = JSON.parse(body);
    if (parsed && parsed.data && Array.isArray(parsed.data)) {
      parsed.data = parsed.data.filter(m => allowedModels.includes(m.id));
      return JSON.stringify(parsed);
    }
  } catch {}
  return body;
}
async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const startTime = Date.now();
  const reqPath = req.url ?? "/";

  const bodyChunks: Buffer[] = [];
  for await (const chunk of req) {
    bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  let body: Buffer | null = bodyChunks.length > 0 ? Buffer.concat(bodyChunks) : null;

  // Apply GODMODE injection before forwarding
  const godmodeConfig = loadGodmodeConfig();
  const injected = applyGodmode(body, godmodeConfig);
  const wasInjected = godmodeConfig.enabled && injected !== body && injected !== null;
  if (wasInjected) {
    body = injected;
    // Update content-length for modified body
    if (req.headers["content-length"]) {
      req.headers["content-length"] = String(body!.length);
    }
  }

  const targetUrl = resolveTargetUrl(reqPath, req.headers, TARGET);

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (!currentIpv6) {
      currentIpv6 = pool.next();
    }
    const ipv6 = currentIpv6;
    const attemptStart = Date.now();

    try {
      const result = await forwardRequest(targetUrl, req.method ?? "POST", req.headers, body, ipv6, res);
      const elapsed = Date.now() - attemptStart;

      if (result.status === 429) {
        pool.block(ipv6);
        currentIpv6 = pool.next();
        currentIpv6 = pool.next();
        log(
          `429 rate-limited src=${ipv6} attempt=${attempt + 1}/${MAX_RETRIES} ` +
          `elapsed=${elapsed}ms — rotating to next IPv6`,
        );
        continue;
      }

      if (result.status >= 500 && result.status < 600 && result.status !== 501) {
        pool.block(ipv6);
        currentIpv6 = pool.next();
        log(
          `${result.status} upstream error src=${ipv6} - rotating to next IPv6`,
        );
        continue;
      }

      if (result.status >= 500) {
        pool.block(ipv6);
        currentIpv6 = pool.next();
        log(
          `Upstream ${result.status}, rotating IPv6`,
        );
        continue;
      }

      res.writeHead(result.status, { "Content-Type": "application/json" });
      const respBody = reqPath.includes("/v1/models") || reqPath.includes("/models") ? filterModelsResponse(result.body, ALLOWED_MODELS) : result.body;
      res.end(respBody);

      const totalElapsed = Date.now() - startTime;
      const godTag = wasInjected ? " [godmode]" : "";
      log(
        `${result.status}${godTag} src=${ipv6} attempt=${attempt + 1} ` +
        `elapsed=${elapsed}ms total=${totalElapsed}ms path=${reqPath}`,
      );
      return;
    } catch (err: unknown) {
      if (res.headersSent) {
        log(`error after stream start: ${(err instanceof Error ? err.message : String(err)).slice(0, 100)}`);
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      log(`error src=${ipv6} attempt=${attempt + 1}/${MAX_RETRIES} msg=${msg.slice(0, 200)}`);
      currentIpv6 = pool.next();
      continue;
    }
  }

  currentIpv6 = null;
  res.writeHead(429, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "All IPv6 addresses are rate-limited", retryAfterMs: COOLDOWN_MS }));
  log(`429 exhausted all ${MAX_RETRIES} IPv6 addresses for ${reqPath}`);
}

// ── Endpoints ──

function handleHealth(_req: http.IncomingMessage, res: http.ServerResponse): void {
  const snapshot = pool.snapshot();
  const blocked = snapshot.filter((s) => s.blocked).length;
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    status: "ok",
    poolSize: pool.size,
    blockedCount: blocked,
    availableCount: pool.size - blocked,
    cooldownMs: COOLDOWN_MS,
  }));
}

async function handleGodmode(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (req.method === "GET") {
    const config = loadGodmodeConfig();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(config, null, 2));
    return;
  }

  if (req.method === "POST") {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    try {
      const update = JSON.parse(Buffer.concat(chunks).toString());
      const current = loadGodmodeConfig();
      const merged = { ...current, ...update };
      saveGodmodeConfig(merged);
      log(`godmode config updated: enabled=${merged.enabled} prompt=${merged.systemPrompt ? "set" : "none"} prefill=${merged.prefillMessages?.length || merged.prefillMessagesFile ? "yes" : "no"}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(merged, null, 2));
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
    }
    return;
  }

  res.writeHead(405, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Method not allowed" }));
}

// ── Server ──

const server = http.createServer((req, res) => {
  if (REQUIRE_API_KEY) {
    const bearer = req.headers["authorization"];
    const xKey = req.headers["x-api-key"];
    const bearerOk = typeof bearer === "string" && bearer.startsWith("Bearer ") && bearer.slice(7).trim() === API_KEY;
    const xKeyOk = typeof xKey === "string" && xKey.trim() === API_KEY;
    if (!bearerOk && !xKeyOk) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized: invalid API key" }));
      log(`401 unauthorized from ${req.socket.remoteAddress}`);
      return;
    }
    delete req.headers["authorization"];
    delete req.headers["x-api-key"];
  }
  if (req.url === "/health" || req.url === "/healthz") {
    handleHealth(req, res);
    return;
  }
  if (req.url === "/godmode") {
    handleGodmode(req, res).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      log(`godmode error: ${msg}`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal error");
      }
    });
    return;
  }
  handleRequest(req, res).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    log(`unhandled: ${msg}`);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal proxy error");
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  log(`listening on 0.0.0.0:${PORT} -> ${TARGET}`);
  log(`pool: ${POOL_SIZE} IPv6 addresses, cooldown: ${COOLDOWN_MS}ms`);
  const gc = loadGodmodeConfig();
  log(`godmode: enabled=${gc.enabled} prompt=${gc.systemPrompt ? "set" : "none"}`);
});

server.on("error", (err: Error) => {
  log(`server error: ${err.message}`);
  process.exit(1);
});

process.on("SIGINT", () => {
  log("shutting down");
  server.close(() => process.exit(0));
});
process.on("SIGTERM", () => {
  log("shutting down");
  server.close(() => process.exit(0));
});
