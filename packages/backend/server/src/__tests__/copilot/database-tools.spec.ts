import test from 'ava';
import * as Y from 'yjs';

import type { DocReader } from '../../core/doc';
import { DatabaseWriter } from '../../core/doc/database-writer';
import type { PermissionAccess } from '../../core/permission';
import {
  buildDatabaseCreateHandler,
  createDatabaseCreateTool,
} from '../../plugins/copilot/tools/database-create';
import {
  buildDatabaseReadHandler,
  createDatabaseReadTool,
} from '../../plugins/copilot/tools/database-read';
import {
  buildDatabaseUpdateHandler,
  createDatabaseUpdateTool,
} from '../../plugins/copilot/tools/database-update';
import {
  buildBoardDoc,
  DEFAULT_DATABASE_BLOCK_ID,
} from './fixtures/database-doc';

/** In-memory `DocReader` stand-in exposing only the `getDoc` method the read tool calls. */
class FakeDocReader {
  constructor(private readonly bin: Uint8Array | null) {}

  async getDoc(spaceId: string, docId: string) {
    if (!this.bin) {
      return null;
    }
    return { spaceId, docId, bin: this.bin, timestamp: Date.now() };
  }
}

/** In-memory `PgWorkspaceDocStorageAdapter` stand-in, mirroring database-writer-create.spec.ts. */
class FakeStorage {
  bin: Uint8Array;
  pushed: Uint8Array[] = [];

  constructor(initialBin: Uint8Array) {
    this.bin = initialBin;
  }

  async getDoc(spaceId: string, docId: string) {
    return { spaceId, docId, bin: this.bin, timestamp: Date.now() };
  }

  async pushDocUpdates(
    _workspaceId: string,
    _docId: string,
    updates: Uint8Array[]
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

class FakeEventBus {
  emitted: { event: string; payload: unknown }[] = [];

  emit(event: string, payload: unknown) {
    this.emitted.push({ event, payload });
  }
}

/** Fake `PermissionAccess`: every `.user().workspace().doc()` call chains back to itself. */
class FakePermissionAccess {
  constructor(private readonly allowed: boolean) {}

  user(_userId: string) {
    return this;
  }

  workspace(_workspaceId: string) {
    return this;
  }

  doc(_docId: string) {
    return this;
  }

  async can(_action: string) {
    return this.allowed;
  }

  async assert(_action: string) {
    if (!this.allowed) {
      throw new Error('Permission denied');
    }
  }
}

const allow = new FakePermissionAccess(true) as unknown as PermissionAccess;
const deny = new FakePermissionAccess(false) as unknown as PermissionAccess;

function makeWriter(bin: Uint8Array) {
  const storage = new FakeStorage(bin);
  const event = new FakeEventBus();
  const writer = new DatabaseWriter(storage as any, event as any);
  return { writer, storage, event };
}

function boardBin(blockId = DEFAULT_DATABASE_BLOCK_ID) {
  return buildBoardDoc({
    blockId,
    title: 'Sprint Board',
    columns: [
      { id: 'c_title', name: 'Title', type: 'title' },
      { id: 'c_notes', name: 'Notes', type: 'text' },
    ],
    rows: [{ rowId: 'r1', title: 'Row 1', cells: { c_notes: 'hi' } }],
    views: [{ id: 'v1', name: 'All items', mode: 'table' }],
  });
}

const OPTIONS = { user: 'u1', workspace: 'ws1' } as any;

test('database_read returns board JSON for a given database_block_id', async t => {
  const bin = boardBin();
  const docReader = new FakeDocReader(bin) as unknown as DocReader;
  const handler = buildDatabaseReadHandler(allow, docReader);
  const tool = createDatabaseReadTool(handler.bind(null, OPTIONS));

  const result: any = await tool.execute!(
    { doc_id: 'doc1', database_block_id: DEFAULT_DATABASE_BLOCK_ID },
    {}
  );

  t.is(result.blockId, DEFAULT_DATABASE_BLOCK_ID);
  t.is(result.title, 'Sprint Board');
  t.is(result.columns.length, 2);
  t.is(result.rows.length, 1);
});

test('database_read lists boards when database_block_id is omitted', async t => {
  const bin = boardBin();
  const docReader = new FakeDocReader(bin) as unknown as DocReader;
  const handler = buildDatabaseReadHandler(allow, docReader);
  const tool = createDatabaseReadTool(handler.bind(null, OPTIONS));

  const result: any = await tool.execute!({ doc_id: 'doc1' }, {});

  t.true(Array.isArray(result.databases));
  t.is(result.databases.length, 1);
  t.is(result.databases[0].blockId, DEFAULT_DATABASE_BLOCK_ID);
  t.is(result.databases[0].title, 'Sprint Board');
  t.deepEqual(result.databases[0].viewModes, ['table']);
});

test('database_read returns a toolError when permission is denied', async t => {
  const bin = boardBin();
  const docReader = new FakeDocReader(bin) as unknown as DocReader;
  const handler = buildDatabaseReadHandler(deny, docReader);
  const tool = createDatabaseReadTool(handler.bind(null, OPTIONS));

  const result: any = await tool.execute!(
    { doc_id: 'doc1', database_block_id: DEFAULT_DATABASE_BLOCK_ID },
    {}
  );

  t.is(result.type, 'error');
});

test('database_read returns a toolError for an unknown database_block_id', async t => {
  const bin = boardBin();
  const docReader = new FakeDocReader(bin) as unknown as DocReader;
  const handler = buildDatabaseReadHandler(allow, docReader);
  const tool = createDatabaseReadTool(handler.bind(null, OPTIONS));

  const result: any = await tool.execute!(
    { doc_id: 'doc1', database_block_id: 'does-not-exist' },
    {}
  );

  t.is(result.type, 'error');
});

test('database_create calls DatabaseWriter.createBoard and returns { success, blockId }', async t => {
  // A page -> note doc with no database block yet, for createBoard to append to.
  const bin = buildBoardDoc({
    title: 'unused',
    columns: [{ id: 'placeholder', name: 'Title', type: 'title' }],
    rows: [],
    views: [],
    blockId: 'placeholder-db',
  });
  const { writer, storage } = makeWriter(bin);
  const handler = buildDatabaseCreateHandler(allow, writer);
  const tool = createDatabaseCreateTool(handler.bind(null, OPTIONS));

  const result: any = await tool.execute!(
    {
      doc_id: 'doc1',
      title: 'New Board',
      columns: [{ name: 'Notes', type: 'text' }],
      view: { mode: 'table' },
    },
    {}
  );

  t.true(result.success);
  t.truthy(result.blockId);
  t.is(storage.pushed.length, 1);
});

test('database_create returns a toolError when permission is denied', async t => {
  const bin = buildBoardDoc({
    title: 'unused',
    columns: [{ id: 'placeholder', name: 'Title', type: 'title' }],
    rows: [],
    views: [],
  });
  const { writer } = makeWriter(bin);
  const handler = buildDatabaseCreateHandler(deny, writer);
  const tool = createDatabaseCreateTool(handler.bind(null, OPTIONS));

  const result: any = await tool.execute!(
    {
      doc_id: 'doc1',
      title: 'New Board',
      columns: [],
      view: { mode: 'table' },
    },
    {}
  );

  t.is(result.type, 'error');
});

test('database_create surfaces a delegate throw (no note block) as a toolError', async t => {
  const doc = new Y.Doc();
  const blocks = doc.getMap('blocks');
  doc.transact(() => {
    const page = new Y.Map<unknown>();
    page.set('sys:id', 'page');
    page.set('sys:flavour', 'affine:page');
    page.set('sys:children', new Y.Array<string>());
    blocks.set('page', page);
  });
  const bin = Y.encodeStateAsUpdate(doc);

  const { writer } = makeWriter(bin);
  const handler = buildDatabaseCreateHandler(allow, writer);
  const tool = createDatabaseCreateTool(handler.bind(null, OPTIONS));

  const result: any = await tool.execute!(
    {
      doc_id: 'doc1',
      title: 'New Board',
      columns: [],
      view: { mode: 'table' },
    },
    {}
  );

  t.is(result.type, 'error');
});

test('database_update calls DatabaseWriter.applyOps and returns { success, blockId, applied }', async t => {
  const bin = boardBin();
  const { writer, storage } = makeWriter(bin);
  const handler = buildDatabaseUpdateHandler(allow, writer);
  const tool = createDatabaseUpdateTool(handler.bind(null, OPTIONS));

  const result: any = await tool.execute!(
    {
      doc_id: 'doc1',
      database_block_id: DEFAULT_DATABASE_BLOCK_ID,
      operations: [{ op: 'add_column', name: 'Priority', type: 'text' }],
    },
    {}
  );

  t.true(result.success);
  t.is(result.blockId, DEFAULT_DATABASE_BLOCK_ID);
  t.is(result.applied, 1);
  t.is(storage.pushed.length, 1);
});

test('database_update returns a toolError when permission is denied', async t => {
  const bin = boardBin();
  const { writer } = makeWriter(bin);
  const handler = buildDatabaseUpdateHandler(deny, writer);
  const tool = createDatabaseUpdateTool(handler.bind(null, OPTIONS));

  const result: any = await tool.execute!(
    {
      doc_id: 'doc1',
      database_block_id: DEFAULT_DATABASE_BLOCK_ID,
      operations: [{ op: 'add_column', name: 'Priority', type: 'text' }],
    },
    {}
  );

  t.is(result.type, 'error');
});

test('database_update surfaces a delegate throw (unknown block) as a toolError', async t => {
  const bin = boardBin();
  const { writer } = makeWriter(bin);
  const handler = buildDatabaseUpdateHandler(allow, writer);
  const tool = createDatabaseUpdateTool(handler.bind(null, OPTIONS));

  const result: any = await tool.execute!(
    {
      doc_id: 'doc1',
      database_block_id: 'does-not-exist',
      operations: [{ op: 'add_column', name: 'Priority', type: 'text' }],
    },
    {}
  );

  t.is(result.type, 'error');
});
