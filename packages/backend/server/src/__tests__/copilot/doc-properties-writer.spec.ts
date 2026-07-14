import test from 'ava';
import * as Y from 'yjs';

import {
  readDocPropertiesRow,
  readFavorite,
  readPageMetaFromRoot,
  readPropertyDefs,
  readTagOptionsFromRoot,
} from '../../core/doc/doc-properties-reader';
import {
  docCustomPropertyInfoDocId,
  docPropertiesDocId,
  favoriteDocId,
} from '../../core/doc/doc-properties-types';
import {
  DocPropertiesCodec,
  DocPropertiesWriter,
} from '../../core/doc/doc-properties-writer';
import {
  buildCustomPropertyInfoDoc,
  buildDocPropertiesDoc,
  buildFavoriteDoc,
  buildRootDoc,
} from './fixtures/doc-properties-doc';

const WS = 'ws1';
const DOC = 'doc-1';
const USER = 'user-1';

/**
 * In-memory multi-doc stand-in for `PgWorkspaceDocStorageAdapter`, keyed by
 * docId. Unlike the single-bin `FakeStorage` used by `database-writer-*.spec.ts`
 * (one board doc per call), `DocPropertiesWriter` reads/writes up to four
 * distinct docs (root, docProperties, docCustomPropertyInfo, favorites) per
 * `applyOps` call, so this fake tracks a bin per docId and merges pushed
 * deltas back in so a later `getDoc` reflects the write (needed for the
 * multi-op / round-trip tests below).
 */
class FakeMultiDocStorage {
  private readonly docs = new Map<string, Uint8Array>();
  pushed: { docId: string; delta: Uint8Array }[] = [];

  set(docId: string, bin: Uint8Array | null | undefined): void {
    if (bin) {
      this.docs.set(docId, bin);
    }
  }

  async getDoc(_workspaceId: string, docId: string) {
    const bin = this.docs.get(docId);
    if (!bin) {
      return null;
    }
    return { spaceId: _workspaceId, docId, bin, timestamp: Date.now() };
  }

  async pushDocUpdates(
    _workspaceId: string,
    docId: string,
    updates: Uint8Array[],
    _editorId?: string
  ) {
    for (const delta of updates) {
      this.pushed.push({ docId, delta });
      const doc = new Y.Doc();
      const existing = this.docs.get(docId);
      if (existing) {
        Y.applyUpdate(doc, existing);
      }
      Y.applyUpdate(doc, delta);
      this.docs.set(docId, Y.encodeStateAsUpdate(doc));
    }
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

function makeWriter(seed: {
  root?: Uint8Array;
  props?: Uint8Array;
  info?: Uint8Array;
  favorite?: Uint8Array;
}) {
  const storage = new FakeMultiDocStorage();
  if (seed.root) storage.set(WS, seed.root);
  if (seed.props) storage.set(docPropertiesDocId(WS), seed.props);
  if (seed.info) storage.set(docCustomPropertyInfoDocId(WS), seed.info);
  if (seed.favorite) storage.set(favoriteDocId(USER, WS), seed.favorite);
  const event = new FakeEventBus();
  // Cast: the fakes only implement the two methods DocPropertiesWriter's base
  // class (YjsDeltaWriter) actually calls, not the full adapter/EventBus surface.
  const writer = new DocPropertiesWriter(storage as any, event as any);
  return { writer, storage, event };
}

// 3.1 - value codec
test('DocPropertiesCodec encodes/decodes text', t => {
  t.is(DocPropertiesCodec.encode('text', 'hello'), 'hello');
  t.is(DocPropertiesCodec.decode('text', 'hello'), 'hello');
});

test('DocPropertiesCodec encodes/decodes number', t => {
  t.is(DocPropertiesCodec.encode('number', 42), '42');
  t.is(DocPropertiesCodec.decode('number', '42'), 42);
});

test('DocPropertiesCodec encodes/decodes checkbox', t => {
  t.is(DocPropertiesCodec.encode('checkbox', true), 'true');
  t.is(DocPropertiesCodec.encode('checkbox', false), 'false');
  t.is(DocPropertiesCodec.decode('checkbox', 'true'), true);
  t.is(DocPropertiesCodec.decode('checkbox', 'false'), false);
});

test('DocPropertiesCodec encodes/decodes date as a best-effort passthrough', t => {
  t.is(DocPropertiesCodec.encode('date', '2026-07-14'), '2026-07-14');
  t.is(DocPropertiesCodec.decode('date', '2026-07-14'), '2026-07-14');
});

test('DocPropertiesCodec encodes/decodes tags as comma-joined ids', t => {
  t.is(DocPropertiesCodec.encode('tags', ['t1', 't2']), 't1,t2');
  t.deepEqual(DocPropertiesCodec.decode('tags', 't1,t2'), ['t1', 't2']);
  t.deepEqual(DocPropertiesCodec.decode('tags', ''), []);
});

// 3.2/3.3 - core metadata ops
test('applyOps set_title/set_trash update the root doc page entry', async t => {
  const root = buildRootDoc({
    pages: [{ id: DOC, title: 'Old', trash: false }],
  });
  const { writer, storage } = makeWriter({ root });

  const result = await writer.applyOps(WS, DOC, USER, [
    { op: 'set_title', title: 'New Title' },
    { op: 'set_trash', trash: true },
  ]);

  t.is(result.applied, 2);
  const merged = await storage.getDoc(WS, WS);
  const page = readPageMetaFromRoot(merged!.bin, DOC);
  t.is(page?.title, 'New Title');
  t.is(page?.trash, true);
});

test('applyOps set_journal/set_mode write docProperties', async t => {
  const root = buildRootDoc({ pages: [{ id: DOC }] });
  const { writer, storage } = makeWriter({ root });

  await writer.applyOps(WS, DOC, USER, [
    { op: 'set_journal', journal: '2026-07-14' },
    { op: 'set_mode', mode: 'edgeless' },
  ]);

  const propsRec = await storage.getDoc(WS, docPropertiesDocId(WS));
  const row = readDocPropertiesRow(propsRec!.bin, DOC);
  t.is(row.journal, '2026-07-14');
  t.is(row.primaryMode, 'edgeless');
});

test('applyOps set_journal with "" clears an existing journal date', async t => {
  const props = buildDocPropertiesDoc({ [DOC]: { journal: '2026-01-01' } });
  const { writer, storage } = makeWriter({ props });

  await writer.applyOps(WS, DOC, USER, [{ op: 'set_journal', journal: '' }]);

  const propsRec = await storage.getDoc(WS, docPropertiesDocId(WS));
  const row = readDocPropertiesRow(propsRec!.bin, DOC);
  t.is(row.journal, null);
});

test('applyOps set_journal rejects a malformed date and pushes nothing', async t => {
  const { writer, storage } = makeWriter({});
  await t.throwsAsync(
    writer.applyOps(WS, DOC, USER, [
      { op: 'set_journal', journal: 'not-a-date' },
    ])
  );
  t.is(storage.pushed.length, 0);
});

test('applyOps set_title on a doc missing from meta.pages throws and pushes nothing', async t => {
  const root = buildRootDoc({ pages: [{ id: 'other-doc' }] });
  const { writer, storage } = makeWriter({ root });
  await t.throwsAsync(
    writer.applyOps(WS, DOC, USER, [{ op: 'set_title', title: 'x' }])
  );
  t.is(storage.pushed.length, 0);
});

// 4.1 - tags
test('applyOps create_tag adds a new tag option to meta.properties.tags.options', async t => {
  const root = buildRootDoc({ pages: [{ id: DOC }], tagOptions: [] });
  const { writer, storage } = makeWriter({ root });

  const result = await writer.applyOps(WS, DOC, USER, [
    { op: 'create_tag', name: 'Urgent', color: 'red' },
  ]);

  t.is(result.createdTagIds.length, 1);
  const merged = await storage.getDoc(WS, WS);
  const options = readTagOptionsFromRoot(merged!.bin);
  t.deepEqual(options, [
    { id: result.createdTagIds[0], value: 'Urgent', color: 'red' },
  ]);
});

test('applyOps create_tag rejects a duplicate name and pushes nothing', async t => {
  const root = buildRootDoc({
    pages: [{ id: DOC }],
    tagOptions: [{ id: 't1', value: 'Urgent', color: 'red' }],
  });
  const { writer, storage } = makeWriter({ root });
  await t.throwsAsync(
    writer.applyOps(WS, DOC, USER, [{ op: 'create_tag', name: 'Urgent' }])
  );
  t.is(storage.pushed.length, 0);
});

test('applyOps add_tag by name adds the resolved tag id to the doc', async t => {
  const root = buildRootDoc({
    pages: [{ id: DOC, tags: [] }],
    tagOptions: [{ id: 't1', value: 'Urgent', color: 'red' }],
  });
  const { writer, storage } = makeWriter({ root });

  await writer.applyOps(WS, DOC, USER, [{ op: 'add_tag', tag: 'Urgent' }]);

  const merged = await storage.getDoc(WS, WS);
  t.deepEqual(readPageMetaFromRoot(merged!.bin, DOC)?.tagIds, ['t1']);
});

test('applyOps add_tag by id also works', async t => {
  const root = buildRootDoc({
    pages: [{ id: DOC, tags: [] }],
    tagOptions: [{ id: 't1', value: 'Urgent', color: 'red' }],
  });
  const { writer, storage } = makeWriter({ root });

  await writer.applyOps(WS, DOC, USER, [{ op: 'add_tag', tag: 't1' }]);

  const merged = await storage.getDoc(WS, WS);
  t.deepEqual(readPageMetaFromRoot(merged!.bin, DOC)?.tagIds, ['t1']);
});

test('applyOps add_tag for an unknown name errors instructing create_tag first', async t => {
  const root = buildRootDoc({ pages: [{ id: DOC }], tagOptions: [] });
  const { writer, storage } = makeWriter({ root });
  const err = await t.throwsAsync(
    writer.applyOps(WS, DOC, USER, [{ op: 'add_tag', tag: 'Ghost' }])
  );
  t.true(err.message.includes('create_tag'));
  t.is(storage.pushed.length, 0);
});

test('applyOps add_tag with an ambiguous name lists candidate ids', async t => {
  const root = buildRootDoc({
    pages: [{ id: DOC }],
    tagOptions: [
      { id: 't1', value: 'Work', color: 'red' },
      { id: 't2', value: 'Work', color: 'blue' },
    ],
  });
  const { writer } = makeWriter({ root });
  const err = await t.throwsAsync(
    writer.applyOps(WS, DOC, USER, [{ op: 'add_tag', tag: 'Work' }])
  );
  t.true(err.message.includes('t1'));
  t.true(err.message.includes('t2'));
});

test('applyOps remove_tag removes the resolved tag id from the doc', async t => {
  const root = buildRootDoc({
    pages: [{ id: DOC, tags: ['t1'] }],
    tagOptions: [{ id: 't1', value: 'Urgent', color: 'red' }],
  });
  const { writer, storage } = makeWriter({ root });

  await writer.applyOps(WS, DOC, USER, [{ op: 'remove_tag', tag: 'Urgent' }]);

  const merged = await storage.getDoc(WS, WS);
  t.deepEqual(readPageMetaFromRoot(merged!.bin, DOC)?.tagIds, []);
});

test('applyOps remove_tag for a tag not present on the doc errors clearly and pushes nothing', async t => {
  const root = buildRootDoc({
    pages: [{ id: DOC, tags: [] }],
    tagOptions: [{ id: 't1', value: 'Urgent', color: 'red' }],
  });
  const { writer, storage } = makeWriter({ root });
  const err = await t.throwsAsync(
    writer.applyOps(WS, DOC, USER, [{ op: 'remove_tag', tag: 'Urgent' }])
  );
  t.true(err.message.includes('not present'));
  t.is(storage.pushed.length, 0);
});

// 4.2 - custom properties
test('applyOps define_property writes a new definition row', async t => {
  const { writer, storage } = makeWriter({});

  const result = await writer.applyOps(WS, DOC, USER, [
    { op: 'define_property', name: 'Summary', type: 'text' },
  ]);

  t.is(result.createdPropertyIds.length, 1);
  const infoRec = await storage.getDoc(WS, docCustomPropertyInfoDocId(WS));
  const defs = readPropertyDefs(infoRec!.bin);
  const def = defs.get(result.createdPropertyIds[0]);
  t.is(def?.name, 'Summary');
  t.is(def?.type, 'text');
});

test('applyOps define_property rejects a duplicate name and pushes nothing', async t => {
  const info = buildCustomPropertyInfoDoc([
    { id: 'p1', name: 'Summary', type: 'text' },
  ]);
  const { writer, storage } = makeWriter({ info });
  await t.throwsAsync(
    writer.applyOps(WS, DOC, USER, [
      { op: 'define_property', name: 'Summary', type: 'number' },
    ])
  );
  t.is(storage.pushed.length, 0);
});

test('applyOps define_property rejects an unsupported type (select)', async t => {
  const { writer } = makeWriter({});
  const err = await t.throwsAsync(
    writer.applyOps(WS, DOC, USER, [
      { op: 'define_property', name: 'Status', type: 'select' },
    ])
  );
  t.true(err.message.includes('select'));
  t.true(err.message.includes('database block'));
});

test('applyOps set_property writes the encoded value under custom:<id>', async t => {
  const info = buildCustomPropertyInfoDoc([
    { id: 'p1', name: 'Priority', type: 'number' },
  ]);
  const { writer, storage } = makeWriter({ info });

  await writer.applyOps(WS, DOC, USER, [
    { op: 'set_property', property: 'Priority', value: 5 },
  ]);

  const propsRec = await storage.getDoc(WS, docPropertiesDocId(WS));
  const row = readDocPropertiesRow(propsRec!.bin, DOC);
  t.is(row.custom.p1, '5');
});

test('applyOps set_property for an undefined property errors instructing define_property first', async t => {
  const { writer, storage } = makeWriter({});
  const err = await t.throwsAsync(
    writer.applyOps(WS, DOC, USER, [
      { op: 'set_property', property: 'Ghost', value: 1 },
    ])
  );
  t.true(err.message.includes('define_property'));
  t.is(storage.pushed.length, 0);
});

// 4.3 - favorite (user-scoped)
test('applyOps set_favorite:true creates the favorites doc row for the acting user', async t => {
  const { writer, storage } = makeWriter({});

  await writer.applyOps(WS, DOC, USER, [
    { op: 'set_favorite', favorite: true },
  ]);

  const favRec = await storage.getDoc(WS, favoriteDocId(USER, WS));
  t.true(readFavorite(favRec!.bin, DOC));
});

test('applyOps set_favorite:false soft-deletes an existing favorite row', async t => {
  const favorite = buildFavoriteDoc([{ docId: DOC }]);
  const { writer, storage } = makeWriter({ favorite });

  await writer.applyOps(WS, DOC, USER, [
    { op: 'set_favorite', favorite: false },
  ]);

  const favRec = await storage.getDoc(WS, favoriteDocId(USER, WS));
  t.false(readFavorite(favRec!.bin, DOC));
});

// 4.5/4.6 - batch semantics
test('applyOps chains create_tag then add_tag within the same batch', async t => {
  const root = buildRootDoc({ pages: [{ id: DOC }], tagOptions: [] });
  const { writer, storage } = makeWriter({ root });

  const result = await writer.applyOps(WS, DOC, USER, [
    { op: 'create_tag', name: 'Urgent', color: 'red' },
    { op: 'add_tag', tag: 'Urgent' },
  ]);

  const merged = await storage.getDoc(WS, WS);
  const page = readPageMetaFromRoot(merged!.bin, DOC);
  t.deepEqual(page?.tagIds, [result.createdTagIds[0]]);
});

test('applyOps aborts the whole batch when a later op is invalid (no partial write)', async t => {
  const root = buildRootDoc({
    pages: [{ id: DOC, title: 'Old' }],
    tagOptions: [],
  });
  const { writer, storage } = makeWriter({ root });

  await t.throwsAsync(
    writer.applyOps(WS, DOC, USER, [
      { op: 'set_title', title: 'New' },
      { op: 'add_tag', tag: 'Ghost' }, // invalid: no such tag, no create_tag
    ])
  );

  t.is(storage.pushed.length, 0);
  const merged = await storage.getDoc(WS, WS);
  const page = readPageMetaFromRoot(merged!.bin, DOC);
  t.is(page?.title, 'Old'); // set_title must NOT have been applied
});

// 9.1 - round-trip across all four docs in one batch
test('applyOps round-trips every attribute across all four docs in one batch', async t => {
  const root = buildRootDoc({
    pages: [{ id: DOC, title: 'Old', trash: false }],
    tagOptions: [],
  });
  const info = buildCustomPropertyInfoDoc([
    { id: 'p1', name: 'Priority', type: 'number' },
  ]);
  const { writer, storage } = makeWriter({ root, info });

  const result = await writer.applyOps(WS, DOC, USER, [
    { op: 'set_title', title: 'New Title' },
    { op: 'set_trash', trash: true },
    { op: 'set_journal', journal: '2026-07-14' },
    { op: 'set_mode', mode: 'edgeless' },
    { op: 'create_tag', name: 'Urgent', color: 'red' },
    { op: 'add_tag', tag: 'Urgent' },
    { op: 'set_property', property: 'Priority', value: 5 },
    { op: 'set_favorite', favorite: true },
  ]);

  t.is(result.applied, 8);

  const rootRec = await storage.getDoc(WS, WS);
  const page = readPageMetaFromRoot(rootRec!.bin, DOC);
  t.is(page?.title, 'New Title');
  t.is(page?.trash, true);
  t.deepEqual(page?.tagIds, [result.createdTagIds[0]]);

  const propsRec = await storage.getDoc(WS, docPropertiesDocId(WS));
  const row = readDocPropertiesRow(propsRec!.bin, DOC);
  t.is(row.journal, '2026-07-14');
  t.is(row.primaryMode, 'edgeless');
  t.is(row.custom.p1, '5');

  const favRec = await storage.getDoc(WS, favoriteDocId(USER, WS));
  t.true(readFavorite(favRec!.bin, DOC));
});

// 9.2 - concurrency: writer delta + simulated concurrent client edit merge
test('a DocPropertiesWriter set_title edit and a concurrent client trash edit merge without lost updates, regardless of apply order', async t => {
  const baseBin = buildRootDoc({
    pages: [{ id: DOC, title: 'Original', trash: false }],
    tagOptions: [],
  });

  // Delta A: DocPropertiesWriter's set_title, against a fresh store seeded
  // with baseBin - the "server-side copilot tool" edit.
  const storageA = new FakeMultiDocStorage();
  storageA.set(WS, baseBin);
  const writer = new DocPropertiesWriter(
    storageA as any,
    new FakeEventBus() as any
  );
  await writer.applyOps(WS, DOC, USER, [
    { op: 'set_title', title: 'Edited by writer' },
  ]);
  const deltaA = storageA.pushed[0].delta;

  // Delta B: a concurrent client's direct Yjs edit of the SAME baseBin,
  // built with no knowledge of A - simulates another user editing at the
  // same time.
  const docB = new Y.Doc();
  Y.applyUpdate(docB, baseBin);
  const beforeSV = Y.encodeStateVector(docB);
  docB.transact(() => {
    const meta = docB.getMap('meta');
    const pages = meta.get('pages') as Y.Array<Y.Map<unknown>>;
    const page = pages.toArray().find(p => p.get('id') === DOC)!;
    page.set('trash', true);
  });
  const deltaB = Y.encodeStateAsUpdate(docB, beforeSV);

  function mergeOnto(deltas: Uint8Array[]): Uint8Array {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, baseBin);
    for (const delta of deltas) {
      Y.applyUpdate(doc, delta);
    }
    return Y.encodeStateAsUpdate(doc);
  }

  const mergedAB = mergeOnto([deltaA, deltaB]);
  const mergedBA = mergeOnto([deltaB, deltaA]);

  for (const merged of [mergedAB, mergedBA]) {
    const page = readPageMetaFromRoot(merged, DOC);
    t.is(page?.title, 'Edited by writer');
    t.is(page?.trash, true);
  }

  // CRDT commutativity: both apply orders converge to the same final state.
  t.deepEqual(mergedAB, mergedBA);
});
