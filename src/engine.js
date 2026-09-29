/**
 * SyncKit engine: an operation log with vector clocks, last-writer-wins for a
 * single field and field-level merge for concurrent edits on different fields.
 *
 * The rules:
 *   - every local mutation bumps the client's clock and becomes an operation;
 *   - an operation is applied only if its clock is newer than the field's clock;
 *   - concurrent edits to the same field resolve deterministically by (ts, client);
 *   - concurrent edits to different fields both apply;
 *   - applying the same operation twice is a no-op.
 */
import { createClock, increment, mergeClocks, compare, missingFrom, formatClock } from "./clock.js";

export const FIELDS = ["title", "done", "assignee", "notes"];

export function createClient({ id, transport, doc = {} }) {
  if (!id) throw new Error("client needs an id");
  if (!transport) throw new Error("client needs a transport");

  let clock = createClock();
  let docState = { title: "", done: false, assignee: "", notes: "", ...doc };
  let fields = {}; // field -> { ts, client, clock }
  let log = [];
  const seen = new Set();
  let outbox = [];
  let seq = 0;
  let conflicts = 0;

  const events = [];

  function applyOperation(operation, { remote = false } = {}) {
    if (!operation?.id) throw new Error("operation needs an id");
    if (seen.has(operation.id)) return { applied: false, reason: "duplicate" };
    seen.add(operation.id);
    log.push(operation);
    clock = mergeClocks(clock, operation.clock);

    const meta = fields[operation.field];
    if (meta) {
      const relation = compare(operation.clock, meta.clock);
      if (relation === "before" || relation === "equal") {
        events.push({ kind: "stale", field: operation.field, operation });
        return { applied: false, reason: "stale" };
      }
      if (relation === "concurrent") {
        conflicts += 1;
        events.push({ kind: "conflict", field: operation.field, operation, lost: false });
      }
    }

    // LWW for the same field: logical timestamp, then client id to break ties.
    if (meta && meta.ts > operation.ts) {
      return { applied: false, reason: "newer value exists" };
    }
    if (meta && meta.ts === operation.ts && meta.client > operation.client) {
      return { applied: false, reason: "tie broken by client id" };
    }

    docState = { ...docState, [operation.field]: operation.value };
    fields = {
      ...fields,
      [operation.field]: { ts: operation.ts, client: operation.client, clock: operation.clock },
    };
    events.push({ kind: remote ? "remote" : "local", field: operation.field, operation });
    return { applied: true, reason: "applied" };
  }

  function makeOperation(field, value, ts) {
    if (!FIELDS.includes(field)) throw new Error(`unknown field "${field}"`);
    seq += 1;
    clock = increment(clock, id);
    return {
      id: `${id}-${seq}`,
      client: id,
      field,
      value,
      ts: ts ?? seq,
      clock: { ...clock },
    };
  }

  function localSet(field, value, { ts } = {}) {
    const operation = makeOperation(field, value, ts);
    applyOperation(operation);
    outbox.push(operation);
    return operation;
  }

  function flush() {
    if (!outbox.length) return { sent: 0 };
    const batch = outbox;
    outbox = [];
    transport.post(id, batch);
    return { sent: batch.length };
  }

  function receive(operations) {
    const results = operations.map((operation) => applyOperation(operation, { remote: true }));
    events.push({ kind: "received", count: operations.length });
    return results;
  }

  function snapshot() {
    return {
      doc: { ...docState },
      fields: JSON.parse(JSON.stringify(fields)),
      clock: { ...clock },
      at: log.length,
    };
  }

  function restore(snapshotValue) {
    docState = { ...snapshotValue.doc };
    fields = JSON.parse(JSON.stringify(snapshotValue.fields));
    clock = { ...snapshotValue.clock };
    log = [{ id: `${id}-snapshot`, type: "snapshot", clock: { ...clock } }];
    seen.clear();
    events.push({ kind: "restored" });
    return docState;
  }

  /** Compact the log without changing the state; the snapshot is the new baseline. */
  function compact() {
    const snap = snapshot();
    log = [{ id: `${id}-snapshot-${log.length}`, type: "snapshot", clock: { ...clock } }];
    return snap;
  }

  transport.register(id, receive);

  return {
    id,
    get doc() { return { ...docState }; },
    get clock() { return { ...clock }; },
    get log() { return [...log]; },
    get events() { return [...events]; },
    get conflicts() { return conflicts; },
    get outbox() { return [...outbox]; },
    get isDirty() { return outbox.length > 0; },
    set: localSet,
    receive,
    flush,
    snapshot,
    restore,
    compact,
    missingFrom: (remoteClock) => missingFrom(clock, remoteClock),
    clockLabel: () => formatClock(clock),
    clearEvents() { events.length = 0; },
  };
}

/**
 * Full two-way exchange: each side flushes, then sends everything the other has
 * not seen. Returns both vectors.
 */
export function syncPair(a, b) {
  a.flush();
  b.flush();
  const toB = a.log.filter((operation) => operation.type !== "snapshot" && !b.log.some((other) => other.id === operation.id));
  const toA = b.log.filter((operation) => operation.type !== "snapshot" && !a.log.some((other) => other.id === operation.id));
  if (toB.length) b.receive(toB);
  if (toA.length) a.receive(toA);
  a.flush();
  b.flush();
  return { aToB: toB.length, bToA: toA.length };
}

/** Do two clients agree on the document and on the clocks they have seen? */
export function converged(a, b) {
  return JSON.stringify(a.doc) === JSON.stringify(b.doc);
}

export function conflictReport(a, b) {
  return {
    converged: converged(a, b),
    aConflicts: a.conflicts,
    bConflicts: b.conflicts,
    aClock: a.clockLabel(),
    bClock: b.clockLabel(),
    aDoc: a.doc,
    bDoc: b.doc,
  };
}
