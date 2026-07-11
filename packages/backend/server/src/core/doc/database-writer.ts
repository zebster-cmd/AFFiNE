import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { nanoid } from 'nanoid';
import * as Y from 'yjs';

import { EventBus } from '../../base';
import { PgWorkspaceDocStorageAdapter } from './adapters/workspace';
import type { StoredColumn, StoredOption } from './database-codec';
import type {
  AddColumnOp,
  DatabaseOp,
  DeleteColumnOp,
  UpdateColumnOp,
} from './database-types';

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
 * Task 4 implements only the three column ops (`add_column`/
 * `update_column`/`delete_column`); row/kanban/create ops (Tasks 5-6) slot
 * into the `default: throw` branch of {@link applyOps}'s op switch.
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
          default:
            throw new Error(`Database op "${op.op}" is not yet implemented`);
        }
      }
    });

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

    this.logger.debug(
      `Applied ${ops.length} database op(s) to block ${blockId} in doc ${docId}`
    );
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
    const options: StoredOption[] = (op.options ?? []).map(option => ({
      id: nanoid(),
      value: option.value,
      color: option.color,
    }));
    const column: StoredColumn = {
      id: nanoid(),
      type: op.type,
      name: op.name,
      data: { options },
    };
    // A Y.Array insert - tracked incrementally by Yjs (unlike mutating an
    // element already in the array, see the applyToBinary caveat above).
    ctx.columns.push([column]);
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
