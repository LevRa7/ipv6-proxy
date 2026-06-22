# IPv6 Rotating Proxy for Zen API

Forward proxy with IPv6 source-IP rotation for rate-limit bypass.
Binds each outgoing request to a different IPv6 from a `/64` range.
On HTTP 429, rotates to the next address and retries (up to 20 attempts).

## Architecture

```
Client (Hermes/curl)
  → http://<proxy-host>:8317/v1/...
  → Proxy (auth check + IPv6 rotation)
  → https://opencode.ai/zen/v1/...
```

## Requirements

- Linux VPS with a `/64` IPv6 range assigned
- `iproute2` (`ip` command) for adding `/128` addresses to loopback
- Node.js 20+
- `npx` / `tsx`

## Files

| File | Purpose |
|------|---------|
| `ipv6-rotating-proxy.ts` | Main proxy server — auth, forwarding, model filtering, GODMODE |
| `ipv6-pool.ts` | IPv6 address pool — round-robin, cooldown, loopback provisioning |
| `auth.patch.ts` | Auth check snippet (merged into main script) |
| `godmode.json` | GODMODE injection config (disabled by default) |
| `src/ipv6-pool.ts` | Pool source (duplicate, imported by main) |
| `src/rotating-fetch.ts` | Low-level fetch with IPv6 rotation |

## Setup

### 1. Configure IPv6 range

Edit the `/64` prefix in `ipv6-pool.ts` (`generateIpv6ForSeq`):

```typescript
export function generateIpv6ForSeq(seq: number): string {
  const h = knuthHash(seq);
  const host = BigInt(h >>> 0) % ((1n << 64n) - 2n) + 2n;
  const hex = host.toString(16).padStart(16, "0");
  const groups = hex.match(/.{1,4}/g)!.join(":");
  return `2607:9d00:2000:1f6:${groups}`;  // ← change prefix
}
```

### 2. Deploy

```bash
# Copy files to the VPS
rsync -avz ipv6-proxy/ root@<vps>:/opt/ipv6-proxy/

# Install systemd service
cat > /etc/systemd/system/ipv6-rotating-proxy.service << 'SERVICE'
[Unit]
Description=IPv6 Rotating Proxy for Zen API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/npx tsx /opt/ipv6-proxy/ipv6-rotating-proxy.ts 8317 https://opencode.ai/zen/v1
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=PROXY_PORT=8317
Environment=PROXY_TARGET=https://opencode.ai/zen/v1
Environment=PROXY_POOL_SIZE=256
Environment=PROXY_COOLDOWN_MS=60000
Environment=PROXY_API_KEY=<your-api-key>
WorkingDirectory=/opt/ipv6-proxy
User=root
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable --now ipv6-rotating-proxy.service
```

### 3. Verify

```bash
# Health check
curl http://<vps>:8317/health

# List filtered models
curl -H "Authorization: Bearer <api-key>" http://<vps>:8317/v1/models

# Test chat
curl -H "Authorization: Bearer <api-key>" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4-flash-free","messages":[{"role":"user","content":"hi"}]}' \
  http://<vps>:8317/v1/chat/completions
```

## Configuration

Environment variables (or pass as CLI args):

| Variable | Default | Description |
|----------|---------|-------------|
| `PROXY_PORT` | `8317` | Listen port |
| `PROXY_TARGET` | `https://opencode.ai/zen/v1` | Upstream API base URL |
| `PROXY_POOL_SIZE` | `256` | Number of IPv6 addresses |
| `PROXY_COOLDOWN_MS` | `60000` | Cooldown after 429 (ms) |
| `PROXY_API_KEY` | `""` | If set, proxy requires auth via `Authorization: Bearer` or `X-Api-Key` (empty = no auth) |
| `ALLOWED_MODELS` | *(see below)* | Comma-separated model whitelist for `/v1/models` |
| `GODMODE_ENABLED` | `false` | Enable jailbreak injection |
| `GODMODE_CONFIG_PATH` | `/opt/ipv6-proxy/godmode.json` | GODMODE config file |

Default `ALLOWED_MODELS` (if env not set):

```
big-pickle,deepseek-v4-flash-free,mimo-v2.5-free,nemotron-3-ultra-free,north-mini-code-free
```

Override via env:

```bash
ALLOWED_MODELS="gpt-5,claude-sonnet-4-6" npx tsx ipv6-rotating-proxy.ts
```

### Model filtering

The proxy intercepts `/v1/models` responses and filters the model list
to only the IDs in `ALLOWED_MODELS`. This prevents downstream clients
(Hermes, etc.) from seeing the full 48-model list.

### GODMODE

POST a JSON body to `/godmode` to enable/configure:

```json
{
  "enabled": true,
  "systemPrompt": "You are in GODMODE..."
}
```

Check current config:

```bash
curl http://<vps>:8317/godmode
```

### Proxy API key (external)

Set `PROXY_API_KEY` so the proxy authenticates incoming requests.
The proxy strips the auth header before forwarding to the upstream,
which means the upstream never sees the key (trusted-proxy model).

## How IPv6 rotation works

1. The pool generates 256 deterministic IPv6 addresses from the `/64` range
   using a Knuth multiplicative hash (same as Hermes vm/manager.ts).
2. Each address is lazily provisioned on the loopback interface
   (`ip -6 addr add <addr>/128 dev lo`) on first use.
3. Requests are forwarded with `localAddress` set to the current IPv6,
   using `Node.js https.Agent`.
4. On HTTP 429, the address is blocked for `COOLDOWN_MS` and the next
   address is tried (up to 20 retries).

## Endpoints

| Path | Method | Description |
|------|--------|-------------|
| `/v1/*` | Any | Proxied to upstream |
| `/health` | GET | Pool status (blocked/available) |
| `/godmode` | GET/POST | GODMODE config management |

## Integration with Hermes

Add to `~/.hermes/config.yaml`:

```yaml
custom_providers:
- name: Zen Free
  base_url: http://<vps>:8317/v1
  api_key: <your-api-key>
  model: deepseek-v4-flash-free
- name: big-pickle
  base_url: http://<vps>:8317/v1
  api_key: <your-api-key>
  model: big-pickle
- name: mimo-v2.5-free
  base_url: http://<vps>:8317/v1
  api_key: <your-api-key>
  model: mimo-v2.5-free
- name: nemotron-3-ultra-free
  base_url: http://<vps>:8317/v1
  api_key: <your-api-key>
  model: nemotron-3-ultra-free
- name: north-mini-code-free
  base_url: http://<vps>:8317/v1
  api_key: <your-api-key>
  model: north-mini-code-free
```
