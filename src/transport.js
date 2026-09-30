/**
 * In-memory transport with network partitions.
 *
 * The engine talks to a transport interface: register a handler, post operations,
 * partition, heal. The in-memory implementation is used by the demo and the tests;
 * a WebSocket or HTTP transport implements the same three methods.
 */
export function createBus() {
  const handlers = new Map();
  const queues = new Map();
  const flow = [];
  let partitioned = false;

  function enqueue(to, from, operations) {
    if (!queues.has(to)) queues.set(to, []);
    queues.get(to).push({ from, operations });
  }

  function flushQueue(to) {
    const pending = queues.get(to);
    if (!pending) return 0;
    let delivered = 0;
    while (pending.length) {
      const { from, operations } = pending.shift();
      const handler = handlers.get(to);
      if (!handler) { pending.unshift({ from, operations }); break; }
      handler(operations);
      flow.push({ from, to, count: operations.length, partitioned: true });
      delivered += operations.length;
    }
    return delivered;
  }

  return {
    register(clientId, handler) {
      handlers.set(clientId, handler);
      // A client that registers after a partition is healed should get its mail.
      flushQueue(clientId);
    },

    /** Post operations from one client to everyone else. */
    post(from, operations) {
      if (!operations.length) return { delivered: 0, queued: 0 };
      let delivered = 0;
      let queued = 0;
      for (const to of handlers.keys()) {
        if (to === from) continue;
        if (partitioned) {
          enqueue(to, from, operations);
          queued += operations.length;
        } else {
          handlers.get(to)(operations);
          delivered += operations.length;
          flow.push({ from, to, count: operations.length, partitioned: false });
        }
      }
      return { delivered, queued };
    },

    partition() {
      partitioned = true;
    },

    heal() {
      partitioned = false;
      let delivered = 0;
      for (const client of handlers.keys()) delivered += flushQueue(client);
      return delivered;
    },

    isPartitioned: () => partitioned,
    flowLog: () => flow.map((entry) => ({ ...entry })),
    pending: () => [...queues.entries()].map(([to, items]) => ({
      to,
      count: items.reduce((sum, item) => sum + item.operations.length, 0),
    })),
    resetFlow() { flow.length = 0; },
  };
}
