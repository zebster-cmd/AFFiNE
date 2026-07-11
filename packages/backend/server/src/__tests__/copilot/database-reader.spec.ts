import test from 'ava';
import * as Y from 'yjs';

import {
  listBoardsFromBinary,
  readBoardFromBinary,
} from '../../core/doc/database-reader';
import {
  buildBoardDoc,
  DEFAULT_DATABASE_BLOCK_ID,
} from './fixtures/database-doc';

test('readBoardFromBinary projects columns, rows, and views from a table board', t => {
  const bin = buildBoardDoc({
    title: 'Sprint Board',
    columns: [
      { id: 'c_title', name: 'Title', type: 'title' },
      {
        id: 'c_status',
        name: 'Status',
        type: 'select',
        options: [
          { id: 'o_todo', value: 'Todo', color: 'red' },
          { id: 'o_done', value: 'Done', color: 'green' },
        ],
      },
      { id: 'c_notes', name: 'Notes', type: 'text' },
    ],
    rows: [
      {
        rowId: 'r1',
        title: 'Write spec',
        cells: { c_status: 'o_todo', c_notes: 'draft' },
      },
      {
        rowId: 'r2',
        title: 'Ship it',
        cells: { c_status: 'o_done', c_notes: '' },
      },
    ],
    views: [{ id: 'v1', name: 'Table', mode: 'table' }],
  });

  const board = readBoardFromBinary(bin, DEFAULT_DATABASE_BLOCK_ID);

  t.is(board.blockId, DEFAULT_DATABASE_BLOCK_ID);
  t.is(board.title, 'Sprint Board');
  t.deepEqual(board.columns, [
    { id: 'c_title', name: 'Title', type: 'title' },
    {
      id: 'c_status',
      name: 'Status',
      type: 'select',
      options: [
        { id: 'o_todo', value: 'Todo', color: 'red' },
        { id: 'o_done', value: 'Done', color: 'green' },
      ],
    },
    { id: 'c_notes', name: 'Notes', type: 'text' },
  ]);
  t.deepEqual(board.rows, [
    {
      rowId: 'r1',
      title: 'Write spec',
      cells: { c_status: 'Todo', c_notes: 'draft' },
    },
    {
      rowId: 'r2',
      title: 'Ship it',
      cells: { c_status: 'Done', c_notes: '' },
    },
  ]);
  t.deepEqual(board.views, [{ id: 'v1', name: 'Table', mode: 'table' }]);
});

test('readBoardFromBinary resolves kanban groups from a real nested groupBy object in child order when no groupProperties are stored', t => {
  const bin = buildBoardDoc({
    title: 'Board',
    columns: [
      { id: 'c_title', name: 'Title', type: 'title' },
      {
        id: 'c_status',
        name: 'Status',
        type: 'select',
        options: [
          { id: 'o_todo', value: 'Todo', color: 'red' },
          { id: 'o_doing', value: 'In Progress', color: 'yellow' },
          { id: 'o_done', value: 'Done', color: 'green' },
        ],
      },
    ],
    rows: [
      { rowId: 'r1', title: 'A', cells: { c_status: 'o_todo' } },
      { rowId: 'r2', title: 'B', cells: { c_status: 'o_doing' } },
      { rowId: 'r3', title: 'C', cells: { c_status: 'o_todo' } },
      { rowId: 'r4', title: 'D', cells: {} },
    ],
    views: [
      {
        id: 'v1',
        name: 'Board',
        mode: 'kanban',
        groupByColumnId: 'c_status',
      },
    ],
  });

  // Guard: the fixture must store the real BlockSuite `GroupBy` OBJECT, not a
  // flat column-id string — otherwise the reader's real-shape path is never
  // exercised. A flat string here would silently collapse every card into
  // one ungrouped bucket against a real editor board.
  const doc = new Y.Doc();
  Y.applyUpdate(doc, bin);
  const rawView = (
    (doc.getMap('blocks').get(DEFAULT_DATABASE_BLOCK_ID) as Y.Map<unknown>).get(
      'prop:views'
    ) as Y.Array<Record<string, unknown>>
  ).get(0);
  t.deepEqual(rawView.groupBy, {
    type: 'groupBy',
    columnId: 'c_status',
    name: 'Status',
  });

  const board = readBoardFromBinary(bin, DEFAULT_DATABASE_BLOCK_ID);
  const view = board.views[0];

  t.is(view.mode, 'kanban');
  // The tool-facing projection flattens groupBy back to just the column id.
  t.is(view.groupByColumnId, 'c_status');
  t.deepEqual(view.groups, [
    { value: 'Todo', cardRowIds: ['r1', 'r3'] },
    { value: 'In Progress', cardRowIds: ['r2'] },
    { value: '', cardRowIds: ['r4'] },
  ]);
});

test('readBoardFromBinary honors stored groupProperties ordering and manuallyCardSort within kanban groups', t => {
  const bin = buildBoardDoc({
    title: 'Board',
    columns: [
      { id: 'c_title', name: 'Title', type: 'title' },
      {
        id: 'c_status',
        name: 'Status',
        type: 'select',
        options: [
          { id: 'o_todo', value: 'Todo', color: 'red' },
          { id: 'o_doing', value: 'In Progress', color: 'yellow' },
        ],
      },
    ],
    rows: [
      { rowId: 'r1', title: 'A', cells: { c_status: 'o_todo' } },
      { rowId: 'r2', title: 'B', cells: { c_status: 'o_todo' } },
      { rowId: 'r3', title: 'C', cells: { c_status: 'o_doing' } },
    ],
    views: [
      {
        id: 'v1',
        name: 'Board',
        mode: 'kanban',
        groupByColumnId: 'c_status',
      },
    ],
  });

  // buildBoardDoc's BuildBoardDocSpec/ViewJSON has no field for seeding
  // `groupProperties` (it isn't part of Task 1's fixture), so patch it
  // directly into the doc the way a real BlockSuite kanban view stores it.
  // `prop:views` is a Y.Array of plain objects, so mutating the retrieved
  // element in place would not propagate (per the Task 2 writer caveat) —
  // delete + re-insert instead. The spread of `...view` preserves the
  // fixture's real nested `groupBy` object (`{ type, columnId, name }`), so
  // this test also runs against the real shape end-to-end.
  const doc = new Y.Doc();
  Y.applyUpdate(doc, bin);
  const blocks = doc.getMap('blocks');
  const db = blocks.get(DEFAULT_DATABASE_BLOCK_ID) as Y.Map<unknown>;
  const views = db.get('prop:views') as Y.Array<Record<string, unknown>>;
  const view = views.get(0);
  views.delete(0, 1);
  views.insert(0, [
    {
      ...view,
      groupProperties: [
        { key: 'o_doing', manuallyCardSort: ['r3'] },
        { key: 'o_todo', manuallyCardSort: ['r2', 'r1'] },
      ],
    },
  ]);
  const patchedBin = Y.encodeStateAsUpdate(doc);

  const board = readBoardFromBinary(patchedBin, DEFAULT_DATABASE_BLOCK_ID);

  t.deepEqual(board.views[0].groups, [
    { value: 'In Progress', cardRowIds: ['r3'] },
    { value: 'Todo', cardRowIds: ['r2', 'r1'] },
  ]);
});

test('listBoardsFromBinary lists every database block in a two-database doc', t => {
  const bin1 = buildBoardDoc({
    title: 'Board One',
    columns: [{ id: 'c_title', name: 'Title', type: 'title' }],
    rows: [],
    views: [{ id: 'v1', name: 'Table', mode: 'table' }],
    blockId: 'board-a',
  });

  const doc = new Y.Doc();
  Y.applyUpdate(doc, bin1);
  const blocks = doc.getMap('blocks');

  // buildBoardDoc only ever constructs a single database block per call, so
  // add a second one directly to exercise the multi-board listing path.
  doc.transact(() => {
    const db2 = new Y.Map<unknown>();
    db2.set('sys:id', 'board-b');
    db2.set('sys:flavour', 'affine:database');
    db2.set('sys:version', 3);
    db2.set('sys:children', new Y.Array<string>());
    db2.set('prop:columns', new Y.Array<unknown>());
    db2.set('prop:cells', new Y.Map<unknown>());
    const views2 = new Y.Array<unknown>();
    views2.push([
      { id: 'v2', name: 'Table', mode: 'table' },
      { id: 'v3', name: 'Board', mode: 'kanban', groupBy: 'c_status' },
    ]);
    db2.set('prop:views', views2);
    db2.set('prop:title', new Y.Text('Board Two'));
    blocks.set('board-b', db2);
  });

  const bin = Y.encodeStateAsUpdate(doc);
  const boards = listBoardsFromBinary(bin);

  t.is(boards.length, 2);
  t.deepEqual(
    boards.find(b => b.blockId === 'board-a'),
    { blockId: 'board-a', title: 'Board One', viewModes: ['table'] }
  );
  t.deepEqual(
    boards.find(b => b.blockId === 'board-b'),
    { blockId: 'board-b', title: 'Board Two', viewModes: ['table', 'kanban'] }
  );
});
