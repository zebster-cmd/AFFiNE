import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { nanoid } from 'nanoid';
import * as Y from 'yjs';

import { EventBus } from '../../base';
import { PgWorkspaceDocStorageAdapter } from './adapters/workspace';
import {
  encodeCell,
  isReadOnlyType,
  type StoredColumn,
} from './database-codec';
import type {
  AddColumnOp,
  AddRowOp,
  AddViewOp,
  DatabaseOp,
  DeleteColumnOp,
  DeleteRowOp,
  MoveCardOp,
  PropertyType,
  UpdateCellOp,
  UpdateColumnOp,
} from './database-types';

/**
 * The nested `groupBy` descriptor a real BlockSuite kanban view stores
 * (`GroupBy` in `blocksuite/affine/data-view/src/core/common/types.ts`),
 * mirrored here for the writer side (see `database-reader.ts`'s
 * `StoredGroupBy` for the read-side twin).
 */
interface StoredGroupBy {
  type: string;
  columnId: string;
  name: string;
}

/** One entry of a kanban view's `groupProperties` (see database-reader.ts). */
interface StoredGroupProperty {
  key: string;
  manuallyCardSort?: string[];
}

/** The plain object shape written to each entry of `prop:views`. */
interface StoredView {
  id: string;
  name: string;
  mode: string;
  groupBy?: StoredGroupBy;
  groupProperties?: StoredGroupProperty[];
  [key: string]: unknown;
}

/** One column of a {@link CreateBoardSpec} passed to {@link DatabaseWriter.createBoard}. */
export interface CreateBoardColumnSpec {
  name: string;
  type: PropertyType;
  options?: { value: string; color?: string }[];
}

/**
 * The view a new board is created with. `groupByColumnName` (kanban only)
 * names an existing (or about-to-be-created) `spec.columns` entry by its
 * `name`, since the caller cannot know column ids that {@link DatabaseWriter}
 * generates during `createBoard` - mirrors the `database_create` tool's
 * `{ [columnName]: value }` cell convention (see the design doc).
 */
export interface CreateBoardViewSpec {
  mode: 'table' | 'kanban';
  name?: string;
  groupByColumnName?: string;
}

/**
 * One initial row of a {@link CreateBoardSpec}. `cells` is keyed by column
 * *name* (not id), for the same reason as `CreateBoardViewSpec.groupByColumnName`.
 */
export interface CreateBoardRowSpec {
  title?: string;
  cells?: Record<string, unknown>;
}

/** Input to {@link DatabaseWriter.createBoard}. */
export interface CreateBoardSpec {
  title: string;
  columns: CreateBoardColumnSpec[];
  view: CreateBoardViewSpec;
  rows?: CreateBoardRowSpec[];
}

/**
 * Default group column seeded by {@link DatabaseWriter.ensureGroupColumn}
 * when a kanban view is created without an explicit `groupByColumnId`,
 * mirroring the editor's default "Status" select column.
 */
const DEFAULT_GROUP_COLUMN_NAME = 'Status';
const DEFAULT_GROUP_COLUMN_OPTIONS: { value: string; color: string }[] = [
  { value: 'Todo', color: 'grey' },
  { value: 'In Progress', color: 'yellow' },
  { value: 'Done', color: 'green' },
];

/**
 * Mutable view over a single `affine:database` block, handed to the op
 * mutators inside {@link DatabaseWriter}'s `doc.transact` (see
 * `buildBoardDoc` in `src/__tests__/copilot/fixtures/database-doc.ts` for the
 * exact shapes `columns`/`cells`/`views` hold).
 */
export interface BoardCtx {
  doc: Y.Doc;
  blocks: Y.Map<unknown>;
  db: Y.Map<unknown>;
  columns: Y.Array<StoredColumn>;
  cells: Y.Map<unknown>;
  views: Y.Array<unknown>;
}

function findColumnIndex(
  columns: Y.Array<StoredColumn>,
  columnId: string
): number {
  return columns.toArray().findIndex(column => column.id === columnId);
}

function requireColumnIndex(
  columns: Y.Array<StoredColumn>,
  columnId: string
): number {
  const idx = findColumnIndex(columns, columnId);
  if (idx === -1) {
    throw new NotFoundException(`Column "${columnId}" not found`);
  }
  return idx;
}

/**
 * Applies `database_update` op batches to an `affine:database` block,
 * mirroring `DocWriter`'s load / transact / encode-delta / push shape
 * (`writer.ts:36-102`).
 *
 * Implements all 8 `DatabaseOp` variants: the three column ops (Task 4:
 * `add_column`/`update_column`/`delete_column`), the three row/cell ops
 * (Task 5: `add_row`/`update_cell`/`delete_row`), and the two kanban ops
 * (Task 6: `add_view`/`move_card`). {@link applyOps}'s op switch is now
 * exhaustive; its `default` branch only guards against a future op being
 * added to the `DatabaseOp` union without a matching case.
 */
@Injectable()
export class DatabaseWriter {
  private readonly logger = new Logger(DatabaseWriter.name);

  constructor(
    private readonly storage: PgWorkspaceDocStorageAdapter,
    private readonly event: EventBus
  ) {}

  /**
   * Fetches `docId`'s current binary, applies `ops` to `blockId`'s database
   * block inside a single `doc.transact`, and pushes only the resulting
   * delta (never the whole doc) back to storage.
   */
  async applyOps(
    workspaceId: string,
    docId: string,
    blockId: string,
    ops: DatabaseOp[],
    editorId?: string
  ): Promise<void> {
    const rec = await this.storage.getDoc(workspaceId, docId);
    if (!rec?.bin) {
      throw new NotFoundException(`Document ${docId} not found`);
    }

    const bin = Buffer.isBuffer(rec.bin)
      ? rec.bin
      : Buffer.from(rec.bin.buffer, rec.bin.byteOffset, rec.bin.byteLength);

    const delta = this.applyToBinary(bin, blockId, ctx => {
      for (const op of ops) {
        switch (op.op) {
          case 'add_column':
            this.addColumn(ctx, op);
            break;
          case 'update_column':
            this.updateColumn(ctx, op);
            break;
          case 'delete_column':
            this.deleteColumn(ctx, op);
            break;
          case 'add_row':
            this.addRow(ctx, op);
            break;
          case 'update_cell':
            this.updateCell(ctx, op);
            break;
          case 'delete_row':
            this.deleteRow(ctx, op);
            break;
          case 'add_view':
            this.addView(ctx, op);
            break;
          case 'move_card':
            this.moveCard(ctx, op);
            break;
          default: {
            // Exhaustive: all 8 DatabaseOp variants are handled above. This
            // branch only fires if a future op is added to the union without
            // a matching case - `op` is narrowed to `never`, so read `.op`
            // off the pre-narrowing type for the error message.
            const unknownOp = op as DatabaseOp;
            throw new Error(
              `Database op "${unknownOp.op}" is not yet implemented`
            );
          }
        }
      }
    });

    await this.pushDelta(workspaceId, docId, delta, editorId);

    this.logger.debug(
      `Applied ${ops.length} database op(s) to block ${blockId} in doc ${docId}`
    );
  }

  /**
   * Loads `docId`'s current binary, finds its (first) `affine:note` block,
   * and appends a brand-new `affine:database` block to it: a `title` column
   * is always ensured, then `spec.columns`/`spec.view`/`spec.rows` are built
   * via the exact same op mutators `applyOps` uses (`addColumn`/`addView`/
   * `addRow`), all inside one `doc.transact`. Pushes only the resulting
   * delta, mirroring `applyOps`'s load / transact / encode-delta / push
   * shape.
   */
  async createBoard(
    workspaceId: string,
    docId: string,
    spec: CreateBoardSpec,
    editorId?: string
  ): Promise<{ blockId: string }> {
    const rec = await this.storage.getDoc(workspaceId, docId);
    if (!rec?.bin) {
      throw new NotFoundException(`Document ${docId} not found`);
    }

    const bin = Buffer.isBuffer(rec.bin)
      ? rec.bin
      : Buffer.from(rec.bin.buffer, rec.bin.byteOffset, rec.bin.byteLength);

    const doc = new Y.Doc();
    Y.applyUpdate(doc, bin);
    const before = Y.encodeStateVector(doc);

    const blocks = doc.getMap('blocks');
    const noteId = this.findNoteBlockId(blocks);
    if (!noteId) {
      throw new NotFoundException(
        'Document has no note block to hold the database'
      );
    }

    const blockId = nanoid();

    doc.transact(() => {
      const note = blocks.get(noteId) as Y.Map<unknown>;

      const db = new Y.Map<unknown>();
      db.set('sys:id', blockId);
      db.set('sys:flavour', 'affine:database');
      db.set('sys:version', 3);
      db.set('sys:children', new Y.Array<string>());
      db.set('prop:title', new Y.Text(spec.title));

      const columns = new Y.Array<StoredColumn>();
      db.set('prop:columns', columns);
      const cells = new Y.Map<unknown>();
      db.set('prop:cells', cells);
      const views = new Y.Array<unknown>();
      db.set('prop:views', views);

      // Y.Map.set is tracked incrementally by Yjs - see applyToBinary's
      // caveat doc below for why fresh inserts (unlike in-place mutation of
      // an object already inside a Y.Array) are always safe here.
      blocks.set(blockId, db);

      const noteChildren = note.get('sys:children') as Y.Array<string>;
      noteChildren.push([blockId]);

      const ctx: BoardCtx = { doc, blocks, db, columns, cells, views };

      const hasTitleColumn = spec.columns.some(
        column => column.type === 'title'
      );
      if (!hasTitleColumn) {
        this.addColumn(ctx, { op: 'add_column', name: 'Title', type: 'title' });
      }
      for (const column of spec.columns) {
        this.addColumn(ctx, {
          op: 'add_column',
          name: column.name,
          type: column.type,
          options: column.options,
        });
      }

      const groupByColumnId =
        spec.view.mode === 'kanban'
          ? this.resolveColumnIdByName(ctx, spec.view.groupByColumnName)
          : undefined;
      this.addView(ctx, {
        op: 'add_view',
        mode: spec.view.mode,
        name: spec.view.name,
        groupByColumnId,
      });

      for (const row of spec.rows ?? []) {
        this.addRow(ctx, {
          op: 'add_row',
          title: row.title,
          cells: this.resolveCellsByColumnName(ctx, row.cells),
        });
      }
    });

    const delta = Y.encodeStateAsUpdate(doc, before);
    await this.pushDelta(workspaceId, docId, delta, editorId);

    this.logger.debug(
      `Created database block ${blockId} in doc ${docId} (note ${noteId})`
    );

    return { blockId };
  }

  /** Finds the id of the first `affine:note` block, or `undefined` if none exists. */
  private findNoteBlockId(blocks: Y.Map<unknown>): string | undefined {
    for (const [id, block] of blocks.entries()) {
      if ((block as Y.Map<unknown>).get('sys:flavour') === 'affine:note') {
        return id;
      }
    }
    return undefined;
  }

  /**
   * Resolves `spec.rows[].cells`' column-*name* keys (see
   * {@link CreateBoardRowSpec}) to column ids for `writeCell`/`addRow`,
   * falling back to treating the key as an id verbatim (defensive - callers
   * should use names). Unresolvable keys are passed through unchanged so
   * `writeCell`'s own `NotFoundException` reports the bad column.
   */
  private resolveCellsByColumnName(
    ctx: BoardCtx,
    cells?: Record<string, unknown>
  ): Record<string, unknown> | undefined {
    if (!cells) {
      return undefined;
    }
    const columns = ctx.columns.toArray();
    const resolved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(cells)) {
      const column =
        columns.find(c => c.name === key) ?? columns.find(c => c.id === key);
      resolved[column?.id ?? key] = value;
    }
    return resolved;
  }

  /** Resolves a column *name* to its id, or `undefined` if no column has that name. */
  private resolveColumnIdByName(
    ctx: BoardCtx,
    name?: string
  ): string | undefined {
    if (!name) {
      return undefined;
    }
    return ctx.columns.toArray().find(column => column.name === name)?.id;
  }

  /** Pushes `delta` to storage and emits `doc.updates.pushed`, shared by `applyOps`/`createBoard`. */
  private async pushDelta(
    workspaceId: string,
    docId: string,
    delta: Uint8Array,
    editorId?: string
  ): Promise<void> {
    const timestamp = await this.storage.pushDocUpdates(
      workspaceId,
      docId,
      [delta],
      editorId
    );
    this.emitDocUpdatesPushed({
      spaceId: workspaceId,
      docId,
      updates: [delta],
      timestamp,
      editor: editorId,
    });
  }

  /**
   * Loads `bin` into a fresh `Y.Doc`, captures its state vector, runs
   * `mutate` inside a single `doc.transact`, and returns only the delta
   * (`Y.encodeStateAsUpdate(doc, beforeSV)`).
   *
   * CAVEAT (proven empirically - see the "delta" assertions in
   * `database-writer-columns.spec.ts`): `prop:columns` is a `Y.Array` of
   * plain JS objects. Mutating a plain object already inside a `Y.Array` in
   * place is NOT observed by Yjs's state-vector diff and will silently drop
   * out of the returned delta. Mutators MUST replace array elements
   * (`columns.delete(i, 1); columns.insert(i, [next])`) rather than editing
   * them in place - see `updateColumn`/`deleteColumn` below.
   */
  private applyToBinary(
    bin: Uint8Array,
    blockId: string,
    mutate: (ctx: BoardCtx) => void
  ): Uint8Array {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, bin);
    const before = Y.encodeStateVector(doc);

    const blocks = doc.getMap('blocks');
    const db = blocks.get(blockId) as Y.Map<unknown> | undefined;
    if (!db || db.get('sys:flavour') !== 'affine:database') {
      throw new NotFoundException(`Database block "${blockId}" not found`);
    }

    const columns = db.get('prop:columns') as Y.Array<StoredColumn>;
    const cells = db.get('prop:cells') as Y.Map<unknown>;
    const views = db.get('prop:views') as Y.Array<unknown>;
    const ctx: BoardCtx = { doc, blocks, db, columns, cells, views };

    doc.transact(() => {
      mutate(ctx);
    });

    return Y.encodeStateAsUpdate(doc, before);
  }

  private addColumn(ctx: BoardCtx, op: AddColumnOp): void {
    this.appendColumn(ctx, op.name, op.type, op.options ?? []);
  }

  /**
   * Builds a new {@link StoredColumn} and pushes it onto `ctx.columns`.
   * Shared by `addColumn` and {@link ensureGroupColumn} (the latter's default
   * "Status" select column), per the task brief's "same column-append path
   * as add_column".
   */
  private appendColumn(
    ctx: BoardCtx,
    name: string,
    type: PropertyType,
    options: { value: string; color?: string }[]
  ): StoredColumn {
    const column: StoredColumn = {
      id: nanoid(),
      type,
      name,
      data: {
        options: options.map(option => ({
          id: nanoid(),
          value: option.value,
          color: option.color,
        })),
      },
    };
    // A Y.Array insert - tracked incrementally by Yjs (unlike mutating an
    // element already in the array, see the applyToBinary caveat above).
    ctx.columns.push([column]);
    return column;
  }

  private updateColumn(ctx: BoardCtx, op: UpdateColumnOp): void {
    const idx = requireColumnIndex(ctx.columns, op.columnId);
    const existing = ctx.columns.get(idx);

    const updated: StoredColumn = {
      ...existing,
      name: op.name ?? existing.name,
      data: op.options
        ? {
            ...existing.data,
            options: op.options.map(option => ({
              id: option.id ?? nanoid(),
              value: option.value,
              color: option.color,
            })),
          }
        : existing.data,
    };

    // Replace, don't mutate, the array element - see applyToBinary's caveat.
    ctx.columns.delete(idx, 1);
    ctx.columns.insert(idx, [updated]);
  }

  private deleteColumn(ctx: BoardCtx, op: DeleteColumnOp): void {
    const idx = requireColumnIndex(ctx.columns, op.columnId);
    ctx.columns.delete(idx, 1);

    // Purge the deleted column's cell from every row.
    for (const rowCells of ctx.cells.values()) {
      const row = rowCells as Y.Map<unknown>;
      if (row.has(op.columnId)) {
        row.delete(op.columnId);
      }
    }
  }

  private addRow(ctx: BoardCtx, op: AddRowOp): void {
    const rowId = nanoid();

    const block = new Y.Map<unknown>();
    block.set('sys:id', rowId);
    block.set('sys:flavour', 'affine:paragraph');
    block.set('sys:version', 1);
    block.set('sys:children', new Y.Array<string>());
    block.set('prop:text', new Y.Text(op.title ?? ''));
    ctx.blocks.set(rowId, block);

    // Y.Array.push is tracked incrementally by Yjs (unlike mutating an
    // element already in the array, see the applyToBinary caveat above).
    const dbChildren = ctx.db.get('sys:children') as Y.Array<string>;
    dbChildren.push([rowId]);

    const rowCells = new Y.Map<unknown>();
    ctx.cells.set(rowId, rowCells);

    for (const [columnId, value] of Object.entries(op.cells ?? {})) {
      this.writeCell(ctx, rowId, columnId, value);
    }
  }

  private updateCell(ctx: BoardCtx, op: UpdateCellOp): void {
    const idx = requireColumnIndex(ctx.columns, op.columnId);
    const column = ctx.columns.get(idx);

    if (column.type === 'title') {
      const block = ctx.blocks.get(op.rowId) as Y.Map<unknown> | undefined;
      if (!block) {
        throw new NotFoundException(`Row "${op.rowId}" not found`);
      }
      block.set('prop:text', new Y.Text(String(op.value)));
      return;
    }

    this.writeCell(ctx, op.rowId, op.columnId, op.value);
  }

  private deleteRow(ctx: BoardCtx, op: DeleteRowOp): void {
    const dbChildren = ctx.db.get('sys:children') as Y.Array<string>;
    const idx = dbChildren.toArray().indexOf(op.rowId);
    if (idx === -1) {
      throw new NotFoundException(`Row "${op.rowId}" not found`);
    }
    dbChildren.delete(idx, 1);
    ctx.blocks.delete(op.rowId);
    ctx.cells.delete(op.rowId);
  }

  /**
   * Appends a new view (`prop:views` entry). For `mode === 'kanban'`, ensures
   * a group column (via {@link ensureGroupColumn}) and initializes the
   * nested `groupBy` descriptor + empty `groupProperties`, mirroring real
   * BlockSuite kanban views (`blocksuite/affine/data-view/src/view-presets/kanban/define.ts`).
   *
   * This is a fresh element being pushed, not a mutation of an existing one,
   * so a plain `push` is tracked incrementally by Yjs - unlike `moveCard`
   * below, which must replace an existing view element.
   */
  private addView(ctx: BoardCtx, op: AddViewOp): void {
    const view: StoredView = {
      id: nanoid(),
      name: op.name ?? this.defaultViewName(op.mode),
      mode: op.mode,
    };

    if (op.mode === 'kanban') {
      const { columnId, columnName } = this.ensureGroupColumn(
        ctx,
        op.groupByColumnId
      );
      view.groupBy = { type: 'groupBy', columnId, name: columnName };
      view.groupProperties = [];
    }

    ctx.views.push([view]);
  }

  private defaultViewName(mode: string): string {
    return `${mode.charAt(0).toUpperCase()}${mode.slice(1)} View`;
  }

  /**
   * Resolves the group column for a new kanban view: reuses
   * `groupByColumnId` when it names an existing `select` column, otherwise
   * creates a default "Status" select column (`Todo`/`In Progress`/`Done`)
   * via {@link appendColumn}, mirroring the editor's default.
   */
  private ensureGroupColumn(
    ctx: BoardCtx,
    groupByColumnId?: string
  ): { columnId: string; columnName: string } {
    if (groupByColumnId) {
      const idx = findColumnIndex(ctx.columns, groupByColumnId);
      if (idx !== -1) {
        const existing = ctx.columns.get(idx);
        if (existing.type === 'select') {
          return { columnId: existing.id, columnName: existing.name };
        }
      }
    }

    const column = this.appendColumn(
      ctx,
      DEFAULT_GROUP_COLUMN_NAME,
      'select',
      DEFAULT_GROUP_COLUMN_OPTIONS
    );
    return { columnId: column.id, columnName: column.name };
  }

  /**
   * Moves `op.rowId` into the kanban group for `op.toGroupValue`: writes the
   * card's group-column cell (auto-creating the option if new, via
   * {@link writeCell}), then updates the board's (first) kanban view's
   * `groupProperties` so the row appears in the target group's
   * `manuallyCardSort` and no other group's.
   *
   * CAVEAT: mutating `view` (a plain object already inside `ctx.views`, a
   * `Y.Array`) in place is NOT observed by Yjs's state-vector delta - the
   * same caveat proven for `prop:columns` in `applyToBinary`'s doc comment.
   * The updated view MUST replace the array element (`delete` + `insert`),
   * never be edited in place.
   */
  private moveCard(ctx: BoardCtx, op: MoveCardOp): void {
    const views = ctx.views.toArray() as StoredView[];
    const viewIndex = views.findIndex(view => view.mode === 'kanban');
    if (viewIndex === -1) {
      throw new NotFoundException('Board has no kanban view');
    }
    const view = views[viewIndex];
    const groupColumnId = view.groupBy?.columnId;
    if (!groupColumnId) {
      throw new NotFoundException('Kanban view has no group column configured');
    }

    this.writeCell(ctx, op.rowId, groupColumnId, op.toGroupValue);

    // Read back the value writeCell just stored (the select option id) so
    // the group key matches exactly what the cell now holds, rather than
    // re-deriving it (which could risk creating a second duplicate option).
    const rowCells = ctx.cells.get(op.rowId) as Y.Map<unknown> | undefined;
    const cell = rowCells?.get(groupColumnId) as Y.Map<unknown> | undefined;
    const key = String(cell?.get('value'));

    const groupProperties: StoredGroupProperty[] = (
      view.groupProperties ?? []
    ).map(property => ({
      key: property.key,
      manuallyCardSort: (property.manuallyCardSort ?? []).filter(
        rowId => rowId !== op.rowId
      ),
    }));

    let target = groupProperties.find(property => property.key === key);
    if (!target) {
      target = { key, manuallyCardSort: [] };
      groupProperties.push(target);
    }
    (target.manuallyCardSort ??= []).push(op.rowId);

    const updatedView: StoredView = { ...view, groupProperties };
    ctx.views.delete(viewIndex, 1);
    ctx.views.insert(viewIndex, [updatedView]);
  }

  /**
   * Writes a single non-title cell value: encodes `value` for `columnId`'s
   * column, rejecting read-only columns, then sets it on the row's cell
   * `Y.Map` (creating the row's cell map / the cell itself if missing).
   *
   * CAVEAT: `encodeCell` may auto-create a select/multi-select option by
   * mutating `column.data.options` in place - a plain-object mutation inside
   * `ctx.columns` (a `Y.Array` of plain objects) that Yjs's state-vector
   * delta does NOT observe (see applyToBinary's caveat). So after encoding,
   * always re-persist the (possibly-mutated) column back into `ctx.columns`
   * by replacing the element, exactly like `updateColumn`/`deleteColumn` do.
   */
  private writeCell(
    ctx: BoardCtx,
    rowId: string,
    columnId: string,
    value: unknown
  ): void {
    if (!ctx.blocks.has(rowId)) {
      throw new NotFoundException(`Row "${rowId}" not found`);
    }

    const idx = requireColumnIndex(ctx.columns, columnId);
    const column = ctx.columns.get(idx);

    if (isReadOnlyType(column.type)) {
      throw new Error(
        `Column "${columnId}" has read-only type "${column.type}" and cannot be written`
      );
    }

    const encoded = encodeCell(column, value, ctx.doc);

    // Re-persist the column element in case encodeCell auto-created a select/
    // multi-select option - see this method's caveat doc above. Only
    // select/multi-select can trigger that auto-create, so scalar column
    // types skip this replace to keep their delta minimal.
    if (column.type === 'select' || column.type === 'multi-select') {
      ctx.columns.delete(idx, 1);
      ctx.columns.insert(idx, [column]);
    }

    let rowCells = ctx.cells.get(rowId) as Y.Map<unknown> | undefined;
    if (!rowCells) {
      rowCells = new Y.Map<unknown>();
      ctx.cells.set(rowId, rowCells);
    }

    const existingCell = rowCells.get(columnId) as Y.Map<unknown> | undefined;
    if (existingCell) {
      existingCell.set('value', encoded);
    } else {
      const cell = new Y.Map<unknown>();
      cell.set('columnId', columnId);
      cell.set('value', encoded);
      rowCells.set(columnId, cell);
    }
  }

  private emitDocUpdatesPushed(payload: {
    spaceId: string;
    docId: string;
    updates: Uint8Array[];
    timestamp: number;
    editor?: string;
  }) {
    this.event.emit('doc.updates.pushed', {
      spaceType: 'workspace',
      spaceId: payload.spaceId,
      docId: payload.docId,
      updates: payload.updates,
      timestamp: payload.timestamp,
      editor: payload.editor,
    });
  }
}
