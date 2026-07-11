import * as Y from 'yjs';

import type {
  ColumnJSON,
  RowJSON,
  ViewJSON,
} from '../../../core/doc/database-types';

/** Fixed id of the `affine:page` block built by {@link buildBoardDoc}. */
export const DEFAULT_PAGE_BLOCK_ID = 'page';
/** Fixed id of the `affine:note` block built by {@link buildBoardDoc}. */
export const DEFAULT_NOTE_BLOCK_ID = 'note';
/** Default id of the `affine:database` block built by {@link buildBoardDoc}. */
export const DEFAULT_DATABASE_BLOCK_ID = 'db1';

export interface BuildBoardDocSpec {
  /** Board (database block `prop:title`) title. */
  title: string;
  columns: ColumnJSON[];
  rows: RowJSON[];
  views: ViewJSON[];
  /** Override the generated database block id (defaults to `DEFAULT_DATABASE_BLOCK_ID`). */
  blockId?: string;
}

/**
 * Builds a deterministic `Y.Doc` binary containing
 * `affine:page` -> `affine:note` -> `affine:database`, with the database
 * block's rows/columns/cells/views laid out per the confirmed
 * `affine_doc_loader` read semantics. All ids are taken verbatim from
 * `spec` (or the fixed constants above) — nothing is randomly generated,
 * so callers get a fully deterministic fixture for reader/writer tests.
 */
export function buildBoardDoc(spec: BuildBoardDocSpec): Uint8Array {
  const doc = new Y.Doc();
  const blocks = doc.getMap('blocks');
  const dbId = spec.blockId ?? DEFAULT_DATABASE_BLOCK_ID;

  doc.transact(() => {
    // affine:page
    const page = new Y.Map<unknown>();
    page.set('sys:id', DEFAULT_PAGE_BLOCK_ID);
    page.set('sys:flavour', 'affine:page');
    page.set('sys:version', 1);
    const pageChildren = new Y.Array<string>();
    pageChildren.push([DEFAULT_NOTE_BLOCK_ID]);
    page.set('sys:children', pageChildren);
    blocks.set(DEFAULT_PAGE_BLOCK_ID, page);

    // affine:note
    const note = new Y.Map<unknown>();
    note.set('sys:id', DEFAULT_NOTE_BLOCK_ID);
    note.set('sys:flavour', 'affine:note');
    note.set('sys:version', 1);
    const noteChildren = new Y.Array<string>();
    noteChildren.push([dbId]);
    note.set('sys:children', noteChildren);
    blocks.set(DEFAULT_NOTE_BLOCK_ID, note);

    // affine:database
    const db = new Y.Map<unknown>();
    db.set('sys:id', dbId);
    db.set('sys:flavour', 'affine:database');
    db.set('sys:version', 3);

    const dbChildren = new Y.Array<string>();
    dbChildren.push(spec.rows.map(row => row.rowId));
    db.set('sys:children', dbChildren);

    const columns = new Y.Array<unknown>();
    columns.push(
      spec.columns.map(column => ({
        id: column.id,
        type: column.type,
        name: column.name,
        data: {
          options: (column.options ?? []).map(option => ({
            id: option.id,
            value: option.value,
            color: option.color,
          })),
        },
      }))
    );
    db.set('prop:columns', columns);

    const cells = new Y.Map<unknown>();
    for (const row of spec.rows) {
      const rowCells = new Y.Map<unknown>();
      for (const [columnId, value] of Object.entries(row.cells ?? {})) {
        const cell = new Y.Map<unknown>();
        cell.set('columnId', columnId);
        cell.set('value', value);
        rowCells.set(columnId, cell);
      }
      cells.set(row.rowId, rowCells);
    }
    db.set('prop:cells', cells);

    const views = new Y.Array<unknown>();
    views.push(
      spec.views.map(view => ({
        id: view.id,
        name: view.name,
        mode: view.mode,
        ...(view.groupByColumnId ? { groupBy: view.groupByColumnId } : {}),
      }))
    );
    db.set('prop:views', views);

    db.set('prop:title', new Y.Text(spec.title));

    blocks.set(dbId, db);

    // each row is a child `affine:paragraph` block; its `prop:text` is the row title
    for (const row of spec.rows) {
      const rowBlock = new Y.Map<unknown>();
      rowBlock.set('sys:id', row.rowId);
      rowBlock.set('sys:flavour', 'affine:paragraph');
      rowBlock.set('sys:version', 1);
      rowBlock.set('sys:children', new Y.Array<string>());
      rowBlock.set('prop:text', new Y.Text(row.title));
      blocks.set(row.rowId, rowBlock);
    }
  });

  return Y.encodeStateAsUpdate(doc);
}
