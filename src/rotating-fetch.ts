/**
 * IPv6 rotating fetch — client-side wrapper for the IPv6 rotating proxy.
 *
 * Provides a `fetch`-compatible function that routes requests through
 * the IPv6 rotating proxy server running on the VPS.
 *
 * Usage:
 *   const rotatingFetch = createRotatingFetch({ proxyUrl: "http://100.114.41.84:8317" });
 *   const res = await rotatingFetch("https://opencode.ai/zen/v1/chat/completions", {
 *     method: "POST",
 *     headers: { "Content-Type": "application/json" },
 *     body: JSON.stringify({ model: "...", messages: [...] }),
 *   });
 */

export interface RotatingFetchOptions {
  /** URL of the IPv6 rotating proxy server */
  proxyUrl: string;
  /** Timeout per request in ms (default 120_000) */
  timeoutMs?: number;
}

/**
 * Creates a fetch wrapper that routes through the IPv6 rotating proxy.
 *
 * The proxy forwards requests to the target URL specified in the
 * `X-Proxy-Target` header. The proxy handles IPv6 source address
 * rotation and automatic retry on HTTP 429 rate limits.
 */
export function createRotatingFetch(
  options: RotatingFetchOptions,
): (input: string, init?: RequestInit) => Promise<Response> {
  const { proxyUrl, timeoutMs = 120_000 } = options;

  return async function rotatingFetch(
    input: string,
    init?: RequestInit,
  ): Promise<Response> {
    const targetUrl = input;

    const headers = new Headers(init?.headers);
    headers.set("x-proxy-target", targetUrl);

    // Ensure we have Content-Type for POST requests
    if (init?.body && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }

    const proxyPath = targetUrl.includes("://") ? new URL(targetUrl).pathname + new URL(targetUrl).search : targetUrl;

    return fetch(`${proxyUrl}${proxyPath}`, {
      method: init?.method ?? "GET",
      headers,
      body: init?.body,
      signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
  };
}
