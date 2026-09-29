/**
 * Vector clocks for SyncKit.
 *
 * A clock is `{clientId: counter}`. The counters are per-client and never move
 * backwards, so two clocks can be compared without wall time. Wall time is only
 * used as a deterministic tie-breaker for concurrent writes.
 */

export function createClock() {
  return {};
}

export function increment(clock, clientId) {
  if (!clientId) throw new Error("increment needs a client id");
  return { ...clock, [clientId]: (clock[clientId] || 0) + 1 };
}

export function mergeClocks(...clocks) {
  const merged = {};
  for (const clock of clocks) {
    for (const [client, counter] of Object.entries(clock)) {
      merged[client] = Math.max(merged[client] || 0, counter);
    }
  }
  return merged;
}

/** How far is `remote` behind `local`? Used to request only missing operations. */
export function missingFrom(local, remote) {
  const missing = {};
  for (const [client, counter] of Object.entries(remote)) {
    const have = local[client] || 0;
    if (counter > have) missing[client] = counter;
  }
  return missing;
}

/**
 * Compare two clocks:
 *   "equal" | "before" | "after" | "concurrent"
 * `before` means the first clock is dominated by the second (it has seen less).
 */
export function compare(a, b) {
  let aGreater = false;
  let bGreater = false;
  const clients = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const client of clients) {
    const left = a[client] || 0;
    const right = b[client] || 0;
    if (left > right) aGreater = true;
    else if (right > left) bGreater = true;
  }
  if (!aGreater && !bGreater) return "equal";
  if (aGreater && !bGreater) return "after";
  if (!aGreater && bGreater) return "before";
  return "concurrent";
}

export function isConcurrent(a, b) {
  return compare(a, b) === "concurrent";
}

export function clockSize(clock) {
  return Object.values(clock).reduce((sum, value) => sum + value, 0);
}

export function formatClock(clock) {
  return Object.keys(clock).sort().map((client) => `${client}:${clock[client]}`).join(" ");
}
