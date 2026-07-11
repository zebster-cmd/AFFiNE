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
 * two methods `DatabaseWriter` calls. Captures pushed deltas for assertions -
 * mirrors the fake used by `database-writer-rows.spec.ts` etc.
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

/** Applies `deltas` in order onto a fresh `Y.Doc` loaded from `baseBin` and returns the merged binary. */
function mergeOnto(baseBin: Uint8Array, deltas: Uint8Array[]): Uint8Array {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, baseBin);
  for (const delta of deltas) {
    Y.applyUpdate(doc, delta);
  }
  return Y.encodeStateAsUpdate(doc);
}

const COLUMNS = [
  { id: 'c_title', name: 'Title', type: 'title' as const },
  { id: 'c_notes', name: 'Notes', type: 'text' as const },
];

function buildBaseBin(): Uint8Array {
  return buildBoardDoc({
    title: 'Board',
    columns: COLUMNS,
    rows: [
      { rowId: 'r1', title: 'Row 1', cells: { c_notes: 'r1 original' } },
      { rowId: 'r2', title: 'Row 2', cells: { c_notes: 'r2 original' } },
    ],
    views: [],
  });
}

/**
 * Produces the writer's delta A: `applyOps` with an `add_row` op, run
 * against a `FakeStorage` seeded with `baseBin`. This is the "server-side
 * database tool" edit.
 */
async function produceWriterDeltaA(baseBin: Uint8Array): Promise<Uint8Array> {
  const { writer, storage } = makeWriter(baseBin);
  await writer.applyOps('ws1', 'doc1', DEFAULT_DATABASE_BLOCK_ID, [
    {
      op: 'add_row',
      title: 'New Row (from writer)',
      cells: { c_notes: 'added by writer' },
    },
  ]);
  return storage.pushed[0];
}

/**
 * Produces a concurrent client delta B, entirely independently of delta A:
 * a separate `Y.Doc` loaded from the SAME `baseBin`, mutated directly via raw
 * Yjs (changing row r1's title), with only the resulting incremental update
 * encoded. Simulates another user editing the board at the same time - B is
 * built with no knowledge of A.
 */
function produceClientDeltaB(baseBin: Uint8Array): Uint8Array {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, baseBin);
  const beforeSV = Y.encodeStateVector(doc);

  doc.transact(() => {
    const blocks = doc.getMap('blocks');
    const r1 = blocks.get('r1') as Y.Map<unknown>;
    // Every op mutates Yjs types in place / replaces the whole prop:* value
    // when deleting - here we replace prop:text with a new Y.Text, exactly
    // like DatabaseWriter.updateCell does for the title column.
    r1.set('prop:text', new Y.Text('Row 1 (edited by concurrent client)'));
  });

  return Y.encodeStateAsUpdate(doc, beforeSV);
}

test('a DatabaseWriter add_row edit and a concurrent client title edit merge without lost updates, regardless of apply order', async t => {
  const baseBin = buildBaseBin();

  // Two independent edits, both derived from the SAME base bin - neither
  // knows about the other, exactly like two users editing concurrently.
  const deltaA = await produceWriterDeltaA(baseBin);
  const deltaB = produceClientDeltaB(baseBin);

  // Apply both deltas in both orders onto fresh copies of the base doc.
  const mergedAB = mergeOnto(baseBin, [deltaA, deltaB]);
  const mergedBA = mergeOnto(baseBin, [deltaB, deltaA]);

  const boardAB = readBoardFromBinary(mergedAB, DEFAULT_DATABASE_BLOCK_ID);
  const boardBA = readBoardFromBinary(mergedBA, DEFAULT_DATABASE_BLOCK_ID);

  for (const board of [boardAB, boardBA]) {
    // A's edit: the new row is present, with its seeded cell.
    t.is(board.rows.length, 3);
    const newRow = board.rows.find(r => r.rowId !== 'r1' && r.rowId !== 'r2');
    t.truthy(newRow);
    t.is(newRow?.title, 'New Row (from writer)');
    t.is(newRow?.cells.c_notes, 'added by writer');

    // B's edit: r1's title changed, r2 untouched, no cells lost.
    const r1 = board.rows.find(r => r.rowId === 'r1');
    t.is(r1?.title, 'Row 1 (edited by concurrent client)');
    t.is(r1?.cells.c_notes, 'r1 original');

    const r2 = board.rows.find(r => r.rowId === 'r2');
    t.is(r2?.title, 'Row 2');
    t.is(r2?.cells.c_notes, 'r2 original');
  }

  // CRDT commutativity: both apply orders converge to the same final state.
  t.deepEqual(boardAB, boardBA);
  t.deepEqual(mergedAB, mergedBA);
});
