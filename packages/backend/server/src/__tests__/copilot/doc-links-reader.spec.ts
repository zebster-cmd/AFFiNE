import test from 'ava';

import { DocLinksReader } from '../../core/doc/doc-links-reader';
import { SearchTable } from '../../plugins/indexer/tables';
import {
  type AggregateInput,
  type SearchInput,
  type SearchQuery,
  SearchQueryType,
} from '../../plugins/indexer/types';

/**
 * Minimal stand-in for `IndexerService`: only `search`/`aggregate` are
 * exercised by `DocLinksReader`, so the fake implements just those two,
 * dispatching on `input.table` to hand back fixture rows - per the task
 * brief's "keep the IndexerService calls behind a tiny seam" instruction (no
 * real search provider is stood up).
 */
class FakeIndexer {
  calls: {
    kind: 'search' | 'aggregate';
    input: SearchInput | AggregateInput;
  }[] = [];

  constructor(
    private readonly blockNodes: { fields: Record<string, unknown[]> }[],
    private readonly docNodes: { fields: Record<string, unknown[]> }[],
    private readonly buckets: {
      key: string;
      count: number;
      hits: { nodes: { fields: Record<string, unknown[]> }[] };
    }[]
  ) {}

  async search(input: SearchInput) {
    this.calls.push({ kind: 'search', input });
    if (input.table === SearchTable.doc) {
      return { nodes: this.docNodes };
    }
    return { nodes: this.blockNodes };
  }

  async aggregate(input: AggregateInput) {
    this.calls.push({ kind: 'aggregate', input });
    return { buckets: this.buckets };
  }
}

function findQuery(query: SearchQuery, field: string): SearchQuery | undefined {
  if (query.field === field) {
    return query;
  }
  for (const sub of query.queries ?? []) {
    const found = findQuery(sub, field);
    if (found) {
      return found;
    }
  }
  return undefined;
}

const WS = 'ws1';
const DOC = 'doc-1';

// 5.1 - outgoing links via IndexerService (docId==X ∧ exists refDocId), resolved titles
test('read resolves outgoing links from the block index, with titles resolved from the doc index', async t => {
  const indexer = new FakeIndexer(
    [
      { fields: { blockId: ['blk1'], refDocId: ['target-1'] } },
      // no refDocId - falls back to parsing the stored `ref` JSON blob
      {
        fields: {
          blockId: ['blk2'],
          ref: [JSON.stringify({ docId: 'target-2' })],
        },
      },
    ],
    [
      { fields: { docId: ['target-1'], title: ['Target One'] } },
      { fields: { docId: ['target-2'], title: ['Target Two'] } },
    ],
    []
  );
  const reader = new DocLinksReader(indexer as any);

  const result = await reader.read(WS, DOC);

  t.deepEqual(result.outgoing, [
    { docId: 'target-1', blockId: 'blk1', title: 'Target One' },
    { docId: 'target-2', blockId: 'blk2', title: 'Target Two' },
  ]);
  t.deepEqual(result.backlinks, []);
});

test('read outgoing query requires docId==X and exists(refDocId)', async t => {
  const indexer = new FakeIndexer([], [], []);
  const reader = new DocLinksReader(indexer as any);

  await reader.read(WS, DOC);

  const searchCall = indexer.calls.find(
    c =>
      c.kind === 'search' &&
      (c.input as SearchInput).table === SearchTable.block
  );
  t.truthy(searchCall);
  const query = (searchCall!.input as SearchInput).query;
  const docIdMatch = findQuery(query, 'docId');
  const existsRefDocId = findQuery(query, 'refDocId');
  t.is(docIdMatch?.match, DOC);
  t.is(existsRefDocId?.type, SearchQueryType.exists);
});

test('read skips a block whose fields carry neither refDocId nor a parseable ref', async t => {
  const indexer = new FakeIndexer(
    [{ fields: { blockId: ['blk1'], ref: ['not-json'] } }],
    [],
    []
  );
  const reader = new DocLinksReader(indexer as any);

  const result = await reader.read(WS, DOC);
  t.deepEqual(result.outgoing, []);
});

// 5.2 - backlinks via aggregate (refDocId==X group by docId)
test('read resolves backlinks via the aggregate query, with titles resolved from the doc index', async t => {
  const indexer = new FakeIndexer(
    [],
    [{ fields: { docId: ['source-1'], title: ['Source One'] } }],
    [
      {
        key: 'source-1',
        count: 2,
        hits: { nodes: [{ fields: { blockId: ['blk9'] } }] },
      },
    ]
  );
  const reader = new DocLinksReader(indexer as any);

  const result = await reader.read(WS, DOC);

  t.deepEqual(result.backlinks, [
    { docId: 'source-1', blockId: 'blk9', title: 'Source One' },
  ]);
  t.deepEqual(result.outgoing, []);
});

test('read backlinks aggregate query groups on docId and matches refDocId==X', async t => {
  const indexer = new FakeIndexer([], [], []);
  const reader = new DocLinksReader(indexer as any);

  await reader.read(WS, DOC);

  const aggCall = indexer.calls.find(c => c.kind === 'aggregate');
  t.truthy(aggCall);
  const input = aggCall!.input as AggregateInput;
  t.is(input.field, 'docId');
  const refDocIdMatch = findQuery(input.query, 'refDocId');
  t.is(refDocIdMatch?.match, DOC);
});

// 5.3 - overall shaping / no title lookup when there is nothing to resolve
test('read returns empty outgoing/backlinks without a title lookup when nothing links', async t => {
  const indexer = new FakeIndexer([], [], []);
  const reader = new DocLinksReader(indexer as any);

  const result = await reader.read(WS, DOC);

  t.deepEqual(result, { outgoing: [], backlinks: [] });
  t.false(
    indexer.calls.some(
      c =>
        c.kind === 'search' &&
        (c.input as SearchInput).table === SearchTable.doc
    )
  );
});

test('read falls back to an empty title when the doc index has no match for a target', async t => {
  const indexer = new FakeIndexer(
    [{ fields: { blockId: ['blk1'], refDocId: ['target-1'] } }],
    [],
    []
  );
  const reader = new DocLinksReader(indexer as any);

  const result = await reader.read(WS, DOC);
  t.deepEqual(result.outgoing, [
    { docId: 'target-1', blockId: 'blk1', title: undefined },
  ]);
});
