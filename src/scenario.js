/** Seeded random operation streams for the convergence property test and demo. */
import { FIELDS } from "./engine.js";

export function rng(seed = 1) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VALUES = {
  title: ["Draft plan", "Weekend plan", "Team offsite", "Launch checklist", "Grocery list"],
  done: [true, false],
  assignee: ["Sita", "Ramesh", "Anita", ""],
  notes: ["Bring cash", "Pickup at 5", "Call first", ""],
};

/**
 * Generate a reproducible sequence of operations.
 * opts.clients, opts.steps, opts.seed, opts.offlineEvery (partition frequency).
 */
export function randomScenario({ clients = 2, steps = 40, seed = 7 } = {}) {
  const random = rng(seed);
  const operations = [];
  const clientIds = Array.from({ length: clients }, (_, index) => `c${index + 1}`);
  let seq = 0;
  for (let step = 0; step < steps; step++) {
    const client = clientIds[Math.floor(random() * clients)];
    const field = FIELDS[Math.floor(random() * FIELDS.length)];
    const pool = VALUES[field];
    const value = pool[Math.floor(random() * pool.length)];
    seq += 1;
    operations.push({ step, client, field, value, order: seq });
  }
  return operations;
}

/** A deliberately conflicting script: both clients edit the title while apart. */
export function conflictScenario() {
  return [
    { client: "c1", field: "title", value: "Team offsite — Kathmandu" },
    { client: "c2", field: "title", value: "Team offsite — Pokhara" },
    { client: "c1", field: "assignee", value: "Sita" },
    { client: "c2", field: "assignee", value: "Ramesh" },
    { client: "c1", field: "notes", value: "Book the bus" },
    { client: "c2", field: "done", value: true },
  ];
}
