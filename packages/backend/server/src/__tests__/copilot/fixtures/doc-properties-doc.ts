import * as Y from 'yjs';

import { favoriteKey } from '../../../core/doc/doc-properties-types';

/**
 * Test fixtures for the copilot doc-properties tools: builders that produce the
 * YJS binaries of the four docs a doc's attributes live across — the workspace
 * root meta doc, `docProperties`, `docCustomPropertyInfo`, and a user's
 * favorites doc. Shapes mirror what the frontend stores (see the investigation
 * notes in the change's design.md).
 */

export interface PageFixture {
  id: string;
  title?: string;
  trash?: boolean;
  /**
   * Tag ids. Omit entirely (as opposed to passing `[]`) to build a page entry
   * with NO `tags` field at all - simulating a legacy or externally-created
   * doc, which `DocPropertiesWriter`'s add_tag/remove_tag must tolerate.
   */
  tags?: string[];
}

export interface TagOptionFixture {
  id: string;
  value: string;
  color?: string;
}

/** Root doc: `meta.pages[]` + `meta.properties.tags.options`. */
export function buildRootDoc(input: {
  pages: PageFixture[];
  tagOptions?: TagOptionFixture[];
}): Uint8Array {
  const doc = new Y.Doc();
  const meta = doc.getMap('meta');

  const pages = new Y.Array<Y.Map<unknown>>();
  for (const page of input.pages) {
    const pageMap = new Y.Map<unknown>();
    pageMap.set('id', page.id);
    pageMap.set('title', page.title ?? '');
    if (page.trash !== undefined) pageMap.set('trash', page.trash);
    if (page.tags !== undefined) {
      const tags = new Y.Array<string>();
      if (page.tags.length) tags.push(page.tags);
      pageMap.set('tags', tags);
    }
    pages.push([pageMap]);
  }
  meta.set('pages', pages);

  const properties = new Y.Map<unknown>();
  const tagsProp = new Y.Map<unknown>();
  tagsProp.set('options', input.tagOptions ?? []);
  properties.set('tags', tagsProp);
  meta.set('properties', properties);

  return Y.encodeStateAsUpdate(doc);
}

/** docProperties doc: one flat Y.Map row per doc id. */
export function buildDocPropertiesDoc(
  rows: Record<
    string,
    {
      journal?: string;
      primaryMode?: string;
      custom?: Record<string, string>;
      [key: string]: unknown;
    }
  >
): Uint8Array {
  const doc = new Y.Doc();
  for (const [docId, fields] of Object.entries(rows)) {
    const row = doc.getMap(docId);
    row.set('id', docId);
    if (fields.journal !== undefined) row.set('journal', fields.journal);
    if (fields.primaryMode !== undefined)
      row.set('primaryMode', fields.primaryMode);
    for (const [propId, value] of Object.entries(fields.custom ?? {})) {
      row.set(`custom:${propId}`, value);
    }
  }
  return Y.encodeStateAsUpdate(doc);
}

export interface PropertyInfoFixture {
  id: string;
  name?: string;
  type: string;
  show?: string;
  index?: string;
}

/** docCustomPropertyInfo doc: one flat Y.Map row per property definition. */
export function buildCustomPropertyInfoDoc(
  defs: PropertyInfoFixture[]
): Uint8Array {
  const doc = new Y.Doc();
  for (const def of defs) {
    const row = doc.getMap(def.id);
    row.set('id', def.id);
    if (def.name !== undefined) row.set('name', def.name);
    row.set('type', def.type);
    if (def.show !== undefined) row.set('show', def.show);
    if (def.index !== undefined) row.set('index', def.index);
  }
  return Y.encodeStateAsUpdate(doc);
}

/** favorites doc: a top-level Y.Map named `doc:<docId>` per favorited doc. */
export function buildFavoriteDoc(
  favorites: { docId: string; index?: string }[]
): Uint8Array {
  const doc = new Y.Doc();
  for (const fav of favorites) {
    const key = favoriteKey(fav.docId);
    const row = doc.getMap(key);
    row.set('key', key);
    row.set('index', fav.index ?? 'a0');
  }
  return Y.encodeStateAsUpdate(doc);
}
