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

test('applyOps add_row with cells appends a row visible via readBoardFromBinary', async t => {
  const bin = buildBoardDoc({
    title: 'Board',
    columns: [
      { id: 'c_title', name: 'Title', type: 'title' },
      { id: 'c_notes', name: 'Notes', type: 'text' },
    ],
    rows: [],
    views: [],
  });

  const { writer, storage } = makeWriter(bin);
  await writer.applyOps('ws1', 'doc1', DEFAULT_DATABASE_BLOCK_ID, [
    {
      op: 'add_row',
      title: 'New row',
      cells: { c_notes: 'hello' },
    },
  ]);

  const delta = storage.pushed[0];
  const merged = mergeDeltaOntoOriginal(bin, delta);

  const board = readBoardFromBinary(merged, DEFAULT_DATABASE_BLOCK_ID);
  t.is(board.rows.length, 1);
  t.is(board.rows[0].title, 'New row');
  t.is(board.rows[0].cells.c_notes, 'hello');
  t.truthy(board.rows[0].rowId);

  t.true(delta.length < merged.length);
});

test('applyOps update_cell on the title column updates the row title, not a cells entry', async t => {
  const bin = buildBoardDoc({
    title: 'Board',
    columns: [
      { id: 'c_title', name: 'Title', type: 'title' },
      { id: 'c_notes', name: 'Notes', type: 'text' },
    ],
    rows: [{ rowId: 'r1', title: 'Original', cells: { c_notes: 'x' } }],
    views: [],
  });

  const { writer, storage } = makeWriter(bin);
  await writer.applyOps('ws1', 'doc1', DEFAULT_DATABASE_BLOCK_ID, [
    { op: 'update_cell', rowId: 'r1', columnId: 'c_title', value: 'Renamed' },
  ]);

  const delta = storage.pushed[0];
  const merged = mergeDeltaOntoOriginal(bin, delta);

  const board = readBoardFromBinary(merged, DEFAULT_DATABASE_BLOCK_ID);
  const row = board.rows.find(r => r.rowId === 'r1');
  t.is(row?.title, 'Renamed');
  t.is(row?.cells.c_title, undefined);
  t.is(row?.cells.c_notes, 'x');

  t.true(delta.length < merged.length);
});

test('applyOps update_cell on a select column with a new option value survives the delta round-trip', async t => {
  const bin = buildBoardDoc({
    title: 'Board',
    columns: [
      { id: 'c_title', name: 'Title', type: 'title' },
      {
        id: 'c_status',
        name: 'Status',
        type: 'select',
        options: [{ id: 'o_todo', value: 'Todo' }],
      },
    ],
    rows: [{ rowId: 'r1', title: 'Row 1', cells: {} }],
    views: [],
  });

  const { writer, storage } = makeWriter(bin);
  await writer.applyOps('ws1', 'doc1', DEFAULT_DATABASE_BLOCK_ID, [
    { op: 'update_cell', rowId: 'r1', columnId: 'c_status', value: 'Done' },
  ]);

  const delta = storage.pushed[0];
  // Apply the delta onto the ORIGINAL (not the writer's internal doc) to
  // prove the option-auto-create propagates through the incremental delta
  // alone - this is the caveat guard.
  const merged = mergeDeltaOntoOriginal(bin, delta);

  const board = readBoardFromBinary(merged, DEFAULT_DATABASE_BLOCK_ID);
  const row = board.rows.find(r => r.rowId === 'r1');
  t.is(row?.cells.c_status, 'Done');

  const status = board.columns.find(c => c.id === 'c_status');
  t.deepEqual(
    status?.options?.map(o => o.value),
    ['Todo', 'Done']
  );

  t.true(delta.length < merged.length);
});

test('applyOps update_cell on a read-only column throws', async t => {
  const bin = buildBoardDoc({
    title: 'Board',
    columns: [
      { id: 'c_title', name: 'Title', type: 'title' },
      { id: 'c_created', name: 'Created', type: 'created-time' },
    ],
    rows: [{ rowId: 'r1', title: 'Row 1', cells: {} }],
    views: [],
  });

  const { writer } = makeWriter(bin);
  await t.throwsAsync(() =>
    writer.applyOps('ws1', 'doc1', DEFAULT_DATABASE_BLOCK_ID, [
      {
        op: 'update_cell',
        rowId: 'r1',
        columnId: 'c_created',
        value: 12345,
      },
    ])
  );
});

test('applyOps update_cell on a non-title column with a nonexistent rowId throws NotFoundException', async t => {
  const bin = buildBoardDoc({
    title: 'Board',
    columns: [
      { id: 'c_title', name: 'Title', type: 'title' },
      { id: 'c_notes', name: 'Notes', type: 'text' },
    ],
    rows: [{ rowId: 'r1', title: 'Row 1', cells: {} }],
    views: [],
  });

  const { writer } = makeWriter(bin);
  await t.throwsAsync(() =>
    writer.applyOps('ws1', 'doc1', DEFAULT_DATABASE_BLOCK_ID, [
      {
        op: 'update_cell',
        rowId: 'does-not-exist',
        columnId: 'c_notes',
        value: 'hello',
      },
    ])
  );
});

test('applyOps delete_row removes the row, its block, and its cells', async t => {
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
    { op: 'delete_row', rowId: 'r1' },
  ]);

  const delta = storage.pushed[0];
  const merged = mergeDeltaOntoOriginal(bin, delta);

  const board = readBoardFromBinary(merged, DEFAULT_DATABASE_BLOCK_ID);
  t.is(board.rows.length, 1);
  t.is(board.rows[0].rowId, 'r2');

  const doc = new Y.Doc();
  Y.applyUpdate(doc, merged);
  const blocks = doc.getMap('blocks');
  t.falsy(blocks.get('r1'));

  const db = blocks.get(DEFAULT_DATABASE_BLOCK_ID) as Y.Map<unknown>;
  const cells = db.get('prop:cells') as Y.Map<unknown>;
  t.falsy(cells.get('r1'));

  t.true(delta.length < merged.length);
});
