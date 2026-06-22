/**
 * IPv6 address pool for API proxy source-IP rotation.
 *
 * Uses the same Knuth multiplicative hash as vm/manager.ts
 * to generate deterministic IPv6 addresses from the VPS /64 range
 * (2607:9d00:2000:1f6::/64).
 *
 * The pool provides sequential addresses for round-robin proxying.
 * When the Zen API returns HTTP 429 (rate limit), the current address
 * is blocked for a cooldown period and the next address is used.
 *
 * On first use of an address, it is lazily provisioned on the loopback
 * interface (ip -6 addr add <addr>/128 dev lo) so Node.js can bind().
 */

import { execSync } from "node:child_process";

/** Knuth's multiplicative hash — same as vm/manager.ts */
function knuthHash(n: number): number {
  return (n * 2654435761) >>> 0;
}

/** Deterministic IPv6 from VPS /64 range: 2607:9d00:2000:1f6::<hash%2^64>
 *  Address ::1 is reserved for gateway. Pool addresses start from ::2.
 *  Returns fully-expanded format (no :: shorthand) for iproute2 compatibility. */
export function generateIpv6ForSeq(seq: number): string {
  const h = knuthHash(seq);
  const host = BigInt(h >>> 0) % ((1n << 64n) - 2n) + 2n;
  const hex = host.toString(16).padStart(16, "0");
  const groups = hex.match(/.{1,4}/g)!.join(":");
  return `2607:9d00:2000:1f6:${groups}`;
}

/**
 * Provision an IPv6 /128 address on the loopback interface.
 * Idempotent — skips if already assigned.
 */
function ensureIpv6OnLo(ipv6: string): void {
  try {
    // Check if already assigned
    const result = execSync(`ip -6 addr show dev lo 2>/dev/null`).toString();
    if (result.includes(ipv6)) return;

    // Add /128 to loopback
    execSync(`ip -6 addr add ${ipv6}/128 dev lo 2>/dev/null`);
  } catch {
    // If ip command fails, the OS might not support this — ignore
  }
}

export interface Ipv6PoolOptions {
  /** Number of addresses in the pool (default 256) */
  poolSize?: number;
  /** Cooldown in ms for a rate-limited address (default 60_000) */
  cooldownMs?: number;
  /** Starting sequence index (default 0) for deterministic pool */
  startSeq?: number;
}

export interface PooledAddress {
  ipv6: string;
  blockedUntil: number;
}

/**
 * Manages a pool of IPv6 addresses with rate-limit cooldown tracking.
 * Provides round-robin iteration, skipping blocked addresses.
 */
export class Ipv6Pool {
  private addresses: PooledAddress[];
  private index: number;
  private cooldownMs: number;

  constructor(options: Ipv6PoolOptions = {}) {
    const { poolSize = 256, cooldownMs = 60_000, startSeq = 0 } = options;
    this.cooldownMs = cooldownMs;
    this.index = 0;

    this.addresses = Array.from({ length: poolSize }, (_, i) => ({
      ipv6: generateIpv6ForSeq(startSeq + i),
      blockedUntil: 0,
    }));

    // Pre-provision first 8 addresses to reduce cold-start latency
    for (let i = 0; i < Math.min(8, poolSize); i++) {
      ensureIpv6OnLo(this.addresses[i]!.ipv6);
    }
  }

  /** Return the size of the pool */
  get size(): number {
    return this.addresses.length;
  }

  /** Return the next available (not rate-limited) IPv6 address, provisioning it on lo if needed */
  next(): string {
    const now = Date.now();
    const size = this.addresses.length;

    for (let attempt = 0; attempt < size; attempt++) {
      const addr = this.addresses[this.index]!;
      this.index = (this.index + 1) % size;

      if (addr.blockedUntil <= now) {
        ensureIpv6OnLo(addr.ipv6);
        return addr.ipv6;
      }
    }

    // All addresses are blocked — return the one with the earliest cooldown expiry
    this.index = start; // don't perturb state
    const earliest = this.addresses.reduce((best, a) =>
      a.blockedUntil < best.blockedUntil ? a : best,
    );
    return earliest.ipv6;
  }

  /** Mark an IPv6 as rate-limited for the cooldown period */
  block(ipv6: string): void {
    const addr = this.addresses.find((a) => a.ipv6 === ipv6);
    if (addr) {
      addr.blockedUntil = Date.now() + this.cooldownMs;
    }
  }

  /** Get the current state for diagnostics */
  snapshot(): Array<{ ipv6: string; blocked: boolean }> {
    const now = Date.now();
    return this.addresses.map((a) => ({
      ipv6: a.ipv6,
      blocked: a.blockedUntil > now,
    }));
  }
}
