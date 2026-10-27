'use strict';

// In-memory caps. With --max-instances=1 these counters are authoritative,
// but they reset when the instance restarts (documented in README).
//   per install:  posts per UTC day
//   per IP:       posts per UTC day
//   global:       estimated USD spend per UTC day
//   per install:  requests per minute

function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function nextUtcMidnight(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

class Limits {
  constructor({ perInstall = 1000, perIp = 3000, globalUsd = 3, perMinute = 60, now = Date.now } = {}) {
    Object.assign(this, { perInstall, perIp, globalUsd, perMinute, now });
    this.day = utcDay(now());
    this.installs = new Map();
    this.ips = new Map();
    this.spentUsd = 0;
    this.postsToday = 0;
    this.minute = Math.floor(now() / 60000);
    this.requests = new Map();
  }

  rollover() {
    const t = this.now();
    const day = utcDay(t);
    if (day !== this.day) {
      this.day = day;
      this.installs.clear();
      this.ips.clear();
      this.spentUsd = 0;
      this.postsToday = 0;
    }
    const minute = Math.floor(t / 60000);
    if (minute !== this.minute) {
      this.minute = minute;
      this.requests.clear();
    }
    return t;
  }

  resetsAt() {
    return new Date(nextUtcMidnight(this.now())).toISOString();
  }

  // Counts one request against the per-minute limit. Returns null or seconds to wait.
  hitRate(installId) {
    const t = this.rollover();
    const count = (this.requests.get(installId) || 0) + 1;
    this.requests.set(installId, count);
    if (count > this.perMinute) return Math.max(1, Math.ceil(((this.minute + 1) * 60000 - t) / 1000));
    return null;
  }

  budgetExhausted() {
    this.rollover();
    return this.spentUsd >= this.globalUsd;
  }

  remaining(installId, ip) {
    this.rollover();
    const byInstall = this.perInstall - (this.installs.get(installId) || 0);
    const byIp = this.perIp - (this.ips.get(ip) || 0);
    return Math.max(0, Math.min(byInstall, byIp));
  }

  // Reserve up to `wanted` posts. Returns { granted } or { error }.
  reserve(installId, ip, wanted) {
    if (this.budgetExhausted()) return { error: 'global_budget' };
    const granted = Math.min(wanted, this.remaining(installId, ip));
    if (granted <= 0) return { error: 'daily_limit' };
    this.installs.set(installId, (this.installs.get(installId) || 0) + granted);
    this.ips.set(ip, (this.ips.get(ip) || 0) + granted);
    return { granted, day: this.day };
  }

  // Settle a reservation: refund unused posts (same day only) and record spend.
  settle(installId, ip, reservation, used, costUsd) {
    this.rollover();
    if (reservation.day === this.day) {
      const refund = reservation.granted - used;
      if (refund > 0) {
        this.installs.set(installId, Math.max(0, (this.installs.get(installId) || 0) - refund));
        this.ips.set(ip, Math.max(0, (this.ips.get(ip) || 0) - refund));
      }
      this.spentUsd += costUsd;
      this.postsToday += used;
    }
  }
}

module.exports = { Limits, utcDay, nextUtcMidnight };
