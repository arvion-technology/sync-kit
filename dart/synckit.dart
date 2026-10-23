/// SyncKit Dart port: vector clocks and the per-field LWW merge.
///
/// This is the Flutter-side implementation of the same rules as
/// `src/clock.js` and `src/engine.js`. Both sides read
/// `test/vectors/sync_vectors.json` so a rule change breaks both test suites.
library synckit;

/// Compare two vector clocks. Returns `equal`, `before`, `after` or `concurrent`.
String compareClocks(Map<String, int> a, Map<String, int> b) {
  var aGreater = false;
  var bGreater = false;
  final clients = {...a.keys, ...b.keys};
  for (final client in clients) {
    final left = a[client] ?? 0;
    final right = b[client] ?? 0;
    if (left > right) {
      aGreater = true;
    } else if (right > left) {
      bGreater = true;
    }
  }
  if (!aGreater && !bGreater) return 'equal';
  if (aGreater && !bGreater) return 'after';
  if (!aGreater && bGreater) return 'before';
  return 'concurrent';
}

Map<String, int> mergeClocks(Iterable<Map<String, int>> clocks) {
  final merged = <String, int>{};
  for (final clock in clocks) {
    for (final entry in clock.entries) {
      final current = merged[entry.key] ?? 0;
      if (entry.value > current) merged[entry.key] = entry.value;
    }
  }
  return merged;
}

Map<String, int> incrementClock(Map<String, int> clock, String client) {
  if (client.isEmpty) throw ArgumentError('increment needs a client id');
  return {...clock, client: (clock[client] ?? 0) + 1};
}

class FieldMeta {
  const FieldMeta({required this.ts, required this.client, required this.clock});
  final int ts;
  final String client;
  final Map<String, int> clock;
}

class MergeResult {
  const MergeResult({required this.applied, required this.reason, this.conflict = false});
  final bool applied;
  final String reason;
  final bool conflict;
}

/// A last-writer-wins document keyed by field with per-field vector metadata.
class LwwDocument {
  LwwDocument({Map<String, Object?>? doc})
      : _doc = {
          'title': '',
          'done': false,
          'assignee': '',
          'notes': '',
          ...?doc,
        };

  final Map<String, Object?> _doc;
  final Map<String, FieldMeta> _fields = {};
  final Set<String> _seen = {};
  final List<Map<String, Object?>> _log = [];
  Map<String, int> _clock = {};

  Map<String, Object?> get doc => Map.unmodifiable(_doc);
  Map<String, int> get clock => Map.unmodifiable(_clock);
  List<Map<String, Object?>> get log => List.unmodifiable(_log);

  MergeResult apply(Map<String, Object?> operation) {
    final id = operation['id'] as String?;
    if (id == null) throw ArgumentError('operation needs an id');
    if (_seen.contains(id)) {
      return const MergeResult(applied: false, reason: 'duplicate');
    }
    _seen.add(id);
    _log.add(Map.of(operation));
    final opClock = (operation['clock'] as Map).cast<String, int>();
    _clock = mergeClocks([_clock, opClock]);

    final field = operation['field'] as String;
    final ts = operation['ts'] as int;
    final client = operation['client'] as String;
    final meta = _fields[field];
    var conflict = false;

    if (meta != null) {
      final relation = compareClocks(opClock, meta.clock);
      if (relation == 'before' || relation == 'equal') {
        return const MergeResult(applied: false, reason: 'stale');
      }
      if (relation == 'concurrent') conflict = true;
      if (meta.ts > ts || (meta.ts == ts && meta.client.compareTo(client) > 0)) {
        return MergeResult(applied: false, reason: 'loses the tie-break', conflict: conflict);
      }
    }

    _doc[field] = operation['value'];
    _fields[field] = FieldMeta(ts: ts, client: client, clock: opClock);
    return MergeResult(applied: true, reason: 'applied', conflict: conflict);
  }

  Map<String, Object?> snapshot() => {
        'doc': Map.of(_doc),
        'clock': Map.of(_clock),
      };
}

Map<String, int> castClock(Map<String, Object?> value) =>
    value.map((key, counter) => MapEntry(key, counter as int));
