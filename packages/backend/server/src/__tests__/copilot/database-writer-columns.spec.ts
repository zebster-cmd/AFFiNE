import test from 'ava';
import * as Y from 'yjs';

import { readBoardFromBinary } from '../../core/doc/database-reader';
import { DatabaseWriter } from '../../core/doc/database-writer';
import {
  buildBoardDoc,
  DEFAULT_DATABASE_BLOCK_ID,
} from './fixtures/database-doc';

/**
 * Minimal in-memory stand-in for `PgWorkspaceDocStorageAdapter`, just the
 * two methods `DatabaseWriter` calls. Captures pushed deltas for assertions.
 */
class FakeStorage {
  pushed: Uint8Array[] = [];

  constructor(private readonly bin: Uint8Array) {}

  async getDoc(_workspaceId: string, _docId: string) {
    return {
      spaceId: _workspaceId,
      docId: _docId,
      bin: this.bin,
      timestamp: Date.now(),
    };
  }

  async pushDocUpdates(
    _workspaceId: string,
    _docId: string,
    updates: Uint8Array[],
    _editorId?: string
  ) {
    this.pushed.push(...updates);
    return Date.now();
  }
}

/** Minimal stand-in for `EventBus`, just capturing emitted events. */
class FakeEventBus {
  emitted: { event: string; payload: unknown }[] = [];

  emit(event: string, payload: unknown) {
    this.emitted.push({ event, payload });
  }
}

function makeWriter(bin: Uint8Array) {
  const storage = new FakeStorage(bin);
  const event = new FakeEventBus();
  // Cast: the fakes only implement the two methods/one method DatabaseWriter
  // actually calls, not the full adapter/EventBus surface.
  const writer = new DatabaseWriter(storage as any, event as any);
  return { writer, storage, event };
}

/**
 * Applies `delta` onto a fresh copy of the ORIGINAL `bin` and re-encodes the
 * full state. Used to prove `delta` is a genuine incremental diff (must be
 * smaller than this full re-encode) rather than e.g. a full doc snapshot -
 * this is the regression guard for the Yjs plain-object-mutation caveat.
 */
function mergeDeltaOntoOriginal(
  bin: Uint8Array,
  delta: Uint8Array
): Uint8Array {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, bin);
  Y.applyUpdate(doc, delta);
  return Y.encodeStateAsUpdate(doc);
}

test('applyOps add_column appends a new column visible via readBoardFromBinary', async t => {
  const bin = buildBoardDoc({
    title: 'Board',
    columns: [{ id: 'c_title', name: 'Title', type: 'title' }],
    rows: [],
    views: [],
  });

  const { writer, storage, event } = makeWriter(bin);
  await writer.applyOps('ws1', 'doc1', DEFAULT_DATABASE_BLOCK_ID, [
    {
      op: 'add_column',
      name: 'Status',
      type: 'select',
      options: [{ value: 'Todo', color: 'red' }],
    },
  ]);

  t.is(storage.pushed.length, 1);
  t.is(event.emitted.length, 1);
  t.is(event.emitted[0].event, 'doc.updates.pushed');

  const delta = storage.pushed[0];
  const merged = mergeDeltaOntoOriginal(bin, delta);

  const board = readBoardFromBinary(merged, DEFAULT_DATABASE_BLOCK_ID);
  t.is(board.columns.length, 2);
  const added = board.columns[1];
  t.is(added.name, 'Status');
  t.is(added.type, 'select');
  t.deepEqual(
    added.options?.map(o => o.value),
    ['Todo']
  );
  t.truthy(added.id);

  // The pushed delta must be a genuine incremental diff, not a full re-encode.
  t.true(delta.length < merged.length);
});

test('applyOps update_column renames a column and replaces its options', async t => {
  const bin = buildBoardDoc({
    title: 'Board',
    columns: [
      { id: 'c_title', name: 'Title', type: 'title' },
      {
        id: 'c_status',
        name: 'Status',
        type: 'select',
        options: [{ id: 'o_todo', value: 'Todo', color: 'red' }],
      },
    ],
    rows: [],
    views: [],
  });

  const { writer, storage } = makeWriter(bin);
  await writer.applyOps('ws1', 'doc1', DEFAULT_DATABASE_BLOCK_ID, [
    {
      op: 'update_column',
      columnId: 'c_status',
      name: 'Stage',
      options: [
        { id: 'o_todo', value: 'Todo', color: 'red' },
        { value: 'Done', color: 'green' },
      ],
    },
  ]);

  const delta = storage.pushed[0];
  const merged = mergeDeltaOntoOriginal(bin, delta);

  const board = readBoardFromBinary(merged, DEFAULT_DATABASE_BLOCK_ID);
  const status = board.columns.find(c => c.id === 'c_status');
  t.is(status?.name, 'Stage');
  t.deepEqual(
    status?.options?.map(o => o.value),
    ['Todo', 'Done']
  );
  // The pre-existing option keeps its id; the new one gets a fresh one.
  t.is(status?.options?.[0].id, 'o_todo');
  t.not(status?.options?.[1].id, undefined);

  t.true(delta.length < merged.length);
});

test('applyOps delete_column removes the column and purges its cells from every row', async t => {
  const bin = buildBoardDoc({
    title: 'Board',
    columns: [
      { id: 'c_title', name: 'Title', type: 'title' },
      { id: 'c_notes', name: 'Notes', type: 'text' },
    ],
    rows: [
      { rowId: 'r1', title: 'Row 1', cells: { c_notes: 'hello' } },
      { rowId: 'r2', title: 'Row 2', cells: { c_notes: 'world' } },
    ],
    views: [],
  });

  const { writer, storage } = makeWriter(bin);
  await writer.applyOps('ws1', 'doc1', DEFAULT_DATABASE_BLOCK_ID, [
    { op: 'delete_column', columnId: 'c_notes' },
  ]);

  const delta = storage.pushed[0];
  const merged = mergeDeltaOntoOriginal(bin, delta);

  const board = readBoardFromBinary(merged, DEFAULT_DATABASE_BLOCK_ID);
  t.is(
    board.columns.find(c => c.id === 'c_notes'),
    undefined
  );
  t.deepEqual(board.rows[0].cells, {});
  t.deepEqual(board.rows[1].cells, {});

  t.true(delta.length < merged.length);
});

test('applyOps throws for a database op not yet implemented', async t => {
  const bin = buildBoardDoc({
    title: 'Board',
    columns: [{ id: 'c_title', name: 'Title', type: 'title' }],
    rows: [],
    views: [],
  });

  const { writer } = makeWriter(bin);
  await t.throwsAsync(() =>
    writer.applyOps('ws1', 'doc1', DEFAULT_DATABASE_BLOCK_ID, [
      { op: 'add_row', title: 'New row' },
    ])
  );
});

test('applyOps throws when the target block is not a database', async t => {
  const bin = buildBoardDoc({
    title: 'Board',
    columns: [{ id: 'c_title', name: 'Title', type: 'title' }],
    rows: [],
    views: [],
  });

  const { writer } = makeWriter(bin);
  await t.throwsAsync(() =>
    writer.applyOps('ws1', 'doc1', 'not-a-block', [
      { op: 'add_column', name: 'Status', type: 'text' },
    ])
  );
});
