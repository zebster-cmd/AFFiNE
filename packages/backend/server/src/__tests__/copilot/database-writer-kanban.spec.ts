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
 * this is the regression guard for the Yjs plain-object-mutation caveat,
 * which also applies to `prop:views` entries (see `move_card` below).
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

test('applyOps add_view kanban with no groupByColumnId creates a default Status select column', async t => {
  const bin = buildBoardDoc({
    title: 'Board',
    columns: [{ id: 'c_title', name: 'Title', type: 'title' }],
    rows: [],
    views: [],
  });

  const { writer, storage } = makeWriter(bin);
  await writer.applyOps('ws1', 'doc1', DEFAULT_DATABASE_BLOCK_ID, [
    { op: 'add_view', mode: 'kanban' },
  ]);

  const delta = storage.pushed[0];
  const merged = mergeDeltaOntoOriginal(bin, delta);
  const board = readBoardFromBinary(merged, DEFAULT_DATABASE_BLOCK_ID);

  t.is(board.views.length, 1);
  const view = board.views[0];
  t.is(view.mode, 'kanban');
  t.truthy(view.groupByColumnId);

  const statusColumn = board.columns.find(c => c.id === view.groupByColumnId);
  t.is(statusColumn?.name, 'Status');
  t.is(statusColumn?.type, 'select');
  t.deepEqual(
    statusColumn?.options?.map(o => o.value),
    ['Todo', 'In Progress', 'Done']
  );

  t.true(delta.length < merged.length);
});

test('applyOps add_view kanban with an existing select column reuses it (no new column)', async t => {
  const bin = buildBoardDoc({
    title: 'Board',
    columns: [
      { id: 'c_title', name: 'Title', type: 'title' },
      {
        id: 'c_stage',
        name: 'Stage',
        type: 'select',
        options: [{ id: 'o_backlog', value: 'Backlog' }],
      },
    ],
    rows: [],
    views: [],
  });

  const { writer, storage } = makeWriter(bin);
  await writer.applyOps('ws1', 'doc1', DEFAULT_DATABASE_BLOCK_ID, [
    {
      op: 'add_view',
      mode: 'kanban',
      name: 'Pipeline',
      groupByColumnId: 'c_stage',
    },
  ]);

  const delta = storage.pushed[0];
  const merged = mergeDeltaOntoOriginal(bin, delta);
  const board = readBoardFromBinary(merged, DEFAULT_DATABASE_BLOCK_ID);

  t.is(board.columns.length, 2); // no new column was created
  const view = board.views.find(v => v.name === 'Pipeline');
  t.is(view?.mode, 'kanban');
  t.is(view?.groupByColumnId, 'c_stage');

  t.true(delta.length < merged.length);
});

test('applyOps add_view with mode "table" does not set a group column', async t => {
  const bin = buildBoardDoc({
    title: 'Board',
    columns: [{ id: 'c_title', name: 'Title', type: 'title' }],
    rows: [],
    views: [],
  });

  const { writer, storage } = makeWriter(bin);
  await writer.applyOps('ws1', 'doc1', DEFAULT_DATABASE_BLOCK_ID, [
    { op: 'add_view', mode: 'table', name: 'All items' },
  ]);

  const delta = storage.pushed[0];
  const merged = mergeDeltaOntoOriginal(bin, delta);
  const board = readBoardFromBinary(merged, DEFAULT_DATABASE_BLOCK_ID);

  t.is(board.columns.length, 1); // no Status column created for a table view
  const view = board.views.find(v => v.name === 'All items');
  t.is(view?.mode, 'table');
  t.falsy(view?.groupByColumnId);
});

test('applyOps move_card sets the card group cell and places it in the target group order', async t => {
  const bin = buildBoardDoc({
    title: 'Board',
    columns: [
      { id: 'c_title', name: 'Title', type: 'title' },
      {
        id: 'c_stage',
        name: 'Stage',
        type: 'select',
        options: [
          { id: 'o_todo', value: 'Todo' },
          { id: 'o_done', value: 'Done' },
        ],
      },
    ],
    rows: [
      { rowId: 'r1', title: 'Row 1', cells: { c_stage: 'o_todo' } },
      { rowId: 'r2', title: 'Row 2', cells: { c_stage: 'o_done' } },
    ],
    views: [
      { id: 'v1', name: 'Board', mode: 'kanban', groupByColumnId: 'c_stage' },
    ],
  });

  const { writer, storage } = makeWriter(bin);
  await writer.applyOps('ws1', 'doc1', DEFAULT_DATABASE_BLOCK_ID, [
    { op: 'move_card', rowId: 'r1', toGroupValue: 'Done' },
  ]);

  const delta = storage.pushed[0];
  // Applied onto the ORIGINAL bin (not the writer's internal doc), proving
  // the view's groupProperties mutation survives the incremental delta
  // alone - the regression guard for the plain-object-in-Y.Array caveat as
  // it applies to prop:views (a view element must be replaced, not mutated
  // in place, exactly like prop:columns).
  const merged = mergeDeltaOntoOriginal(bin, delta);
  const board = readBoardFromBinary(merged, DEFAULT_DATABASE_BLOCK_ID);

  const row = board.rows.find(r => r.rowId === 'r1');
  t.is(row?.cells.c_stage, 'Done');

  const view = board.views.find(v => v.id === 'v1');
  const doneGroup = view?.groups?.find(g => g.value === 'Done');
  t.truthy(doneGroup);
  t.true(doneGroup?.cardRowIds.includes('r1'));

  // r1 must no longer be listed under Todo. Once its last card leaves, the
  // Todo bucket has no rows, so the reader (groups are built from occupied row
  // buckets) omits the group entirely and todoGroup is undefined. Either way,
  // r1 must not appear under Todo.
  const todoGroup = view?.groups?.find(g => g.value === 'Todo');
  t.falsy(todoGroup?.cardRowIds.includes('r1'));

  t.true(delta.length < merged.length);
});

test('applyOps move_card to a brand-new group value auto-creates the select option', async t => {
  const bin = buildBoardDoc({
    title: 'Board',
    columns: [
      { id: 'c_title', name: 'Title', type: 'title' },
      {
        id: 'c_stage',
        name: 'Stage',
        type: 'select',
        options: [{ id: 'o_todo', value: 'Todo' }],
      },
    ],
    rows: [{ rowId: 'r1', title: 'Row 1', cells: { c_stage: 'o_todo' } }],
    views: [
      { id: 'v1', name: 'Board', mode: 'kanban', groupByColumnId: 'c_stage' },
    ],
  });

  const { writer, storage } = makeWriter(bin);
  await writer.applyOps('ws1', 'doc1', DEFAULT_DATABASE_BLOCK_ID, [
    { op: 'move_card', rowId: 'r1', toGroupValue: 'Blocked' },
  ]);

  const delta = storage.pushed[0];
  const merged = mergeDeltaOntoOriginal(bin, delta);
  const board = readBoardFromBinary(merged, DEFAULT_DATABASE_BLOCK_ID);

  const stageColumn = board.columns.find(c => c.id === 'c_stage');
  t.deepEqual(
    stageColumn?.options?.map(o => o.value),
    ['Todo', 'Blocked']
  );

  const row = board.rows.find(r => r.rowId === 'r1');
  t.is(row?.cells.c_stage, 'Blocked');

  const view = board.views.find(v => v.id === 'v1');
  const blockedGroup = view?.groups?.find(g => g.value === 'Blocked');
  t.truthy(blockedGroup);
  t.true(blockedGroup?.cardRowIds.includes('r1'));

  t.true(delta.length < merged.length);
});

test('applyOps move_card throws when the board has no kanban view', async t => {
  const bin = buildBoardDoc({
    title: 'Board',
    columns: [
      { id: 'c_title', name: 'Title', type: 'title' },
      {
        id: 'c_stage',
        name: 'Stage',
        type: 'select',
        options: [{ id: 'o_todo', value: 'Todo' }],
      },
    ],
    rows: [{ rowId: 'r1', title: 'Row 1', cells: { c_stage: 'o_todo' } }],
    views: [{ id: 'v1', name: 'Table', mode: 'table' }],
  });

  const { writer } = makeWriter(bin);
  await t.throwsAsync(() =>
    writer.applyOps('ws1', 'doc1', DEFAULT_DATABASE_BLOCK_ID, [
      { op: 'move_card', rowId: 'r1', toGroupValue: 'Done' },
    ])
  );
});

test('applyOps move_card throws for a nonexistent rowId', async t => {
  const bin = buildBoardDoc({
    title: 'Board',
    columns: [
      { id: 'c_title', name: 'Title', type: 'title' },
      {
        id: 'c_stage',
        name: 'Stage',
        type: 'select',
        options: [{ id: 'o_todo', value: 'Todo' }],
      },
    ],
    rows: [],
    views: [
      { id: 'v1', name: 'Board', mode: 'kanban', groupByColumnId: 'c_stage' },
    ],
  });

  const { writer } = makeWriter(bin);
  await t.throwsAsync(() =>
    writer.applyOps('ws1', 'doc1', DEFAULT_DATABASE_BLOCK_ID, [
      { op: 'move_card', rowId: 'does-not-exist', toGroupValue: 'Done' },
    ])
  );
});
