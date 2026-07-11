import test from 'ava';
import * as Y from 'yjs';

import { readBoardFromBinary } from '../../core/doc/database-reader';
import { DatabaseWriter } from '../../core/doc/database-writer';
import {
  buildBoardDoc,
  DEFAULT_NOTE_BLOCK_ID,
  DEFAULT_PAGE_BLOCK_ID,
} from './fixtures/database-doc';

/**
 * In-memory stand-in for `PgWorkspaceDocStorageAdapter`, mutable this time
 * (unlike the read-only fakes in `database-writer-{columns,rows,kanban}.spec.ts`):
 * `pushDocUpdates` actually applies the pushed delta onto the stored bin, so
 * `getDoc` always returns the latest state and `createBoard`'s returned
 * `blockId` is directly readable via `readBoardFromBinary` without the
 * caller having to merge deltas manually.
 */
class FakeStorage {
  bin: Uint8Array;
  pushed: Uint8Array[] = [];

  constructor(initialBin: Uint8Array) {
    this.bin = initialBin;
  }

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

    const doc = new Y.Doc();
    Y.applyUpdate(doc, this.bin);
    for (const update of updates) {
      Y.applyUpdate(doc, update);
    }
    this.bin = Y.encodeStateAsUpdate(doc);

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

/** A page -> note doc with NO database block yet, for `createBoard` to append to. */
function buildEmptyNoteDoc(): Uint8Array {
  return buildBoardDoc({
    title: 'unused', // no database block is read by these tests pre-create
    columns: [{ id: 'placeholder', name: 'Title', type: 'title' }],
    rows: [],
    views: [],
  });
}

/** A page doc with no note block at all, to exercise createBoard's not-found path. */
function buildDocWithoutNote(): Uint8Array {
  const doc = new Y.Doc();
  const blocks = doc.getMap('blocks');
  doc.transact(() => {
    const page = new Y.Map<unknown>();
    page.set('sys:id', DEFAULT_PAGE_BLOCK_ID);
    page.set('sys:flavour', 'affine:page');
    page.set('sys:version', 1);
    page.set('sys:children', new Y.Array<string>());
    blocks.set(DEFAULT_PAGE_BLOCK_ID, page);
  });
  return Y.encodeStateAsUpdate(doc);
}

test('createBoard appends a new database block under the note with columns/rows/kanban view', async t => {
  const bin = buildEmptyNoteDoc();
  const { writer, storage } = makeWriter(bin);

  const { blockId } = await writer.createBoard('ws1', 'doc1', {
    title: 'Sprint Board',
    columns: [
      { name: 'Assignee', type: 'text' },
      {
        name: 'Priority',
        type: 'select',
        options: [{ value: 'High' }, { value: 'Low' }],
      },
    ],
    view: { mode: 'kanban', name: 'Board', groupByColumnName: 'Priority' },
    rows: [
      { title: 'Row 1', cells: { Assignee: 'Alice', Priority: 'High' } },
      { title: 'Row 2', cells: { Assignee: 'Bob' } },
    ],
  });

  t.truthy(blockId);
  t.is(storage.pushed.length, 1);

  // The stored bin (after pushDocUpdates applied the delta) is directly
  // readable - proving createBoard pushed a coherent, self-contained delta.
  const board = readBoardFromBinary(storage.bin, blockId);

  t.is(board.title, 'Sprint Board');

  // A title column is always ensured, even though none was in spec.columns.
  t.is(board.columns.length, 3);
  const titleColumn = board.columns.find(c => c.type === 'title');
  t.truthy(titleColumn);
  const assigneeColumn = board.columns.find(c => c.name === 'Assignee');
  t.is(assigneeColumn?.type, 'text');
  const priorityColumn = board.columns.find(c => c.name === 'Priority');
  t.is(priorityColumn?.type, 'select');
  t.deepEqual(
    priorityColumn?.options?.map(o => o.value),
    ['High', 'Low']
  );

  t.is(board.rows.length, 2);
  const row1 = board.rows.find(r => r.title === 'Row 1');
  t.is(row1?.cells[assigneeColumn!.id], 'Alice');
  t.is(row1?.cells[priorityColumn!.id], 'High');
  const row2 = board.rows.find(r => r.title === 'Row 2');
  // row2 was created with only its Assignee cell set...
  t.is(row2?.cells[assigneeColumn!.id], 'Bob');
  // ...so its unset Priority (select) cell decodes to null.
  t.is(row2?.cells[priorityColumn!.id], null);

  t.is(board.views.length, 1);
  const view = board.views[0];
  t.is(view.mode, 'kanban');
  t.is(view.name, 'Board');
  t.is(view.groupByColumnId, priorityColumn!.id);
  const highGroup = view.groups?.find(g => g.value === 'High');
  t.truthy(highGroup);
  t.true(highGroup?.cardRowIds.includes(row1!.rowId));

  // The new block is a child of the note block.
  const noteDoc = new Y.Doc();
  Y.applyUpdate(noteDoc, storage.bin);
  const note = noteDoc
    .getMap('blocks')
    .get(DEFAULT_NOTE_BLOCK_ID) as Y.Map<unknown>;
  const noteChildren = (note.get('sys:children') as Y.Array<string>).toArray();
  t.true(noteChildren.includes(blockId));
});

test('createBoard with mode "table" creates no group column and a table view', async t => {
  const bin = buildEmptyNoteDoc();
  const { writer, storage } = makeWriter(bin);

  const { blockId } = await writer.createBoard('ws1', 'doc1', {
    title: 'Table Board',
    columns: [{ name: 'Notes', type: 'text' }],
    view: { mode: 'table', name: 'All items' },
  });

  const board = readBoardFromBinary(storage.bin, blockId);

  // Title + Notes only - no Status/group column auto-created for table mode.
  t.is(board.columns.length, 2);
  t.is(board.views.length, 1);
  const view = board.views[0];
  t.is(view.mode, 'table');
  t.is(view.name, 'All items');
  t.falsy(view.groupByColumnId);
});

test('createBoard kanban view with no matching groupByColumnName creates a default Status select column', async t => {
  const bin = buildEmptyNoteDoc();
  const { writer, storage } = makeWriter(bin);

  const { blockId } = await writer.createBoard('ws1', 'doc1', {
    title: 'Board',
    columns: [{ name: 'Notes', type: 'text' }],
    view: { mode: 'kanban' },
  });

  const board = readBoardFromBinary(storage.bin, blockId);
  const view = board.views[0];
  t.truthy(view.groupByColumnId);

  const statusColumn = board.columns.find(c => c.id === view.groupByColumnId);
  t.is(statusColumn?.name, 'Status');
  t.is(statusColumn?.type, 'select');
  t.deepEqual(
    statusColumn?.options?.map(o => o.value),
    ['Todo', 'In Progress', 'Done']
  );
});

test('createBoard throws when the document has no note block', async t => {
  const bin = buildDocWithoutNote();
  const { writer } = makeWriter(bin);

  await t.throwsAsync(
    () =>
      writer.createBoard('ws1', 'doc1', {
        title: 'Board',
        columns: [],
        view: { mode: 'table' },
      }),
    { message: /no note block/ }
  );
});

test('createBoard pushes a genuine incremental delta, not a full doc snapshot', async t => {
  const bin = buildEmptyNoteDoc();
  const { writer, storage } = makeWriter(bin);

  await writer.createBoard('ws1', 'doc1', {
    title: 'Board',
    columns: [{ name: 'Notes', type: 'text' }],
    view: { mode: 'table' },
  });

  const delta = storage.pushed[0];
  t.true(delta.length < storage.bin.length);

  // Round-trip check: applying the delta onto a FRESH copy of the original
  // bin (not storage's internally-merged doc) reproduces the same board.
  const merged = new Y.Doc();
  Y.applyUpdate(merged, bin);
  Y.applyUpdate(merged, delta);
  const mergedBin = Y.encodeStateAsUpdate(merged);

  const rebuiltBoard = readBoardFromBinary(
    mergedBin,
    // any database block id present only in the merged doc - locate it via
    // the blocks map directly since we don't have it in scope here.
    [...merged.getMap('blocks').entries()].find(
      ([, block]) =>
        (block as Y.Map<unknown>).get('sys:flavour') === 'affine:database' &&
        (block as Y.Map<unknown>).get('sys:id') !== 'db1'
    )![0]
  );
  t.is(rebuiltBoard.title, 'Board');
});
