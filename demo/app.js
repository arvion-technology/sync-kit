// SyncKit demo — two clients editing one document across a partition.
// The engine, clocks and transport come from ../src; this file renders and
// wires the controls.
import { createBus } from "../src/transport.js";
import { createClient, syncPair, converged } from "../src/engine.js";
import { FIELDS } from "../src/engine.js";
import { conflictScenario } from "../src/scenario.js";

const $ = A.$, $$ = A.$$, el = A.el;

const DEFAULT_DOC = { title: "Team offsite", done: false, assignee: "", notes: "Pick a date" };
const state = { onlineA: true, onlineB: true, view: "conflict" };
let bus;
let a;
let b;
let seeded = false;

function boot() {
  bus = createBus();
  a = createClient({ id: "A", transport: bus, doc: DEFAULT_DOC });
  b = createClient({ id: "B", transport: bus, doc: DEFAULT_DOC });
}

/** The demonstration: a partition, then both people make a change. */
function seedConflict() {
  bus.partition();
  state.onlineA = false;
  state.onlineB = false;
  const script = conflictScenario();
  for (const step of script) {
    const client = step.client === "c1" ? a : b;
    client.set(step.field, step.value, { ts: 1 });
  }
  seeded = true;
}

function show(log) {
  A.toast(log, "info");
}

function flushClient(client) {
  if (client === a && !state.onlineA) return { sent: 0 };
  if (client === b && !state.onlineB) return { sent: 0 };
  return client.flush();
}

function update() {
  render();
}

/* --------------------------------------------------------------- controls */

function setField(client, field, value) {
  client.set(field, value);
  flushClient(client);
  update();
}

function healAndSync() {
  bus.heal();
  state.onlineA = true;
  state.onlineB = true;
  a.flush();
  b.flush();
  syncPair(a, b);
  update();
  show(converged(a, b) ? "Partition healed. Both clients agree." : "Still diverged — this should not happen");
}

function toggleNetwork() {
  if (bus.isPartitioned()) { healAndSync(); return; }
  bus.partition();
  state.onlineA = false;
  state.onlineB = false;
  update();
  show("Network partitioned. Edits now queue at the transport.");
}

function toggleOnline(which) {
  if (which === "A") state.onlineA = !state.onlineA;
  else state.onlineB = !state.onlineB;
  const client = which === "A" ? a : b;
  if ((which === "A" && state.onlineA) || (which === "B" && state.onlineB)) {
    client.flush();
  }
  update();
}

function reset(view) {
  state.view = view;
  boot();
  if (view === "converged") {
    seedConflict();
    a.flush();
    b.flush();
    bus.heal();
    state.onlineA = true;
    state.onlineB = true;
    syncPair(a, b);
  } else {
    seedConflict();
  }
  update();
}

/* --------------------------------------------------------------- render */

function fieldRow(label, control) {
  return el("div", { class: "field-row" }, el("label", { text: label }), control);
}

function clientCard(client, label, which) {
  const online = which === "A" ? state.onlineA : state.onlineB;
  const other = which === "A" ? b : a;
  const conflict = client.conflicts > 0;
  const card = el("div", { class: `client ${conflict ? "conflicted" : ""}` },
    el("div", { class: "client-head" },
      el("span", { class: "status-dot" + (online ? "" : " off") }),
      el("h2", { text: `Client ${label}` }),
      el("span", { class: "badge", text: online ? "online" : "offline" }),
      el("span", { class: "spacer" }),
      el("button", {
        class: "btn sm", type: "button", text: online ? "Go offline" : "Go online",
        onclick: () => toggleOnline(which),
      })),
    el("div", { class: "client-body" },
      fieldRow("Title", el("input", {
        class: "input", value: client.doc.title,
        onchange: (event) => setField(client, "title", event.target.value),
      })),
      fieldRow("Assignee", el("select", {
        class: "select", onchange: (event) => setField(client, "assignee", event.target.value),
      }, ...["", "Sita", "Ramesh", "Anita"].map((name) => el("option", { value: name, text: name || "unassigned", selected: client.doc.assignee === name ? "" : null })))),
      fieldRow("Done", el("label", { class: "check" },
        el("input", {
          type: "checkbox", checked: client.doc.done ? "" : null,
          onchange: (event) => setField(client, "done", event.target.checked),
        }),
        el("span", { text: client.doc.done ? "marked done" : "not done" }))),
      fieldRow("Notes", el("input", {
        class: "input", value: client.doc.notes,
        onchange: (event) => setField(client, "notes", event.target.value),
      }))),
    el("div", { class: "client-meta" },
      el("span", {}, "clock ", el("span", { class: "clock", text: client.clockLabel() })),
      el("span", {}, "outbox ", el("b", { text: String(client.outbox.length) })),
      el("span", {}, "conflicts ", el("b", { text: String(client.conflicts) })),
      el("span", {}, "ops ", el("b", { text: String(client.log.filter((op) => op.type !== "snapshot").length) }))),
    client.isDirty
      ? el("div", { class: "sync-warning", text: `${client.outbox.length} operation(s) not yet shared with ${other.id}.` })
      : null,
    el("div", { class: "client-actions" },
      el("button", { class: "btn sm", type: "button", text: "Push outbox", onclick: () => { flushClient(client); update(); } }),
      el("button", { class: "btn sm", type: "button", text: "Snapshot", onclick: () => { client.compact(); update(); show(`Client ${label} compacted its log into a snapshot.`); } })));
  return card;
}

function opsLog() {
  const ops = [...a.log, ...b.log].filter((operation) => operation.type !== "snapshot");
  const unique = new Map();
  for (const operation of ops) unique.set(operation.id, operation);
  const list = [...unique.values()].slice(-16);
  const host = el("div", { class: "op-log" });
  if (!list.length) host.append(el("div", { class: "op queued", text: "No operations yet." }));
  for (const operation of list) {
    const appliedBy = [a, b].filter((client) => client.log.some((entry) => entry.id === operation.id)).map((client) => client.id);
    host.append(el("div", { class: "op" },
      el("span", { class: "id", text: operation.id }),
      el("span", { class: "arrow", text: "·" }),
      el("span", { text: operation.client }),
      el("span", { class: "field", text: operation.field }),
      el("span", { text: "=" }),
      el("span", { class: "val", text: JSON.stringify(operation.value) }),
      el("span", { class: "arrow", text: "→" }),
      el("span", { class: "id", text: appliedBy.join("+") })));
  }
  return host;
}

function stateCard() {
  const merged = converged(a, b);
  const snap = a.snapshot();
  return el("div", { class: "card state-card" },
    el("h3", { text: "Engine state" }),
    el("div", { class: "kv-row" }, el("span", { text: "Documents agree" }), el("span", { style: `color:${merged ? "var(--green)" : "var(--red)"}`, text: merged ? "yes" : "no" })),
    el("div", { class: "kv-row" }, el("span", { text: "Transport" }), el("span", { text: bus.isPartitioned() ? "partitioned" : "connected" })),
    el("div", { class: "kv-row" }, el("span", { text: "Pending at bus" }), el("span", { text: String(bus.pending().reduce((sum, item) => sum + item.count, 0)) })),
    el("div", { class: "kv-row" }, el("span", { text: "A clock" }), el("span", { text: a.clockLabel() || "{}" })),
    el("div", { class: "kv-row" }, el("span", { text: "B clock" }), el("span", { text: b.clockLabel() || "{}" })),
    el("div", { class: "kv-row" }, el("span", { text: "A snapshot" }), el("span", { text: `${snap.doc.title}` })),
    el("div", { class: "legend" },
      el("span", {}, el("i", { style: "background:var(--gold)" }), "queued"),
      el("span", {}, el("i", { style: "background:var(--blue)" }), "field"),
      el("span", {}, el("i", { style: "background:var(--green)" }), "value")));
}

function render() {
  const main = $("#view");
  main.innerHTML = "";
  const netBadge = $("#net-badge");
  netBadge.innerHTML = `<span class="dot" style="color:${bus.isPartitioned() ? "var(--red)" : "var(--green)"}"></span> ${bus.isPartitioned() ? "network partitioned" : "network up"}`;
  $$("[data-nav]").forEach((link) => link.classList.toggle("active", link.dataset.nav === state.view));

  main.append(el("section", { class: "sk-hero" },
    el("div", {},
      el("div", { class: "eyebrow" }, "Offline-first sync engine · two clients"),
      el("h1", {}, "Two people edit the same document. ", el("em", { text: "Nobody loses a field." })),
      el("p", { class: "lede" }, "Both panels below are real clients running the same engine. The first view starts with the network already partitioned and conflicting edits made offline. Heal it, sync, and watch the vector clocks and field-level merge resolve the document."))));

  main.append(el("div", { class: "sk-toolbar" },
    el("button", { class: "btn primary", type: "button", text: bus.isPartitioned() ? "Heal and sync" : "Partition the network", onclick: toggleNetwork }),
    el("button", { class: "btn", type: "button", text: "Reset conflict", onclick: () => reset("conflict") }),
    el("span", { class: "spacer" }),
    el("span", { class: "note", text: "The same engine and transport run in the test suite; the convergence property test covers 30 random seeds." })));

  if (converged(a, b)) {
    main.append(el("div", { class: "converged-banner" },
      el("div", { class: "big", text: "converged" }),
      el("p", { text: `Both clients resolved to the same document. ${a.conflicts + b.conflicts} concurrent write(s) were settled deterministically by (timestamp, client id); different fields merged without conflict.` })));
  } else {
    main.append(el("div", { class: "conflict-banner" },
      el("div", { class: "big", text: "diverged" }),
      el("p", { text: `The clients have ${a.outbox.length + b.outbox.length} unsynced operation(s) between them. Nothing is lost: the operation log holds every edit and the clocks say which ones are concurrent.` })));
  }

  main.append(el("div", { class: "client-grid" },
    clientCard(a, "A", "A"),
    clientCard(b, "B", "B")));

  main.append(el("div", { class: "section-head" },
    el("h2", { text: "Operation log" }),
    el("p", { text: "Every edit becomes an operation with an id, a field, a value and a vector clock. Replaying an operation is a no-op." })));
  main.append(el("div", { class: "flow-grid" },
    el("div", { class: "card log-card" },
      el("h3", { text: `Shared operations · ${new Set([...a.log, ...b.log].map((op) => op.id)).size}` }),
      opsLog(),
      el("div", { class: "legend" },
        el("span", {}, "→ lists the clients that have applied the operation. A queued operation stays in the sender's outbox until the transport delivers it."))),
    stateCard()));

  main.append(footer());
}

function footer() {
  return el("footer", { class: "sk-footer" },
    el("span", { text: "SyncKit · vector clocks · LWW + field merge · MIT" }),
    el("span", { class: "spacer" }),
    el("a", { href: "https://arviontech.net", target: "_blank", rel: "noopener", text: "Arvion Technologies" }),
    el("a", { href: "https://github.com/arvion-technology/sync-kit", target: "_blank", rel: "noopener", text: "Source" }));
}

/* --------------------------------------------------------------- boot */

const route = () => location.hash.replace(/^#\/?/, "").split("/")[0] || "conflict";
window.addEventListener("hashchange", () => { state.view = route(); reset(state.view); });

boot();
state.view = route();
reset(state.view);
