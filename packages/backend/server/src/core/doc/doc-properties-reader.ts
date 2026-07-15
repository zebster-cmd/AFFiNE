import { Injectable } from '@nestjs/common';
import * as Y from 'yjs';

import { PgWorkspaceDocStorageAdapter } from './adapters/workspace';
import {
  type CustomPropertyView,
  docCustomPropertyInfoDocId,
  type DocPrimaryMode,
  docPropertiesDocId,
  type DocPropertiesView,
  favoriteDocId,
  favoriteKey,
  ORM_DELETE_FLAG,
  type TagOption,
  type TagView,
} from './doc-properties-types';
import { toBuffer } from './yjs-delta';

function loadDoc(bin: Buffer | Uint8Array | null | undefined): Y.Doc {
  const doc = new Y.Doc();
  if (bin && bin.byteLength > 0) {
    Y.applyUpdate(doc, toBuffer(bin));
  }
  return doc;
}

interface PageMeta {
  title: string;
  trash: boolean;
  tagIds: string[];
}

/** Read a doc's `meta.pages[]` entry (title, trash, tag ids) from the root doc. */
export function readPageMetaFromRoot(
  rootBin: Buffer | Uint8Array | null | undefined,
  docId: string
): PageMeta | null {
  const doc = loadDoc(rootBin);
  const meta = doc.getMap('meta').toJSON() as {
    pages?: Array<{
      id?: string;
      title?: string;
      trash?: boolean;
      tags?: string[];
    }>;
  };
  const page = meta.pages?.find(p => p.id === docId);
  if (!page) return null;
  return {
    title: page.title ?? '',
    trash: page.trash === true,
    tagIds: Array.isArray(page.tags) ? page.tags : [],
  };
}

/**
 * Resolve doc ids in the workspace root's `meta.pages[]` whose title exactly
 * matches `title`. Used by the `doc_links_update` tool to translate a
 * name-or-id target reference into a doc id (see design.md Decision 4/5 -
 * name resolution is the tool layer's job, not the writer's).
 */
export function resolveDocIdsByTitle(
  rootBin: Buffer | Uint8Array | null | undefined,
  title: string
): string[] {
  const doc = loadDoc(rootBin);
  const meta = doc.getMap('meta').toJSON() as {
    pages?: Array<{ id?: string; title?: string }>;
  };
  return (meta.pages ?? [])
    .filter(page => typeof page.id === 'string' && page.title === title)
    .map(page => page.id as string);
}

/** An in-memory index over the root doc's `meta.pages[]`, built once. */
export interface PageIndex {
  /** Every known doc id, for exact-id lookups. */
  ids: Set<string>;
  /** Title -> matching doc ids, for title-fallback lookups. */
  byTitle: Map<string, string[]>;
}

/**
 * Parse the workspace root doc's `meta.pages[]` ONCE and build both an id
 * set and a title -> ids map, so callers resolving many name-or-id
 * references (e.g. `doc_links_update`'s batched ops) don't re-parse the
 * root Yjs binary per reference. Equivalent to combining
 * `readPageMetaFromRoot`'s id-existence check with `resolveDocIdsByTitle`
 * across every reference, but with a single `Y.Doc` construction.
 */
export function buildPageIndexFromRoot(
  rootBin: Buffer | Uint8Array | null | undefined
): PageIndex {
  const doc = loadDoc(rootBin);
  const meta = doc.getMap('meta').toJSON() as {
    pages?: Array<{ id?: string; title?: string }>;
  };
  const ids = new Set<string>();
  const byTitle = new Map<string, string[]>();
  for (const page of meta.pages ?? []) {
    if (typeof page.id !== 'string') continue;
    ids.add(page.id);
    if (typeof page.title === 'string') {
      const existing = byTitle.get(page.title);
      if (existing) {
        existing.push(page.id);
      } else {
        byTitle.set(page.title, [page.id]);
      }
    }
  }
  return { ids, byTitle };
}

/** Read the workspace tag definitions from `meta.properties.tags.options`. */
export function readTagOptionsFromRoot(
  rootBin: Buffer | Uint8Array | null | undefined
): TagOption[] {
  const doc = loadDoc(rootBin);
  const meta = doc.getMap('meta').toJSON() as {
    properties?: { tags?: { options?: TagOption[] } };
  };
  return meta.properties?.tags?.options ?? [];
}

interface DocPropertiesRow {
  journal: string | null;
  primaryMode: DocPrimaryMode | null;
  custom: Record<string, string>;
}

/** Read a doc's flat row from the `docProperties` doc. */
export function readDocPropertiesRow(
  bin: Buffer | Uint8Array | null | undefined,
  docId: string
): DocPropertiesRow {
  const doc = loadDoc(bin);
  if (!doc.share.has(docId)) {
    return { journal: null, primaryMode: null, custom: {} };
  }
  const row = doc.getMap(docId).toJSON() as Record<string, unknown>;
  const custom: Record<string, string> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key.startsWith('custom:')) {
      custom[key.slice('custom:'.length)] = String(value);
    }
  }
  const mode = row.primaryMode;
  return {
    journal: typeof row.journal === 'string' ? row.journal : null,
    primaryMode: mode === 'page' || mode === 'edgeless' ? mode : null,
    custom,
  };
}

export interface PropertyDef {
  id: string;
  name?: string;
  type?: string;
}

/** Read all custom-property definitions from the `docCustomPropertyInfo` doc. */
export function readPropertyDefs(
  bin: Buffer | Uint8Array | null | undefined
): Map<string, PropertyDef> {
  const doc = loadDoc(bin);
  const defs = new Map<string, PropertyDef>();
  for (const key of doc.share.keys()) {
    const row = doc.getMap(key).toJSON() as Record<string, unknown>;
    if (row[ORM_DELETE_FLAG] === true || row.isDeleted === true) continue;
    if (Object.keys(row).length === 0) continue;
    defs.set(key, {
      id: key,
      name: typeof row.name === 'string' ? row.name : undefined,
      type: typeof row.type === 'string' ? row.type : undefined,
    });
  }
  return defs;
}

/** Whether a doc is favorited in the given (per-user) favorites doc. */
export function readFavorite(
  bin: Buffer | Uint8Array | null | undefined,
  docId: string
): boolean {
  const doc = loadDoc(bin);
  const key = favoriteKey(docId);
  if (!doc.share.has(key)) return false;
  const row = doc.getMap(key).toJSON() as Record<string, unknown>;
  if (row[ORM_DELETE_FLAG] === true) return false;
  return Object.keys(row).length > 0;
}

/** Resolve tag ids against the workspace tag options. */
export function resolveTags(tagIds: string[], options: TagOption[]): TagView[] {
  const byId = new Map(options.map(o => [o.id, o]));
  return tagIds.map(id => {
    const opt = byId.get(id);
    return opt ? { id, name: opt.value, color: opt.color } : { id, name: id };
  });
}

/** Resolve a doc's `custom:*` values against the property definitions. */
export function resolveCustomProperties(
  custom: Record<string, string>,
  defs: Map<string, PropertyDef>
): CustomPropertyView[] {
  return Object.entries(custom).map(([id, value]) => {
    const def = defs.get(id);
    return { id, name: def?.name, type: def?.type, value };
  });
}

@Injectable()
export class DocPropertiesReader {
  constructor(private readonly storage: PgWorkspaceDocStorageAdapter) {}

  /**
   * Aggregate a doc's attributes across the root doc (title/trash/tags),
   * `docProperties` (journal/mode/custom values), `docCustomPropertyInfo`
   * (to resolve property names/types), and the acting user's favorites doc.
   */
  async read(
    workspaceId: string,
    docId: string,
    userId: string
  ): Promise<DocPropertiesView | null> {
    const [rootRec, propsRec, infoRec, favRec] = await Promise.all([
      this.storage.getDoc(workspaceId, workspaceId),
      this.storage.getDoc(workspaceId, docPropertiesDocId(workspaceId)),
      this.storage.getDoc(workspaceId, docCustomPropertyInfoDocId(workspaceId)),
      this.storage.getDoc(workspaceId, favoriteDocId(userId, workspaceId)),
    ]);

    const page = readPageMetaFromRoot(rootRec?.bin, docId);
    if (!page) return null;

    const options = readTagOptionsFromRoot(rootRec?.bin);
    const row = readDocPropertiesRow(propsRec?.bin, docId);
    const defs = readPropertyDefs(infoRec?.bin);
    const favorite = readFavorite(favRec?.bin, docId);

    return {
      docId,
      title: page.title,
      trash: page.trash,
      favorite,
      journal: row.journal,
      primaryMode: row.primaryMode,
      tags: resolveTags(page.tagIds, options),
      properties: resolveCustomProperties(row.custom, defs),
    };
  }
}
