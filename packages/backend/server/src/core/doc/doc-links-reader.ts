import { Injectable } from '@nestjs/common';

import { IndexerService } from '../../plugins/indexer/service';
import { SearchTable } from '../../plugins/indexer/tables';
import {
  type AggregateInput,
  type SearchInput,
  SearchQueryOccur,
  SearchQueryType,
} from '../../plugins/indexer/types';

/** One resolved link edge, either outgoing (this doc -> target) or a backlink (source -> this doc). */
export interface LinkRef {
  /** The OTHER doc in this edge (outgoing: the target; backlinks: the source). */
  docId: string;
  /** The block, in whichever doc holds the reference, that carries the link. */
  blockId?: string;
  /** Best-effort resolved title of {@link docId}, from the indexer's `doc` table. */
  title?: string;
}

/** `DocLinksReader.read`'s result: a doc's outgoing links and incoming backlinks. */
export interface DocLinksView {
  outgoing: LinkRef[];
  backlinks: LinkRef[];
}

const LINK_FIELDS_LIMIT = 1000;

/**
 * Reads a doc's outgoing links and backlinks from the `IndexerService` block
 * index - no per-doc scan. Per the change's design.md (Decision 5):
 * - outgoing: `block` rows where `docId == docId` AND `exists refDocId`.
 * - backlinks: `block` rows aggregated on `docId` where `refDocId == docId`.
 *
 * Only calls `this.indexer.search`/`aggregate` (both already used elsewhere in
 * this service), so a unit test can inject a fake object implementing just
 * those two methods instead of standing up a real search provider.
 */
@Injectable()
export class DocLinksReader {
  constructor(private readonly indexer: IndexerService) {}

  async read(workspaceId: string, docId: string): Promise<DocLinksView> {
    const [outgoing, backlinks] = await Promise.all([
      this.readOutgoing(workspaceId, docId),
      this.readBacklinks(workspaceId, docId),
    ]);

    const titles = await this.resolveTitles(workspaceId, [
      ...outgoing.map(link => link.docId),
      ...backlinks.map(link => link.docId),
    ]);

    return {
      outgoing: outgoing.map(link => ({
        ...link,
        title: titles.get(link.docId),
      })),
      backlinks: backlinks.map(link => ({
        ...link,
        title: titles.get(link.docId),
      })),
    };
  }

  /** `block` rows in `docId` that carry an outgoing reference. */
  private async readOutgoing(
    workspaceId: string,
    docId: string
  ): Promise<LinkRef[]> {
    const input: SearchInput = {
      table: SearchTable.block,
      query: {
        type: SearchQueryType.boolean,
        occur: SearchQueryOccur.must,
        queries: [
          {
            type: SearchQueryType.match,
            field: 'workspaceId',
            match: workspaceId,
          },
          { type: SearchQueryType.match, field: 'docId', match: docId },
          { type: SearchQueryType.exists, field: 'refDocId' },
        ],
      },
      options: {
        fields: ['blockId', 'refDocId', 'ref'],
        pagination: { limit: LINK_FIELDS_LIMIT },
      },
    };
    const result = await this.indexer.search(input);

    const links: LinkRef[] = [];
    for (const node of result.nodes) {
      const targetDocId = resolveRefDocId(node.fields);
      if (!targetDocId) {
        continue;
      }
      links.push({
        docId: targetDocId,
        blockId: firstString(node.fields.blockId),
      });
    }
    return links;
  }

  /** `block` rows anywhere in the workspace that reference `docId`, grouped by their own doc. */
  private async readBacklinks(
    workspaceId: string,
    docId: string
  ): Promise<LinkRef[]> {
    const input: AggregateInput = {
      table: SearchTable.block,
      field: 'docId',
      query: {
        type: SearchQueryType.boolean,
        occur: SearchQueryOccur.must,
        queries: [
          {
            type: SearchQueryType.match,
            field: 'workspaceId',
            match: workspaceId,
          },
          { type: SearchQueryType.match, field: 'refDocId', match: docId },
        ],
      },
      options: {
        hits: {
          fields: ['blockId'],
          pagination: { limit: 1 },
        },
        pagination: { limit: LINK_FIELDS_LIMIT },
      },
    };
    const result = await this.indexer.aggregate(input);

    return result.buckets.map(bucket => ({
      docId: bucket.key,
      blockId: firstString(bucket.hits.nodes[0]?.fields.blockId),
    }));
  }

  /** Best-effort title lookup for a set of doc ids, via the indexer's `doc` table. */
  private async resolveTitles(
    workspaceId: string,
    docIds: string[]
  ): Promise<Map<string, string>> {
    const uniqueIds = [...new Set(docIds)];
    const titles = new Map<string, string>();
    if (uniqueIds.length === 0) {
      return titles;
    }

    const input: SearchInput = {
      table: SearchTable.doc,
      query: {
        type: SearchQueryType.boolean,
        occur: SearchQueryOccur.must,
        queries: [
          {
            type: SearchQueryType.match,
            field: 'workspaceId',
            match: workspaceId,
          },
          {
            type: SearchQueryType.boolean,
            occur: SearchQueryOccur.should,
            queries: uniqueIds.map(id => ({
              type: SearchQueryType.match,
              field: 'docId',
              match: id,
            })),
          },
        ],
      },
      options: {
        fields: ['docId', 'title'],
        pagination: { limit: Math.max(uniqueIds.length, 1) },
      },
    };
    const result = await this.indexer.search(input);

    for (const node of result.nodes) {
      const id = firstString(node.fields.docId);
      const title = firstString(node.fields.title);
      if (id) {
        titles.set(id, title ?? '');
      }
    }
    return titles;
  }
}

function firstString(value: unknown): string | undefined {
  if (Array.isArray(value) && typeof value[0] === 'string') {
    return value[0];
  }
  return undefined;
}

/**
 * Resolves a block search-node's target doc id: prefers the indexed
 * `refDocId` keyword field, falling back to parsing the stored `ref` JSON
 * blob (`{docId, ...ReferenceParams}`, per design.md) when `refDocId` is
 * absent.
 */
function resolveRefDocId(fields: Record<string, unknown>): string | undefined {
  const refDocId = firstString(fields.refDocId);
  if (refDocId) {
    return refDocId;
  }
  const rawRef = firstString(fields.ref);
  if (!rawRef) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(rawRef) as { docId?: unknown };
    return typeof parsed.docId === 'string' ? parsed.docId : undefined;
  } catch {
    return undefined;
  }
}
