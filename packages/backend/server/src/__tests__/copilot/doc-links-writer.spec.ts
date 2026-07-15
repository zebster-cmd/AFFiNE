import test from 'ava';
import * as Y from 'yjs';

import { DocLinksWriter } from '../../core/doc/doc-links-writer';
import { buildLinksDoc } from './fixtures/links-doc';

const WS = 'ws1';
const DOC = 'doc-1';

/**
 * Single-doc in-memory stand-in for `PgWorkspaceDocStorageAdapter`, mirroring
 * `database-writer-*.spec.ts`'s `FakeStorage` (one doc per writer instance -
 * `DocLinksWriter.applyOps` only ever touches the SOURCE doc's own binary).
 */
class FakeStorage {
  private bin: Uint8Array | null;
  pushed: Uint8Array[] = [];

  constructor(bin: Uint8Array | null) {
    this.bin = bin;
  }

  async getDoc(workspaceId: string, docId: string) {
    if (!this.bin) {
      return null;
    }
    return {
      spaceId: workspaceId,
      docId,
      bin: this.bin,
      timestamp: Date.now(),
    };
  }

  async pushDocUpdates(
    _workspaceId: string,
    _docId: string,
    updates: Uint8Array[]
  ) {
    for (const delta of updates) {
      this.pushed.push(delta);
      const doc = new Y.Doc();
      if (this.bin) {
        Y.applyUpdate(doc, this.bin);
      }
      Y.applyUpdate(doc, delta);
      this.bin = Y.encodeStateAsUpdate(doc);
    }
    return Date.now();
  }

  /** The doc's binary after every pushed delta so far. */
  currentBin(): Uint8Array {
    if (!this.bin) {
      throw new Error('FakeStorage has no bin (doc was never created)');
    }
    return this.bin;
  }
}

/** Minimal stand-in for `EventBus`, just capturing emitted events. */
class FakeEventBus {
  emitted: { event: string; payload: unknown }[] = [];

  emit(event: string, payload: unknown) {
    this.emitted.push({ event, payload });
  }
}

/**
 * Fake `DocWriter`: `create_doc_and_link` only needs `createDoc`'s
 * `{ docId }` result (per `writer.ts`'s real signature), not a full doc/root
 * write - keeping this test hermetic (no native-addon markdown parsing).
 */
class FakeDocWriter {
  created: { workspaceId: string; title: string; markdown: string }[] = [];
  private counter = 0;

  async createDoc(workspaceId: string, title: string, markdown: string) {
    this.counter += 1;
    this.created.push({ workspaceId, title, markdown });
    return { docId: `new-doc-${this.counter}` };
  }
}

function makeWriter(bin: Uint8Array | null) {
  const storage = new FakeStorage(bin);
  const event = new FakeEventBus();
  const docWriter = new FakeDocWriter();
  // Cast: the fakes only implement the methods DocLinksWriter/YjsDeltaWriter
  // actually call, not the full adapter/EventBus/DocWriter surface - same
  // convention as doc-properties-writer.spec.ts.
  const writer = new DocLinksWriter(
    storage as any,
    event as any,
    docWriter as any
  );
  return { writer, storage, event, docWriter };
}

function loadDoc(bin: Uint8Array): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, bin);
  return doc;
}

function noteChildren(doc: Y.Doc): string[] {
  const blocks = doc.getMap('blocks');
  const note = blocks.get('note') as Y.Map<unknown>;
  return (note.get('sys:children') as Y.Array<string>).toArray();
}

function referenceOps(ytext: Y.Text) {
  return (
    ytext.toDelta() as {
      insert?: string;
      attributes?: { reference?: { pageId?: string } };
    }[]
  ).filter(entry => entry.attributes?.reference);
}

// 6.1 - create_link (embed, default)
test('applyOps create_link (embed, default) appends an embed-linked-doc block under the note and returns its id', async t => {
  const bin = buildLinksDoc({ paragraphs: [{ id: 'p1', text: 'Hello' }] });
  const { writer, storage } = makeWriter(bin);

  const result = await writer.applyOps(WS, DOC, [
    { op: 'create_link', targetDocId: 'target-1' },
  ]);

  t.is(result.applied, 1);
  t.is(result.created.length, 1);
  t.is(result.created[0].op, 'create_link');
  const blockId = result.created[0].blockId;

  const doc = loadDoc(storage.currentBin());
  const block = doc.getMap('blocks').get(blockId) as Y.Map<unknown>;
  t.is(block.get('sys:flavour'), 'affine:embed-linked-doc');
  t.is(block.get('prop:pageId'), 'target-1');
  t.is(block.get('prop:style'), 'vertical');
  t.true(noteChildren(doc).includes(blockId));
});

test('applyOps create_link (embed) on a doc with no note block throws and pushes nothing', async t => {
  const bin = (() => {
    // A doc with only an affine:page, no note - buildLinksDoc always adds a
    // note, so build this edge case directly.
    const doc = new Y.Doc();
    const blocks = doc.getMap('blocks');
    doc.transact(() => {
      const page = new Y.Map<unknown>();
      page.set('sys:id', 'page');
      page.set('sys:flavour', 'affine:page');
      page.set('sys:children', new Y.Array<string>());
      blocks.set('page', page);
    });
    return Y.encodeStateAsUpdate(doc);
  })();
  const { writer, storage } = makeWriter(bin);

  await t.throwsAsync(
    writer.applyOps(WS, DOC, [{ op: 'create_link', targetDocId: 'target-1' }])
  );
  t.is(storage.pushed.length, 0);
});

// 6.2 - create_link (inline)
test('applyOps create_link (inline) inserts a reference space-delta at the anchor (defaults to the last paragraph)', async t => {
  const bin = buildLinksDoc({
    paragraphs: [
      { id: 'p1', text: 'Hello' },
      { id: 'p2', text: 'World' },
    ],
  });
  const { writer, storage } = makeWriter(bin);

  const result = await writer.applyOps(WS, DOC, [
    { op: 'create_link', targetDocId: 'target-1', mode: 'inline' },
  ]);

  t.is(result.created[0].blockId, 'p2');

  const doc = loadDoc(storage.currentBin());
  const block = doc.getMap('blocks').get('p2') as Y.Map<unknown>;
  const refs = referenceOps(block.get('prop:text') as Y.Text);
  t.is(refs.length, 1);
  t.is(refs[0].insert, ' ');
  t.is(refs[0].attributes?.reference?.pageId, 'target-1');
});

test('applyOps create_link (inline) with an explicit anchorBlockId inserts there instead of the default', async t => {
  const bin = buildLinksDoc({
    paragraphs: [
      { id: 'p1', text: 'Hello' },
      { id: 'p2', text: 'World' },
    ],
  });
  const { writer, storage } = makeWriter(bin);

  await writer.applyOps(WS, DOC, [
    {
      op: 'create_link',
      targetDocId: 'target-1',
      mode: 'inline',
      anchorBlockId: 'p1',
    },
  ]);

  const doc = loadDoc(storage.currentBin());
  const p1 = doc.getMap('blocks').get('p1') as Y.Map<unknown>;
  const p2 = doc.getMap('blocks').get('p2') as Y.Map<unknown>;
  t.is(referenceOps(p1.get('prop:text') as Y.Text).length, 1);
  t.is(referenceOps(p2.get('prop:text') as Y.Text).length, 0);
});

// 6.3 - remove_link
test('applyOps remove_link removes an embed block by id (detaching it from the note)', async t => {
  const bin = buildLinksDoc({
    paragraphs: [{ id: 'p1', text: 'Hello' }],
    embeds: [{ id: 'e1', pageId: 'target-1' }],
  });
  const { writer, storage } = makeWriter(bin);

  await writer.applyOps(WS, DOC, [
    { op: 'remove_link', targetDocId: 'target-1', blockId: 'e1' },
  ]);

  const doc = loadDoc(storage.currentBin());
  t.false(doc.getMap('blocks').has('e1'));
  t.false(noteChildren(doc).includes('e1'));
});

test('applyOps remove_link removes a matching inline reference by walking the block delta', async t => {
  const bin = buildLinksDoc({
    paragraphs: [
      { id: 'p1', text: 'Hello', reference: { pageId: 'target-1' } },
    ],
  });
  const { writer, storage } = makeWriter(bin);

  await writer.applyOps(WS, DOC, [
    { op: 'remove_link', targetDocId: 'target-1', blockId: 'p1' },
  ]);

  const doc = loadDoc(storage.currentBin());
  const block = doc.getMap('blocks').get('p1') as Y.Map<unknown>;
  const ytext = block.get('prop:text') as Y.Text;
  t.is(ytext.toString(), 'Hello');
  t.is(referenceOps(ytext).length, 0);
});

test('applyOps remove_link without a blockId searches the whole doc for a matching embed or inline reference', async t => {
  const bin = buildLinksDoc({
    paragraphs: [
      { id: 'p1', text: 'Hello', reference: { pageId: 'target-2' } },
    ],
    embeds: [{ id: 'e1', pageId: 'target-1' }],
  });
  const { writer, storage } = makeWriter(bin);

  await writer.applyOps(WS, DOC, [
    { op: 'remove_link', targetDocId: 'target-1' },
  ]);

  const doc = loadDoc(storage.currentBin());
  t.false(doc.getMap('blocks').has('e1'));
  // The unrelated inline reference to target-2 must be untouched.
  const p1 = doc.getMap('blocks').get('p1') as Y.Map<unknown>;
  t.is(referenceOps(p1.get('prop:text') as Y.Text).length, 1);
});

test('applyOps remove_link with a blockId whose embed targets a different doc throws and pushes nothing', async t => {
  const bin = buildLinksDoc({ embeds: [{ id: 'e1', pageId: 'target-1' }] });
  const { writer, storage } = makeWriter(bin);

  // e1 actually links to target-1, but the caller claims target-2 - must not
  // silently delete the wrong link.
  await t.throwsAsync(
    writer.applyOps(WS, DOC, [
      { op: 'remove_link', targetDocId: 'target-2', blockId: 'e1' },
    ])
  );
  t.is(storage.pushed.length, 0);

  const doc = loadDoc(storage.currentBin());
  t.true(doc.getMap('blocks').has('e1'));
});

test('applyOps remove_link for a target with no matching link anywhere throws and pushes nothing', async t => {
  const bin = buildLinksDoc({ paragraphs: [{ id: 'p1', text: 'Hello' }] });
  const { writer, storage } = makeWriter(bin);

  await t.throwsAsync(
    writer.applyOps(WS, DOC, [{ op: 'remove_link', targetDocId: 'ghost' }])
  );
  t.is(storage.pushed.length, 0);
});

// 6.3 - retarget_link
test("applyOps retarget_link updates an embed block's prop:pageId", async t => {
  const bin = buildLinksDoc({ embeds: [{ id: 'e1', pageId: 'target-1' }] });
  const { writer, storage } = makeWriter(bin);

  await writer.applyOps(WS, DOC, [
    { op: 'retarget_link', blockId: 'e1', toTargetDocId: 'target-2' },
  ]);

  const doc = loadDoc(storage.currentBin());
  const block = doc.getMap('blocks').get('e1') as Y.Map<unknown>;
  t.is(block.get('prop:pageId'), 'target-2');
});

test('applyOps retarget_link replaces an inline reference delta (delete + re-insert at the same offset)', async t => {
  const bin = buildLinksDoc({
    paragraphs: [
      { id: 'p1', text: 'Hello', reference: { pageId: 'target-1' } },
    ],
  });
  const { writer, storage } = makeWriter(bin);

  await writer.applyOps(WS, DOC, [
    {
      op: 'retarget_link',
      blockId: 'p1',
      fromTargetDocId: 'target-1',
      toTargetDocId: 'target-2',
    },
  ]);

  const doc = loadDoc(storage.currentBin());
  const block = doc.getMap('blocks').get('p1') as Y.Map<unknown>;
  const ytext = block.get('prop:text') as Y.Text;
  const refs = referenceOps(ytext);
  t.is(refs.length, 1);
  t.is(refs[0].attributes?.reference?.pageId, 'target-2');
  t.is(ytext.toString(), 'Hello ');
});

test('applyOps retarget_link with a blockId whose embed targets a different fromTargetDocId throws and pushes nothing', async t => {
  const bin = buildLinksDoc({ embeds: [{ id: 'e1', pageId: 'target-1' }] });
  const { writer, storage } = makeWriter(bin);

  // e1 actually links to target-1, but the caller claims fromTargetDocId
  // target-9 - must not silently retarget the wrong link.
  await t.throwsAsync(
    writer.applyOps(WS, DOC, [
      {
        op: 'retarget_link',
        blockId: 'e1',
        fromTargetDocId: 'target-9',
        toTargetDocId: 'target-2',
      },
    ])
  );
  t.is(storage.pushed.length, 0);

  const doc = loadDoc(storage.currentBin());
  const block = doc.getMap('blocks').get('e1') as Y.Map<unknown>;
  t.is(block.get('prop:pageId'), 'target-1');
});

test('applyOps retarget_link without a blockId locates the link doc-wide via fromTargetDocId', async t => {
  const bin = buildLinksDoc({ embeds: [{ id: 'e1', pageId: 'target-1' }] });
  const { writer, storage } = makeWriter(bin);

  await writer.applyOps(WS, DOC, [
    {
      op: 'retarget_link',
      fromTargetDocId: 'target-1',
      toTargetDocId: 'target-2',
    },
  ]);

  const doc = loadDoc(storage.currentBin());
  const block = doc.getMap('blocks').get('e1') as Y.Map<unknown>;
  t.is(block.get('prop:pageId'), 'target-2');
});

test('applyOps retarget_link with neither blockId nor fromTargetDocId throws and pushes nothing', async t => {
  const bin = buildLinksDoc({ embeds: [{ id: 'e1', pageId: 'target-1' }] });
  const { writer, storage } = makeWriter(bin);

  await t.throwsAsync(
    writer.applyOps(WS, DOC, [
      { op: 'retarget_link', toTargetDocId: 'target-2' },
    ])
  );
  t.is(storage.pushed.length, 0);
});

// 6.4 - create_doc_and_link
test('applyOps create_doc_and_link creates a new doc via DocWriter and embed-links to it (default mode)', async t => {
  const bin = buildLinksDoc({ paragraphs: [{ id: 'p1', text: 'Hello' }] });
  const { writer, storage, docWriter } = makeWriter(bin);

  const result = await writer.applyOps(WS, DOC, [
    { op: 'create_doc_and_link', title: 'Spun off' },
  ]);

  t.is(docWriter.created.length, 1);
  t.is(docWriter.created[0].title, 'Spun off');
  t.is(docWriter.created[0].workspaceId, WS);
  t.is(result.created[0].op, 'create_doc_and_link');
  t.is(result.created[0].newDocId, 'new-doc-1');

  const doc = loadDoc(storage.currentBin());
  const block = doc
    .getMap('blocks')
    .get(result.created[0].blockId) as Y.Map<unknown>;
  t.is(block.get('sys:flavour'), 'affine:embed-linked-doc');
  t.is(block.get('prop:pageId'), 'new-doc-1');
});

test('applyOps create_doc_and_link (embed) on a source doc with no note block throws and creates no new doc', async t => {
  const bin = (() => {
    // A doc with only an affine:page, no note - mirrors the "create_link on a
    // doc with no note block" fixture above. Validation for
    // create_doc_and_link's embed mode must run BEFORE DocWriter.createDoc is
    // called, so a missing note must never leave a newly-created, registered
    // -but-orphaned doc behind.
    const doc = new Y.Doc();
    const blocks = doc.getMap('blocks');
    doc.transact(() => {
      const page = new Y.Map<unknown>();
      page.set('sys:id', 'page');
      page.set('sys:flavour', 'affine:page');
      page.set('sys:children', new Y.Array<string>());
      blocks.set('page', page);
    });
    return Y.encodeStateAsUpdate(doc);
  })();
  const { writer, storage, docWriter } = makeWriter(bin);

  await t.throwsAsync(
    writer.applyOps(WS, DOC, [
      { op: 'create_doc_and_link', title: 'Should not be created' },
    ])
  );
  t.is(storage.pushed.length, 0);
  // The critical assertion: DocWriter.createDoc must never have been
  // reached, so no new doc was registered anywhere (no orphan page).
  t.is(docWriter.created.length, 0);
});

test('applyOps create_doc_and_link (inline) links via an inline reference at the anchor', async t => {
  const bin = buildLinksDoc({ paragraphs: [{ id: 'p1', text: 'Hello' }] });
  const { writer, storage } = makeWriter(bin);

  const result = await writer.applyOps(WS, DOC, [
    { op: 'create_doc_and_link', title: 'Spun off', mode: 'inline' },
  ]);

  t.is(result.created[0].blockId, 'p1');
  const doc = loadDoc(storage.currentBin());
  const block = doc.getMap('blocks').get('p1') as Y.Map<unknown>;
  const refs = referenceOps(block.get('prop:text') as Y.Text);
  t.is(refs.length, 1);
  t.is(refs[0].attributes?.reference?.pageId, result.created[0].newDocId);
});

// 6.5 - missing target/anchor -> a clear error the tool layer wraps as toolError.
// Name -> id ambiguity resolution is intentionally the TOOL layer's job (the
// design doc's Decision 4/5): `applyOps` only ever takes ids, so there is no
// name ambiguity to test at this layer - only "missing" cases.
test('applyOps create_link (inline) with an explicit missing anchorBlockId throws a clear error and pushes nothing', async t => {
  const bin = buildLinksDoc({ paragraphs: [{ id: 'p1', text: 'Hello' }] });
  const { writer, storage } = makeWriter(bin);

  await t.throwsAsync(
    writer.applyOps(WS, DOC, [
      {
        op: 'create_link',
        targetDocId: 'target-1',
        mode: 'inline',
        anchorBlockId: 'ghost',
      },
    ])
  );
  t.is(storage.pushed.length, 0);
});

test('applyOps on a missing source doc throws and pushes nothing', async t => {
  const { writer, storage } = makeWriter(null);
  await t.throwsAsync(
    writer.applyOps(WS, DOC, [{ op: 'create_link', targetDocId: 'target-1' }])
  );
  t.is(storage.pushed.length, 0);
});

test('applyOps remove_link for an unknown blockId throws a clear error and pushes nothing', async t => {
  const bin = buildLinksDoc({ paragraphs: [{ id: 'p1', text: 'Hello' }] });
  const { writer, storage } = makeWriter(bin);

  await t.throwsAsync(
    writer.applyOps(WS, DOC, [
      { op: 'remove_link', targetDocId: 'target-1', blockId: 'ghost' },
    ])
  );
  t.is(storage.pushed.length, 0);
});

// batch semantics: an invalid op later in the batch aborts the whole batch
// (mirrors DocPropertiesWriter's "no partial write" guarantee), including
// not creating any doc for an earlier valid create_doc_and_link op.
test('applyOps aborts the whole batch when a later op is invalid (no partial write, no doc created)', async t => {
  const bin = buildLinksDoc({ paragraphs: [{ id: 'p1', text: 'Hello' }] });
  const { writer, storage, docWriter } = makeWriter(bin);

  await t.throwsAsync(
    writer.applyOps(WS, DOC, [
      { op: 'create_doc_and_link', title: 'Should not be created' },
      { op: 'remove_link', targetDocId: 'ghost', blockId: 'does-not-exist' },
    ])
  );

  t.is(storage.pushed.length, 0);
  t.is(docWriter.created.length, 0);
});
