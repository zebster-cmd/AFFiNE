import * as Y from 'yjs';

import { decodeCell, type StoredColumn } from './database-codec';
import type {
  BoardJSON,
  ColumnJSON,
  RowJSON,
  ViewJSON,
} from './database-types';

/**
 * The nested `groupBy` descriptor a real BlockSuite kanban view stores
 * (`GroupBy` in `blocksuite/affine/data-view/src/core/common/types.ts:1-9`).
 * Only `columnId` is needed here.
 */
interface StoredGroupBy {
  type?: string;
  columnId: string;
  name?: string;
}

/** The plain object shape written to each entry of `prop:views` (see `buildBoardDoc`). */
interface StoredView {
  id: string;
  name: string;
  mode: string;
  /**
   * Real BlockSuite kanban views store this as the nested `StoredGroupBy`
   * object; a flat column-id string is accepted defensively for older/other
   * shapes. `resolveGroupByColumnId` normalizes both to the column id.
   */
  groupBy?: string | StoredGroupBy;
  /**
   * Kanban-only, per the design doc (`GroupProperty` in
   * `blocksuite/affine/data-view/src/core/common/types.ts`): array order is
   * group display order; `key` is the group's raw (undecoded) cell value
   * (e.g. a select option id) and `manuallyCardSort` is the row-id order
   * within that group. Not written by the current `buildBoardDoc` test
   * fixture (Task 1) — read defensively here since real BlockSuite docs do
   * populate it. See database-reader.spec.ts's "honors stored
   * groupProperties" test, which patches it in directly to exercise this
   * path.
   */
  groupProperties?: { key: string; manuallyCardSort?: string[] }[];
}

/** The plain object shape written to each entry of `prop:columns` (see `buildBoardDoc`). */
type StoredColumnEntry = StoredColumn;

function getBlocks(bin: Uint8Array): Y.Map<unknown> {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, bin);
  return doc.getMap('blocks');
}

function findDatabaseBlock(
  blocks: Y.Map<unknown>,
  blockId: string
): Y.Map<unknown> {
  const block = blocks.get(blockId) as Y.Map<unknown> | undefined;
  if (!block || block.get('sys:flavour') !== 'affine:database') {
    throw new Error(`Database block "${blockId}" not found`);
  }
  return block;
}

function readColumns(db: Y.Map<unknown>): {
  columns: ColumnJSON[];
  byId: Map<string, StoredColumnEntry>;
} {
  const raw =
    (
      db.get('prop:columns') as Y.Array<StoredColumnEntry> | undefined
    )?.toArray() ?? [];
  const byId = new Map<string, StoredColumnEntry>();
  const columns: ColumnJSON[] = raw.map(column => {
    byId.set(column.id, column);
    const options = column.data?.options ?? [];
    const columnJSON: ColumnJSON = {
      id: column.id,
      name: column.name,
      type: column.type,
    };
    if (options.length > 0) {
      columnJSON.options = options.map(option => ({
        id: option.id,
        value: option.value,
        ...(option.color !== undefined ? { color: option.color } : {}),
      }));
    }
    return columnJSON;
  });
  return { columns, byId };
}

/** Raw (undecoded) stored value of `rowId`'s cell for `columnId`, or `undefined` if absent. */
function getRawCellValue(
  cells: Y.Map<unknown> | undefined,
  rowId: string,
  columnId: string
): unknown {
  const rowCells = cells?.get(rowId) as Y.Map<unknown> | undefined;
  const cell = rowCells?.get(columnId) as Y.Map<unknown> | undefined;
  return cell?.get('value');
}

function readRows(
  db: Y.Map<unknown>,
  blocks: Y.Map<unknown>,
  columns: StoredColumnEntry[]
): { rows: RowJSON[]; childrenIds: string[] } {
  const childrenIds =
    (db.get('sys:children') as Y.Array<string> | undefined)?.toArray() ?? [];
  const cells = db.get('prop:cells') as Y.Map<unknown> | undefined;

  const rows: RowJSON[] = childrenIds.map(rowId => {
    const rowBlock = blocks.get(rowId) as Y.Map<unknown> | undefined;
    const titleText = rowBlock?.get('prop:text') as Y.Text | undefined;
    const title = titleText ? titleText.toString() : '';

    const cellsJSON: Record<string, unknown> = {};
    for (const column of columns) {
      if (column.type === 'title') {
        continue;
      }
      const rawValue = getRawCellValue(cells, rowId, column.id);
      cellsJSON[column.id] = decodeCell(column, rawValue);
    }

    return { rowId, title, cells: cellsJSON };
  });

  return { rows, childrenIds };
}

/**
 * Normalizes a stored view's `groupBy` (the real nested `GroupBy` object, or
 * a defensive flat column-id string) to the group column's id, or
 * `undefined` when absent.
 */
function resolveGroupByColumnId(
  groupBy: string | StoredGroupBy | undefined
): string | undefined {
  if (!groupBy) {
    return undefined;
  }
  return typeof groupBy === 'string' ? groupBy : groupBy.columnId;
}

/**
 * Groups a kanban view's cards by the raw (undecoded) value of each row's
 * group-by cell, in child order. Groups are ordered by their first
 * appearance in the stored `groupProperties` (if any), then by first
 * appearance among the rows for any group not listed there. Within a group,
 * cards are ordered by that group's `manuallyCardSort` (rows not in the
 * sort list are appended afterward, in child order).
 */
function resolveKanbanGroups(
  childrenIds: string[],
  cells: Y.Map<unknown> | undefined,
  groupColumn: StoredColumnEntry | undefined,
  storedView: StoredView
): { value: string; cardRowIds: string[] }[] {
  const groupByColumnId = resolveGroupByColumnId(storedView.groupBy);
  if (!groupByColumnId) {
    return [];
  }

  const buckets = new Map<string, string[]>();
  const bucketOrder: string[] = [];
  for (const rowId of childrenIds) {
    const rawValue = getRawCellValue(cells, rowId, groupByColumnId);
    const key = rawValue == null ? '' : String(rawValue);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
      bucketOrder.push(key);
    }
    bucket.push(rowId);
  }

  const groupProperties = storedView.groupProperties ?? [];
  const orderedKeys: string[] = [];
  for (const property of groupProperties) {
    if (buckets.has(property.key) && !orderedKeys.includes(property.key)) {
      orderedKeys.push(property.key);
    }
  }
  for (const key of bucketOrder) {
    if (!orderedKeys.includes(key)) {
      orderedKeys.push(key);
    }
  }

  return orderedKeys.map(key => {
    const cardRowIds = buckets.get(key) ?? [];
    const sortList =
      groupProperties.find(property => property.key === key)
        ?.manuallyCardSort ?? [];
    const sorted = [
      ...sortList.filter(rowId => cardRowIds.includes(rowId)),
      ...cardRowIds.filter(rowId => !sortList.includes(rowId)),
    ];
    const value = groupColumn
      ? String(decodeCell(groupColumn, key) ?? '')
      : key;
    return { value, cardRowIds: sorted };
  });
}

function readViews(
  db: Y.Map<unknown>,
  columnsById: Map<string, StoredColumnEntry>,
  childrenIds: string[]
): ViewJSON[] {
  const raw =
    (db.get('prop:views') as Y.Array<StoredView> | undefined)?.toArray() ?? [];
  const cells = db.get('prop:cells') as Y.Map<unknown> | undefined;

  return raw.map(storedView => {
    const view: ViewJSON = {
      id: storedView.id,
      name: storedView.name,
      mode: storedView.mode,
    };
    const groupByColumnId = resolveGroupByColumnId(storedView.groupBy);
    if (groupByColumnId) {
      view.groupByColumnId = groupByColumnId;
      if (storedView.mode === 'kanban') {
        const groupColumn = columnsById.get(groupByColumnId);
        view.groups = resolveKanbanGroups(
          childrenIds,
          cells,
          groupColumn,
          storedView
        );
      }
    }
    return view;
  });
}

/**
 * Projects a single `affine:database` block into a `BoardJSON`, given the
 * raw doc binary it lives in. Pure — no NestJS/storage dependencies; the
 * tool layer supplies `bin` via `DocReader`.
 */
export function readBoardFromBinary(
  bin: Uint8Array,
  blockId: string
): BoardJSON {
  const blocks = getBlocks(bin);
  const db = findDatabaseBlock(blocks, blockId);

  const { columns, byId } = readColumns(db);
  const rawColumns = [...byId.values()];
  const { rows, childrenIds } = readRows(db, blocks, rawColumns);
  const views = readViews(db, byId, childrenIds);
  const titleText = db.get('prop:title') as Y.Text | undefined;
  const title = titleText ? titleText.toString() : '';

  return { blockId, title, columns, rows, views };
}

/**
 * Lists every `affine:database` block found anywhere in the doc, with just
 * enough detail (`blockId`, `title`, the modes of its views) for the model
 * to pick one before calling {@link readBoardFromBinary}.
 */
export function listBoardsFromBinary(
  bin: Uint8Array
): { blockId: string; title: string; viewModes: string[] }[] {
  const blocks = getBlocks(bin);
  const boards: { blockId: string; title: string; viewModes: string[] }[] = [];

  for (const [id, block] of blocks.entries()) {
    const b = block as Y.Map<unknown>;
    if (b.get('sys:flavour') !== 'affine:database') {
      continue;
    }
    const titleText = b.get('prop:title') as Y.Text | undefined;
    const title = titleText ? titleText.toString() : '';
    const rawViews =
      (b.get('prop:views') as Y.Array<StoredView> | undefined)?.toArray() ?? [];
    boards.push({
      blockId: id,
      title,
      viewModes: rawViews.map(view => view.mode),
    });
  }

  return boards;
}

/**
 * Namespace wrapper around the pure `readBoardFromBinary`/
 * `listBoardsFromBinary` functions, per the task interface (`class
 * DatabaseReader`). Prefer the standalone functions for new call sites;
 * this class exists so callers that want a single cohesive import have one.
 */
export class DatabaseReader {
  static readBoardFromBinary(bin: Uint8Array, blockId: string): BoardJSON {
    return readBoardFromBinary(bin, blockId);
  }

  static listBoardsFromBinary(
    bin: Uint8Array
  ): { blockId: string; title: string; viewModes: string[] }[] {
    return listBoardsFromBinary(bin);
  }
}
