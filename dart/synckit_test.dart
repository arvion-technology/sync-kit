import 'dart:convert';
import 'dart:io';

import 'synckit.dart';

/// Pure-Dart test for the port. Run with: dart dart/synckit_test.dart
var passed = 0;
final failures = <String>[];

void check(String label, void Function() body) {
  try {
    body();
    passed += 1;
  } catch (error) {
    failures.add('$label: $error');
  }
}

Never fail(String message) => throw StateError(message);

void expect(bool condition, String message) {
  if (!condition) fail(message);
}

bool mapEquals(Map<String, int> a, Map<String, int> b) =>
    a.length == b.length && a.entries.every((entry) => b[entry.key] == entry.value);

bool docEquals(Map<String, Object?> a, Map<String, Object?> b) =>
    a.length == b.length && a.entries.every((entry) => b[entry.key] == entry.value);

void main() {
  final vectors = jsonDecode(File('test/vectors/sync_vectors.json').readAsStringSync()) as Map<String, dynamic>;

  check('comparison matches the shared vectors', () {
    for (final item in (vectors['compare'] as List).cast<Map<String, dynamic>>()) {
      final a = (item['a'] as Map).cast<String, int>();
      final b = (item['b'] as Map).cast<String, int>();
      expect(compareClocks(a, b) == item['expected'], 'compare $a / $b');
    }
  });

  check('merge matches the shared vectors', () {
    for (final item in (vectors['merge'] as List).cast<Map<String, dynamic>>()) {
      final clocks = (item['clocks'] as List).map((clock) => (clock as Map).cast<String, int>());
      final merged = mergeClocks(clocks);
      final expected = (item['expected'] as Map).cast<String, int>();
      expect(mapEquals(merged, expected), 'merge $clocks');
    }
  });

  check('applying operations matches the shared vectors', () {
    for (final item in (vectors['apply'] as List).cast<Map<String, dynamic>>()) {
      final document = LwwDocument(doc: (item['doc'] as Map).cast<String, Object?>());
      for (final operation in (item['ops'] as List).cast<Map<String, dynamic>>()) {
        document.apply(operation);
      }
      final expected = (item['expected'] as Map).cast<String, Object?>();
      expect(docEquals(document.doc, expected), 'apply ${item['doc']}');
    }
  });

  check('increment never moves backwards', () {
    var clock = <String, int>{};
    clock = incrementClock(clock, 'a');
    clock = incrementClock(clock, 'a');
    expect(clock['a'] == 2, 'counter');
    var threw = false;
    try {
      incrementClock(clock, '');
    } on ArgumentError {
      threw = true;
    }
    expect(threw, 'an empty client id must throw');
  });

  check('a duplicate operation is a no-op', () {
    final document = LwwDocument();
    final operation = {
      'id': 'a-1', 'client': 'a', 'field': 'title', 'value': 'One', 'ts': 1, 'clock': {'a': 1},
    };
    final first = document.apply(operation);
    final second = document.apply(operation);
    expect(first.applied, 'first should apply');
    expect(!second.applied && second.reason == 'duplicate', 'second should be a duplicate');
    expect(document.log.length == 1, 'log must not grow');
  });

  check('concurrent fields merge and concurrent same-field edits tie-break', () {
    final document = LwwDocument();
    document.apply({'id': 'a-1', 'client': 'a', 'field': 'title', 'value': 'A', 'ts': 1, 'clock': {'a': 1}});
    document.apply({'id': 'b-1', 'client': 'b', 'field': 'title', 'value': 'B', 'ts': 1, 'clock': {'b': 1}});
    document.apply({'id': 'b-2', 'client': 'b', 'field': 'notes', 'value': 'B note', 'ts': 2, 'clock': {'b': 2}});
    expect(document.doc['title'] == 'B', 'client id breaks the tie');
    expect(document.doc['notes'] == 'B note', 'other field applies');
  });

  check('snapshot carries the clock', () {
    final document = LwwDocument();
    document.apply({'id': 'a-1', 'client': 'a', 'field': 'done', 'value': true, 'ts': 1, 'clock': {'a': 1}});
    final snapshot = document.snapshot();
    expect((snapshot['clock'] as Map)['a'] == 1, 'clock is in the snapshot');
  });

  stdout.writeln('synckit dart: $passed passed, ${failures.length} failed');
  for (final failure in failures) {
    stdout.writeln('  FAIL $failure');
  }
  if (failures.isNotEmpty) exitCode = 1;
}
