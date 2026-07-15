import test from 'ava';

import type { DocReader } from '../../core/doc';
import type {
  DocLinksReader,
  DocLinksView,
} from '../../core/doc/doc-links-reader';
import type {
  CreatedLink,
  DocLinksWriter,
  LinkOp,
} from '../../core/doc/doc-links-writer';
import type { DocPropertiesReader } from '../../core/doc/doc-properties-reader';
import type { DocPropertiesView } from '../../core/doc/doc-properties-types';
import type {
  DocPropertiesWriter,
  DocPropertyOp,
} from '../../core/doc/doc-properties-writer';
import type { PermissionAccess } from '../../core/permission';
import {
  buildDocLinksReadHandler,
  createDocLinksReadTool,
} from '../../plugins/copilot/tools/doc-links-read';
import {
  buildDocLinksUpdateHandler,
  createDocLinksUpdateTool,
  type DocLinksToolOp,
} from '../../plugins/copilot/tools/doc-links-update';
import {
  buildDocPropertiesReadHandler,
  createDocPropertiesReadTool,
} from '../../plugins/copilot/tools/doc-properties-read';
import {
  buildDocPropertiesUpdateHandler,
  createDocPropertiesUpdateTool,
} from '../../plugins/copilot/tools/doc-properties-update';
import { buildRootDoc } from './fixtures/doc-properties-doc';

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

const OPTIONS = { user: 'u1', workspace: 'ws1' } as any;

/**
 * In-memory `DocReader` stand-in exposing only the `getDoc` method the
 * doc-links-update tool calls, mirroring database-tools.spec.ts's
 * FakeDocReader. Tracks `getDoc` call count so tests can assert the root doc
 * is fetched (and thus parsed via `buildPageIndexFromRoot`) exactly once per
 * handler invocation, regardless of how many ops are in the batch.
 */
class FakeDocReader {
  getDocCalls = 0;

  constructor(private readonly bin: Uint8Array | null) {}

  async getDoc(spaceId: string, docId: string) {
    this.getDocCalls++;
    if (!this.bin) {
      return null;
    }
    return { spaceId, docId, bin: this.bin, timestamp: Date.now() };
  }
}

// ---------------------------------------------------------------------------
// doc_properties_read
// ---------------------------------------------------------------------------

class FakePropertiesReader {
  constructor(private readonly view: DocPropertiesView | null) {}

  async read(_workspaceId: string, _docId: string, _userId: string) {
    return this.view;
  }
}

const SAMPLE_VIEW: DocPropertiesView = {
  docId: 'doc1',
  title: 'My Doc',
  trash: false,
  favorite: true,
  journal: null,
  primaryMode: 'page',
  tags: [{ id: 't1', name: 'Work', color: 'blue' }],
  properties: [],
};

test('doc_properties_read returns the properties view for a known doc', async t => {
  const reader = new FakePropertiesReader(
    SAMPLE_VIEW
  ) as unknown as DocPropertiesReader;
  const handler = buildDocPropertiesReadHandler(allow, reader);
  const tool = createDocPropertiesReadTool(handler.bind(null, OPTIONS));

  const result: any = await tool.execute!({ doc_id: 'doc1' }, {});

  t.is(result.docId, 'doc1');
  t.is(result.title, 'My Doc');
  t.true(result.favorite);
});

test('doc_properties_read returns a toolError when permission is denied', async t => {
  const reader = new FakePropertiesReader(
    SAMPLE_VIEW
  ) as unknown as DocPropertiesReader;
  const handler = buildDocPropertiesReadHandler(deny, reader);
  const tool = createDocPropertiesReadTool(handler.bind(null, OPTIONS));

  const result: any = await tool.execute!({ doc_id: 'doc1' }, {});

  t.is(result.type, 'error');
});

test('doc_properties_read returns a toolError naming the doc id when the reader returns null', async t => {
  const reader = new FakePropertiesReader(
    null
  ) as unknown as DocPropertiesReader;
  const handler = buildDocPropertiesReadHandler(allow, reader);
  const tool = createDocPropertiesReadTool(handler.bind(null, OPTIONS));

  const result: any = await tool.execute!({ doc_id: 'missing-doc' }, {});

  t.is(result.type, 'error');
  t.true(result.message.includes('missing-doc'));
});

test('doc_properties_read surfaces a reader throw as a toolError, mirroring database-tools.spec.ts', async t => {
  const reader = {
    read: async () => {
      throw new Error('storage unavailable');
    },
  } as unknown as DocPropertiesReader;
  const handler = buildDocPropertiesReadHandler(allow, reader);
  const tool = createDocPropertiesReadTool(handler.bind(null, OPTIONS));

  const result: any = await tool.execute!({ doc_id: 'doc1' }, {});

  t.is(result.type, 'error');
  t.true(result.message.includes('storage unavailable'));
});

// ---------------------------------------------------------------------------
// doc_properties_update
// ---------------------------------------------------------------------------

class FakePropertiesWriter {
  calls: {
    workspaceId: string;
    docId: string;
    userId: string;
    ops: DocPropertyOp[];
    editorId?: string;
  }[] = [];

  constructor(
    private readonly result?: {
      applied: number;
      createdTagIds: string[];
      createdPropertyIds: string[];
    },
    private readonly err?: Error
  ) {}

  async applyOps(
    workspaceId: string,
    docId: string,
    userId: string,
    ops: DocPropertyOp[],
    editorId?: string
  ) {
    this.calls.push({ workspaceId, docId, userId, ops, editorId });
    if (this.err) {
      throw this.err;
    }
    return (
      this.result ?? {
        applied: ops.length,
        createdTagIds: [],
        createdPropertyIds: [],
      }
    );
  }
}

test('doc_properties_update calls DocPropertiesWriter.applyOps and returns { success, applied }', async t => {
  const writer = new FakePropertiesWriter({
    applied: 1,
    createdTagIds: ['tag-1'],
    createdPropertyIds: [],
  }) as unknown as DocPropertiesWriter;
  const handler = buildDocPropertiesUpdateHandler(allow, writer);
  const tool = createDocPropertiesUpdateTool(handler.bind(null, OPTIONS));

  const result: any = await tool.execute!(
    {
      doc_id: 'doc1',
      operations: [{ op: 'create_tag', name: 'Work' }],
    },
    {}
  );

  t.true(result.success);
  t.is(result.applied, 1);
  t.deepEqual(result.createdTagIds, ['tag-1']);
});

test('doc_properties_update returns a toolError when permission is denied', async t => {
  const writer = new FakePropertiesWriter() as unknown as DocPropertiesWriter;
  const handler = buildDocPropertiesUpdateHandler(deny, writer);
  const tool = createDocPropertiesUpdateTool(handler.bind(null, OPTIONS));

  const result: any = await tool.execute!(
    { doc_id: 'doc1', operations: [{ op: 'set_title', title: 'New' }] },
    {}
  );

  t.is(result.type, 'error');
});

test('doc_properties_update surfaces a writer throw (naming the failing op) as a toolError', async t => {
  const writer = new FakePropertiesWriter(
    undefined,
    new Error('add_tag: no tag named "Ghost" exists; call create_tag first.')
  ) as unknown as DocPropertiesWriter;
  const handler = buildDocPropertiesUpdateHandler(allow, writer);
  const tool = createDocPropertiesUpdateTool(handler.bind(null, OPTIONS));

  const result: any = await tool.execute!(
    { doc_id: 'doc1', operations: [{ op: 'add_tag', tag: 'Ghost' }] },
    {}
  );

  t.is(result.type, 'error');
  t.true(result.message.includes('Ghost'));
});

// ---------------------------------------------------------------------------
// doc_links_read
// ---------------------------------------------------------------------------

class FakeLinksReader {
  constructor(private readonly view: DocLinksView) {}

  async read(_workspaceId: string, _docId: string) {
    return this.view;
  }
}

test('doc_links_read returns outgoing links and backlinks', async t => {
  const reader = new FakeLinksReader({
    outgoing: [{ docId: 'target-1', blockId: 'e1', title: 'Target' }],
    backlinks: [{ docId: 'source-1', blockId: 'e2', title: 'Source' }],
  }) as unknown as DocLinksReader;
  const handler = buildDocLinksReadHandler(allow, reader);
  const tool = createDocLinksReadTool(handler.bind(null, OPTIONS));

  const result: any = await tool.execute!({ doc_id: 'doc1' }, {});

  t.is(result.outgoing.length, 1);
  t.is(result.outgoing[0].docId, 'target-1');
  t.is(result.backlinks.length, 1);
  t.is(result.backlinks[0].docId, 'source-1');
});

test('doc_links_read returns a toolError when permission is denied', async t => {
  const reader = new FakeLinksReader({
    outgoing: [],
    backlinks: [],
  }) as unknown as DocLinksReader;
  const handler = buildDocLinksReadHandler(deny, reader);
  const tool = createDocLinksReadTool(handler.bind(null, OPTIONS));

  const result: any = await tool.execute!({ doc_id: 'doc1' }, {});

  t.is(result.type, 'error');
});

test('doc_links_read surfaces a reader throw as a toolError, mirroring database-tools.spec.ts', async t => {
  const reader = {
    read: async () => {
      throw new Error('storage unavailable');
    },
  } as unknown as DocLinksReader;
  const handler = buildDocLinksReadHandler(allow, reader);
  const tool = createDocLinksReadTool(handler.bind(null, OPTIONS));

  const result: any = await tool.execute!({ doc_id: 'doc1' }, {});

  t.is(result.type, 'error');
  t.true(result.message.includes('storage unavailable'));
});

// ---------------------------------------------------------------------------
// doc_links_update
// ---------------------------------------------------------------------------

class FakeLinksWriter {
  calls: {
    workspaceId: string;
    sourceDocId: string;
    ops: LinkOp[];
    editorId?: string;
  }[] = [];

  constructor(
    private readonly result?: { applied: number; created: CreatedLink[] },
    private readonly err?: Error
  ) {}

  async applyOps(
    workspaceId: string,
    sourceDocId: string,
    ops: LinkOp[],
    editorId?: string
  ) {
    this.calls.push({ workspaceId, sourceDocId, ops, editorId });
    if (this.err) {
      throw this.err;
    }
    return this.result ?? { applied: ops.length, created: [] };
  }
}

function rootBinWith(pages: { id: string; title: string }[]) {
  return buildRootDoc({ pages });
}

test('doc_links_update resolves a target by exact id and calls DocLinksWriter.applyOps', async t => {
  const rootBin = rootBinWith([{ id: 'target-1', title: 'Target Doc' }]);
  const docReader = new FakeDocReader(rootBin) as unknown as DocReader;
  const writer = new FakeLinksWriter({
    applied: 1,
    created: [{ op: 'create_link', blockId: 'e1' }],
  }) as unknown as DocLinksWriter;
  const handler = buildDocLinksUpdateHandler(allow, writer, docReader);
  const tool = createDocLinksUpdateTool(handler.bind(null, OPTIONS));

  const operations: DocLinksToolOp[] = [
    { op: 'create_link', target: 'target-1' },
  ];
  const result: any = await tool.execute!({ doc_id: 'doc1', operations }, {});

  t.true(result.success);
  t.is(result.applied, 1);
  const passedOps = (writer as unknown as FakeLinksWriter).calls[0].ops;
  t.is((passedOps[0] as any).targetDocId, 'target-1');
});

test('doc_links_update resolves a target by exact title and calls DocLinksWriter.applyOps with the id', async t => {
  const rootBin = rootBinWith([{ id: 'target-1', title: 'Target Doc' }]);
  const docReader = new FakeDocReader(rootBin) as unknown as DocReader;
  const fakeWriter = new FakeLinksWriter({
    applied: 1,
    created: [{ op: 'create_link', blockId: 'e1' }],
  });
  const writer = fakeWriter as unknown as DocLinksWriter;
  const handler = buildDocLinksUpdateHandler(allow, writer, docReader);
  const tool = createDocLinksUpdateTool(handler.bind(null, OPTIONS));

  const operations: DocLinksToolOp[] = [
    { op: 'create_link', target: 'Target Doc' },
  ];
  const result: any = await tool.execute!({ doc_id: 'doc1', operations }, {});

  t.true(result.success);
  t.is((fakeWriter.calls[0].ops[0] as any).targetDocId, 'target-1');
});

test('doc_links_update returns a toolError naming the missing target when no doc matches', async t => {
  const rootBin = rootBinWith([{ id: 'target-1', title: 'Target Doc' }]);
  const docReader = new FakeDocReader(rootBin) as unknown as DocReader;
  const writer = new FakeLinksWriter() as unknown as DocLinksWriter;
  const handler = buildDocLinksUpdateHandler(allow, writer, docReader);
  const tool = createDocLinksUpdateTool(handler.bind(null, OPTIONS));

  const operations: DocLinksToolOp[] = [
    { op: 'create_link', target: 'Ghost Doc' },
  ];
  const result: any = await tool.execute!({ doc_id: 'doc1', operations }, {});

  t.is(result.type, 'error');
  t.true(result.message.includes('Ghost Doc'));
});

test('doc_links_update returns a toolError listing candidates when a title is ambiguous', async t => {
  const rootBin = rootBinWith([
    { id: 'dup-1', title: 'Duplicate' },
    { id: 'dup-2', title: 'Duplicate' },
  ]);
  const docReader = new FakeDocReader(rootBin) as unknown as DocReader;
  const writer = new FakeLinksWriter() as unknown as DocLinksWriter;
  const handler = buildDocLinksUpdateHandler(allow, writer, docReader);
  const tool = createDocLinksUpdateTool(handler.bind(null, OPTIONS));

  const operations: DocLinksToolOp[] = [
    { op: 'create_link', target: 'Duplicate' },
  ];
  const result: any = await tool.execute!({ doc_id: 'doc1', operations }, {});

  t.is(result.type, 'error');
  t.true(result.message.includes('dup-1'));
  t.true(result.message.includes('dup-2'));
});

test('doc_links_update returns a toolError when permission is denied', async t => {
  const rootBin = rootBinWith([{ id: 'target-1', title: 'Target Doc' }]);
  const docReader = new FakeDocReader(rootBin) as unknown as DocReader;
  const writer = new FakeLinksWriter() as unknown as DocLinksWriter;
  const handler = buildDocLinksUpdateHandler(deny, writer, docReader);
  const tool = createDocLinksUpdateTool(handler.bind(null, OPTIONS));

  const operations: DocLinksToolOp[] = [
    { op: 'create_link', target: 'target-1' },
  ];
  const result: any = await tool.execute!({ doc_id: 'doc1', operations }, {});

  t.is(result.type, 'error');
});

test('doc_links_update surfaces a writer throw as a toolError', async t => {
  const rootBin = rootBinWith([{ id: 'target-1', title: 'Target Doc' }]);
  const docReader = new FakeDocReader(rootBin) as unknown as DocReader;
  const writer = new FakeLinksWriter(
    undefined,
    new Error('No anchor block found (and none specified) for an inline link')
  ) as unknown as DocLinksWriter;
  const handler = buildDocLinksUpdateHandler(allow, writer, docReader);
  const tool = createDocLinksUpdateTool(handler.bind(null, OPTIONS));

  const operations: DocLinksToolOp[] = [
    { op: 'create_link', target: 'target-1', mode: 'inline' },
  ];
  const result: any = await tool.execute!({ doc_id: 'doc1', operations }, {});

  t.is(result.type, 'error');
  t.true(result.message.includes('anchor block'));
});

test('doc_links_update create_doc_and_link does not require the root doc to resolve a target', async t => {
  const docReader = new FakeDocReader(null) as unknown as DocReader;
  const fakeWriter = new FakeLinksWriter({
    applied: 1,
    created: [{ op: 'create_doc_and_link', blockId: 'p1', newDocId: 'new-1' }],
  });
  const writer = fakeWriter as unknown as DocLinksWriter;
  const handler = buildDocLinksUpdateHandler(allow, writer, docReader);
  const tool = createDocLinksUpdateTool(handler.bind(null, OPTIONS));

  const operations: DocLinksToolOp[] = [
    { op: 'create_doc_and_link', title: 'Spun off' },
  ];
  const result: any = await tool.execute!({ doc_id: 'doc1', operations }, {});

  t.true(result.success);
  t.is(fakeWriter.calls[0].ops[0].op, 'create_doc_and_link');
});

test('doc_links_update parses the root doc exactly once for a multi-op batch mixing id and title targets', async t => {
  const rootBin = rootBinWith([
    { id: 'target-1', title: 'Target One' },
    { id: 'target-2', title: 'Target Two' },
  ]);
  const docReader = new FakeDocReader(rootBin) as unknown as DocReader;
  const fakeDocReader = docReader as unknown as FakeDocReader;
  const fakeWriter = new FakeLinksWriter({
    applied: 3,
    created: [{ op: 'create_link', blockId: 'e1' }],
  });
  const writer = fakeWriter as unknown as DocLinksWriter;
  const handler = buildDocLinksUpdateHandler(allow, writer, docReader);
  const tool = createDocLinksUpdateTool(handler.bind(null, OPTIONS));

  const operations: DocLinksToolOp[] = [
    // by-id
    { op: 'create_link', target: 'target-1' },
    // by-title
    { op: 'remove_link', target: 'Target Two' },
    // mixed within a single op: fromTarget by-id, toTarget by-title
    {
      op: 'retarget_link',
      fromTarget: 'target-1',
      toTarget: 'Target Two',
    },
  ];
  const result: any = await tool.execute!({ doc_id: 'doc1', operations }, {});

  t.true(result.success);
  t.is(
    fakeDocReader.getDocCalls,
    1,
    'root doc should be fetched exactly once for the whole batch, not once per op'
  );

  const passedOps = fakeWriter.calls[0].ops;
  t.is((passedOps[0] as any).targetDocId, 'target-1');
  t.is((passedOps[1] as any).targetDocId, 'target-2');
  t.is((passedOps[2] as any).fromTargetDocId, 'target-1');
  t.is((passedOps[2] as any).toTargetDocId, 'target-2');
});

test('doc_links_update still lists candidates for an ambiguous title within a multi-op batch, fetching the root doc once', async t => {
  const rootBin = rootBinWith([
    { id: 'target-1', title: 'Target One' },
    { id: 'dup-1', title: 'Duplicate' },
    { id: 'dup-2', title: 'Duplicate' },
  ]);
  const docReader = new FakeDocReader(rootBin) as unknown as DocReader;
  const fakeDocReader = docReader as unknown as FakeDocReader;
  const writer = new FakeLinksWriter() as unknown as DocLinksWriter;
  const handler = buildDocLinksUpdateHandler(allow, writer, docReader);
  const tool = createDocLinksUpdateTool(handler.bind(null, OPTIONS));

  const operations: DocLinksToolOp[] = [
    { op: 'create_link', target: 'target-1' },
    { op: 'remove_link', target: 'Duplicate' },
  ];
  const result: any = await tool.execute!({ doc_id: 'doc1', operations }, {});

  t.is(result.type, 'error');
  t.true(result.message.includes('dup-1'));
  t.true(result.message.includes('dup-2'));
  t.is(
    fakeDocReader.getDocCalls,
    1,
    'root doc should still be fetched exactly once even though op resolution stops on the second op'
  );
});
