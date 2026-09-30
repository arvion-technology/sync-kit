import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import {
  createClock, increment, mergeClocks, compare, missingFrom, isConcurrent, formatClock,
} from "../src/clock.js";
import { createBus } from "../src/transport.js";
import { createClient, syncPair, converged, conflictReport } from "../src/engine.js";
import { randomScenario, conflictScenario } from "../src/scenario.js";

const vectors = JSON.parse(readFileSync(new URL("./vectors/sync_vectors.json", import.meta.url), "utf8"));

/* ------------------------------------------------------------- clocks */

test("clocks increment per client and merge by maximum", () => {
  let clock = createClock();
  clock = increment(clock, "a");
  clock = increment(clock, "a");
  clock = increment(clock, "b");
  assert.deepEqual(clock, { a: 2, b: 1 });
  assert.deepEqual(mergeClocks({ a: 2, b: 1 }, { a: 1, c: 4 }), { a: 2, b: 1, c: 4 });
  assert.throws(() => increment(createClock(), ""), /needs a client id/);
});

test("clock comparison distinguishes equal, before, after and concurrent", () => {
  for (const item of vectors.compare) {
    assert.equal(compare(item.a, item.b), item.expected, JSON.stringify(item));
    assert.equal(compare(item.b, item.a), reverse(item.expected), "comparison must be symmetric");
  }
  assert.equal(isConcurrent({ a: 1 }, { b: 1 }), true);
  assert.equal(isConcurrent({ a: 1 }, { a: 2 }), false);
});

function reverse(relation) {
  if (relation === "before") return "after";
  if (relation === "after") return "before";
  return relation;
}

test("missingFrom reports only what the remote has beyond the local clock", () => {
  assert.deepEqual(missingFrom({ a: 2, b: 1 }, { a: 2, c: 3 }), { c: 3 });
  assert.deepEqual(missingFrom({ a: 3 }, { a: 1 }), {});
  assert.deepEqual(missingFrom({}, { a: 1, b: 2 }), { a: 1, b: 2 });
  assert.equal(formatClock({ b: 2, a: 1 }), "a:1 b:2");
});

/* ------------------------------------------------------------- transport */

test("a connected bus delivers posts immediately", () => {
  const bus = createBus();
  const received = [];
  bus.register("b", (operations) => received.push(...operations));
  bus.register("a", () => {});
  const result = bus.post("a", [{ id: "x" }]);
  assert.equal(result.delivered, 1);
  assert.equal(received.length, 1);
  assert.equal(bus.isPartitioned(), false);
  assert.equal(bus.flowLog()[0].from, "a");
});

test("a partition queues operations and heal delivers them", () => {
  const bus = createBus();
  const received = [];
  bus.register("b", (operations) => received.push(...operations));
  bus.partition();
  bus.post("a", [{ id: "x" }, { id: "y" }]);
  assert.equal(received.length, 0);
  assert.equal(bus.pending()[0].count, 2);
  const delivered = bus.heal();
  assert.equal(delivered, 2);
  assert.equal(received.length, 2);
  assert.equal(bus.isPartitioned(), false);
  assert.ok(bus.flowLog().some((entry) => entry.partitioned));
});

/* ------------------------------------------------------------- engine */

function makeClients(doc = {}) {
  const bus = createBus();
  const a = createClient({ id: "a", transport: bus, doc });
  const b = createClient({ id: "b", transport: bus, doc });
  return { bus, a, b };
}

test("a local edit bumps the clock, updates the doc and queues an operation", () => {
  const { a } = makeClients();
  a.set("title", "Plan");
  assert.equal(a.doc.title, "Plan");
  assert.deepEqual(a.clock, { a: 1 });
  assert.equal(a.outbox.length, 1);
  assert.equal(a.log.length, 1);
  assert.equal(a.isDirty, true);
  assert.throws(() => a.set("unknown", 1), /unknown field/);
});

test("applying the same operation twice is a no-op", () => {
  const { a, b } = makeClients();
  const operation = a.set("title", "Once");
  const first = b.receive([operation]);
  const second = b.receive([operation]);
  assert.equal(first[0].applied, true);
  assert.equal(second[0].applied, false);
  assert.equal(second[0].reason, "duplicate");
  assert.equal(b.log.length, 1);
});

test("an older operation cannot overwrite a newer field value", () => {
  const { a, b } = makeClients();
  const first = a.set("title", "First");
  a.flush();
  b.receive([first]);
  const stale = { id: "a-0", client: "a", field: "title", value: "Older", ts: 0, clock: { a: 0 } };
  const result = b.receive([stale]);
  assert.equal(result[0].applied, false);
  assert.equal(b.doc.title, "First");
});

test("concurrent edits to different fields both apply", () => {
  const { bus, a, b } = makeClients();
  bus.partition();
  a.set("title", "From A");
  b.set("notes", "From B");
  a.flush();
  b.flush();
  bus.heal();
  assert.equal(a.doc.title, "From A");
  assert.equal(a.doc.notes, "From B");
  assert.equal(b.doc.title, "From A");
  assert.equal(b.doc.notes, "From B");
  assert.equal(converged(a, b), true);
});

test("concurrent edits to the same field resolve deterministically", () => {
  for (let seed = 0; seed < 8; seed++) {
    const { bus, a, b } = makeClients();
    bus.partition();
    a.set("title", "A wins?", { ts: 1 });
    b.set("title", "B wins?", { ts: 1 });
    a.flush();
    b.flush();
    bus.heal();
    assert.equal(converged(a, b), true, `seed ${seed}`);
    assert.equal(a.doc.title, b.doc.title, `seed ${seed}`);
    assert.ok(a.conflicts + b.conflicts >= 1, "a conflict must be recorded");
  }
});

test("field-level merge keeps both concurrent changes", () => {
  const { bus, a, b } = makeClients();
  bus.partition();
  a.set("title", "Title from A", { ts: 5 });
  b.set("assignee", "Sita", { ts: 5 });
  a.flush();
  b.flush();
  bus.heal();
  assert.equal(a.doc.title, "Title from A");
  assert.equal(b.doc.assignee, "Sita");
  assert.equal(converged(a, b), true);
});

test("a two-way sync converges after a partition", () => {
  const { bus, a, b } = makeClients();
  a.set("title", "Offline title");
  a.set("done", true);
  bus.partition();
  b.set("assignee", "Ramesh");
  const before = conflictReport(a, b);
  assert.equal(before.converged, false);
  bus.heal();
  syncPair(a, b);
  assert.equal(converged(a, b), true);
  assert.deepEqual(a.clock, b.clock, "both clocks must see every operation");
});

test("convergence holds over randomised operation streams", () => {
  for (let seed = 1; seed <= 30; seed++) {
    const { bus, a, b } = makeClients();
    const script = randomScenario({ clients: 2, steps: 36, seed });
    bus.partition();
    const clients = { c1: a, c2: b };
    for (const step of script) {
      clients[step.client].set(step.field, step.value);
      if (Math.random() < 0.001) continue; // never rely on wall time
    }
    a.flush();
    b.flush();
    bus.heal();
    syncPair(a, b);
    assert.equal(converged(a, b), true, `seed ${seed} diverged: ${JSON.stringify(conflictReport(a, b))}`);
    assert.deepEqual(a.clock, b.clock, `seed ${seed} clocks differ`);
  }
});

test("replaying the full log does not change the document", () => {
  const { bus, a, b } = makeClients();
  a.set("title", "Replay me");
  a.set("notes", "twice");
  bus.partition();
  b.set("done", true);
  a.flush();
  b.flush();
  bus.heal();
  syncPair(a, b);
  const snapshot = JSON.stringify(b.doc);
  b.receive(b.log.filter((operation) => operation.type !== "snapshot"));
  assert.equal(JSON.stringify(b.doc), snapshot);
});

test("snapshot and restore preserve state and compact the log", () => {
  const { a } = makeClients();
  for (let index = 0; index < 10; index++) a.set("notes", `note ${index}`);
  const before = a.log.length;
  const snap = a.compact();
  assert.ok(a.log.length < before, "compact must shrink the log");
  assert.equal(snap.doc.notes, "note 9");
  const fresh = a.snapshot();
  a.set("title", "after snapshot");
  a.restore({ ...fresh });
  assert.equal(a.doc.title, "");
  assert.equal(a.doc.notes, "note 9");
});

test("the shared vectors describe the same comparison rules the Dart port uses", () => {
  assert.equal(vectors.compare.length >= 6, true);
  assert.equal(vectors.merge.length >= 2, true);
  assert.equal(vectors.apply.length >= 1, true);
  for (const item of vectors.merge) {
    assert.deepEqual(mergeClocks(...item.clocks), item.expected);
  }
});

test("the conflict scenario produces a visible disagreement before sync", () => {
  const { bus, a, b } = makeClients();
  bus.partition();
  for (const step of conflictScenario()) {
    (step.client === "c1" ? a : b).set(step.field, step.value, { ts: 1 });
  }
  a.flush();
  b.flush();
  assert.notEqual(a.doc.title, b.doc.title);
  bus.heal();
  syncPair(a, b);
  assert.equal(a.doc.title, b.doc.title);
  assert.equal(a.doc.notes, "Book the bus");
  assert.equal(a.doc.done, true);
  assert.equal(existsSync(new URL("../dart/synckit.dart", import.meta.url)), true);
});
