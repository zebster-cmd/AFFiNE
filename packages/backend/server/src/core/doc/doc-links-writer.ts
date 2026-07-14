import { Injectable, NotFoundException } from '@nestjs/common';
import { nanoid } from 'nanoid';
import * as Y from 'yjs';
import { z } from 'zod';

import { EventBus } from '../../base';
import { PgWorkspaceDocStorageAdapter } from './adapters/workspace';
import { DocWriter } from './writer';
import { YjsDeltaWriter } from './yjs-delta';

const EMBED_LINK_FLAVOUR = 'affine:embed-linked-doc';
const PARAGRAPH_FLAVOUR = 'affine:paragraph';
const NOTE_FLAVOUR = 'affine:note';

/** `create_link`/`create_doc_and_link` share this default-embed mode switch. */
const LinkModeSchema = z.enum(['embed', 'inline']);
export type LinkMode = z.infer<typeof LinkModeSchema>;

export interface CreateLinkOp {
  op: 'create_link';
  targetDocId: string;
  /** Defaults to `'embed'`. */
  mode?: LinkMode;
  /** Inline mode only; defaults to the doc's last paragraph block. */
  anchorBlockId?: string;
}
export interface RemoveLinkOp {
  op: 'remove_link';
  targetDocId: string;
  /**
   * Names the block to remove/search. An embed-linked-doc block is deleted
   * outright; any other block is scoped to just that block's inline
   * reference. Omitted entirely, every block in the doc is searched.
   */
  blockId?: string;
}
export interface RetargetLinkOp {
  op: 'retarget_link';
  /** Same scoping semantics as {@link RemoveLinkOp.blockId}. */
  blockId?: string;
  /** Required to locate an inline reference when `blockId` is omitted (or names a non-embed block). */
  fromTargetDocId?: string;
  toTargetDocId: string;
}
export interface CreateDocAndLinkOp {
  op: 'create_doc_and_link';
  title: string;
  mode?: LinkMode;
  anchorBlockId?: string;
}

/** The 4 mutation ops a `doc_links_update` batch may contain. */
export type LinkOp =
  | CreateLinkOp
  | RemoveLinkOp
  | RetargetLinkOp
  | CreateDocAndLinkOp;

const CreateLinkOpSchema = z.object({
  op: z.literal('create_link'),
  targetDocId: z.string(),
  mode: LinkModeSchema.optional(),
  anchorBlockId: z.string().optional(),
});
const RemoveLinkOpSchema = z.object({
  op: z.literal('remove_link'),
  targetDocId: z.string(),
  blockId: z.string().optional(),
});
const RetargetLinkOpSchema = z.object({
  op: z.literal('retarget_link'),
  blockId: z.string().optional(),
  fromTargetDocId: z.string().optional(),
  toTargetDocId: z.string(),
});
const CreateDocAndLinkOpSchema = z.object({
  op: z.literal('create_doc_and_link'),
  title: z.string(),
  mode: LinkModeSchema.optional(),
  anchorBlockId: z.string().optional(),
});

/** Zod schema for {@link LinkOp}, used by the `doc_links_update` tool input. */
export const LinkOpSchema = z.discriminatedUnion('op', [
  CreateLinkOpSchema,
  RemoveLinkOpSchema,
  RetargetLinkOpSchema,
  CreateDocAndLinkOpSchema,
]);

/** One created block/doc, returned by `applyOps` so the caller can reference it in a follow-up. */
export interface CreatedLink {
  op: 'create_link' | 'create_doc_and_link';
  /** The embed block's id (embed mode) or the anchor block's id (inline mode). */
  blockId: string;
  /** `create_doc_and_link` only: the newly created doc's id. */
  newDocId?: string;
}

/** Finds the id of the first `affine:note` block, or `undefined` if none exists. */
function findNoteBlockId(blocks: Y.Map<unknown>): string | undefined {
  for (const [id, block] of blocks.entries()) {
    if ((block as Y.Map<unknown>).get('sys:flavour') === NOTE_FLAVOUR) {
      return id;
    }
  }
  return undefined;
}

/** Finds the last (in document order) `affine:paragraph` child of the doc's (first) note. */
function findLastParagraphBlockId(blocks: Y.Map<unknown>): string | undefined {
  const noteId = findNoteBlockId(blocks);
  if (!noteId) {
    return undefined;
  }
  const note = blocks.get(noteId) as Y.Map<unknown>;
  const children = (note.get('sys:children') as Y.Array<string>).toArray();
  for (let i = children.length - 1; i >= 0; i--) {
    const child = blocks.get(children[i]) as Y.Map<unknown> | undefined;
    if (child?.get('sys:flavour') === PARAGRAPH_FLAVOUR) {
      return children[i];
    }
  }
  return undefined;
}

/** Finds an `affine:embed-linked-doc` block whose `prop:pageId` matches `targetDocId`, or `undefined`. */
function findEmbedBlockId(
  blocks: Y.Map<unknown>,
  targetDocId: string
): string | undefined {
  for (const [id, block] of blocks.entries()) {
    const map = block as Y.Map<unknown>;
    if (
      map.get('sys:flavour') === EMBED_LINK_FLAVOUR &&
      map.get('prop:pageId') === targetDocId
    ) {
      return id;
    }
  }
  return undefined;
}

/**
 * Walks a block's `prop:text` delta (`Y.Text.toDelta()`) for an op whose
 * `attributes.reference.pageId === targetDocId`, returning its character
 * offset (per the change's design.md Decision 5 "walk the deltas" approach).
 */
function findReferenceOffset(
  ytext: Y.Text | undefined,
  targetDocId: string
): number | undefined {
  if (!ytext) {
    return undefined;
  }
  const delta = ytext.toDelta() as {
    insert?: string;
    attributes?: { reference?: { pageId?: string } };
  }[];
  let offset = 0;
  for (const entry of delta) {
    const len = typeof entry.insert === 'string' ? entry.insert.length : 1;
    if (entry.attributes?.reference?.pageId === targetDocId) {
      return offset;
    }
    offset += len;
  }
  return undefined;
}

/** Finds a block (anywhere in `blocks`) whose `prop:text` carries an inline reference to `targetDocId`. */
function findInlineReferenceBlockId(
  blocks: Y.Map<unknown>,
  targetDocId: string
): string | undefined {
  for (const [id, block] of blocks.entries()) {
    const ytext = (block as Y.Map<unknown>).get('prop:text');
    if (
      ytext instanceof Y.Text &&
      findReferenceOffset(ytext, targetDocId) !== undefined
    ) {
      return id;
    }
  }
  return undefined;
}

/** Appends a new embed-linked-doc block under `noteId`, mirroring `DatabaseWriter.createBoard`'s note-find + append. */
function appendEmbedLinkBlock(
  doc: Y.Doc,
  noteId: string,
  blockId: string,
  targetDocId: string
): void {
  const blocks = doc.getMap('blocks');
  const note = blocks.get(noteId) as Y.Map<unknown>;

  const block = new Y.Map<unknown>();
  block.set('sys:id', blockId);
  block.set('sys:flavour', EMBED_LINK_FLAVOUR);
  block.set('sys:version', 1);
  block.set('sys:children', new Y.Array<string>());
  block.set('prop:pageId', targetDocId);
  block.set('prop:style', 'vertical');
  block.set('prop:caption', null);
  block.set('prop:title', null);
  block.set('prop:description', null);
  block.set('prop:footnoteIdentifier', null);
  // Fresh insert - tracked incrementally by Yjs (see database-writer.ts's
  // applyToBinary caveat doc for why this differs from mutating an element
  // already inside a Y.Array).
  blocks.set(blockId, block);

  const noteChildren = note.get('sys:children') as Y.Array<string>;
  noteChildren.push([blockId]);
}

/** Inserts the single-space `{ reference }` delta at the end of `block`'s `prop:text`. */
function insertInlineReference(
  block: Y.Map<unknown>,
  targetDocId: string
): void {
  const ytext = block.get('prop:text') as Y.Text;
  ytext.insert(ytext.length, ' ', {
    reference: { type: 'LinkedPage', pageId: targetDocId },
  });
}

/** Deletes the matching 1-char `{ reference }` delta from `block`'s `prop:text`, if present. */
function removeInlineReference(
  block: Y.Map<unknown>,
  targetDocId: string
): boolean {
  const ytext = block.get('prop:text') as Y.Text | undefined;
  if (!ytext) {
    return false;
  }
  const offset = findReferenceOffset(ytext, targetDocId);
  if (offset === undefined) {
    return false;
  }
  ytext.delete(offset, 1);
  return true;
}

/** Replaces the matching `{ reference }` delta's `pageId` (delete + re-insert at the same offset). */
function retargetInlineReference(
  block: Y.Map<unknown>,
  fromTargetDocId: string,
  toTargetDocId: string
): boolean {
  const ytext = block.get('prop:text') as Y.Text | undefined;
  if (!ytext) {
    return false;
  }
  const offset = findReferenceOffset(ytext, fromTargetDocId);
  if (offset === undefined) {
    return false;
  }
  ytext.delete(offset, 1);
  ytext.insert(offset, ' ', {
    reference: { type: 'LinkedPage', pageId: toTargetDocId },
  });
  return true;
}

/** Detaches `blockId` from whichever block's `sys:children` holds it, then deletes it from `blocks`. */
function removeBlockAndDetach(doc: Y.Doc, blockId: string): void {
  const blocks = doc.getMap('blocks');
  for (const [, block] of blocks.entries()) {
    const children = (block as Y.Map<unknown>).get('sys:children') as
      | Y.Array<string>
      | undefined;
    if (!children) {
      continue;
    }
    const idx = children.toArray().indexOf(blockId);
    if (idx !== -1) {
      children.delete(idx, 1);
      break;
    }
  }
  blocks.delete(blockId);
}

/** A queued mutation against the source doc's live `Y.Doc`, run inside `applyAndPush`'s single transaction. */
type Mutator = (doc: Y.Doc) => void;

/**
 * Applies `doc_links_update` op batches to a doc's links: `create_link`
 * (embed block or inline `@`-reference), `remove_link`, `retarget_link`, and
 * `create_doc_and_link` (spins off a brand-new linked doc). Mirrors
 * `DatabaseWriter`'s load/transact/encode-delta/push shape via
 * {@link YjsDeltaWriter}; all link mutations land on the SOURCE doc's own
 * binary via a single `applyAndPush` call.
 *
 * `create_doc_and_link` is the one op that also touches OTHER docs (via
 * {@link DocWriter.createDoc}, which registers the new doc in the workspace
 * root doc). To still give the "no partial write on an invalid op" guarantee
 * for ops touching the source doc, `applyOps` validates every op against a
 * read-only snapshot of the source doc FIRST (mirroring `DocPropertiesWriter`
 * `applyOps`'s up-front validation), and only once the whole batch is known
 * -valid does it create any new docs and push the source doc's delta.
 */
@Injectable()
export class DocLinksWriter extends YjsDeltaWriter {
  constructor(
    storage: PgWorkspaceDocStorageAdapter,
    event: EventBus,
    private readonly docWriter: DocWriter
  ) {
    super(storage, event);
  }

  async applyOps(
    workspaceId: string,
    sourceDocId: string,
    ops: LinkOp[],
    editorId?: string
  ): Promise<{ applied: number; created: CreatedLink[] }> {
    const bin = await this.getBinary(workspaceId, sourceDocId);
    if (bin === null) {
      throw new NotFoundException(`Document ${sourceDocId} not found`);
    }

    // Read-only validation snapshot - never mutated, never pushed. Every op is
    // checked against it up front so an invalid op (bad blockId, missing
    // anchor, ...) throws before any write - including before any
    // `create_doc_and_link` actually creates a doc.
    const validationDoc = new Y.Doc();
    Y.applyUpdate(validationDoc, bin);
    const blocks = validationDoc.getMap('blocks');

    type Planned =
      | { kind: 'mutator'; mutator: Mutator; created?: CreatedLink }
      | {
          kind: 'createDocAndLink';
          op: CreateDocAndLinkOp;
          anchorBlockId?: string;
          noteId?: string;
        };
    const planned: Planned[] = [];

    for (const op of ops) {
      switch (op.op) {
        case 'create_link': {
          const { mutator, blockId } = this.planCreateLink(blocks, op);
          planned.push({
            kind: 'mutator',
            mutator,
            created: { op: 'create_link', blockId },
          });
          break;
        }

        case 'remove_link': {
          planned.push({
            kind: 'mutator',
            mutator: this.planRemoveLink(blocks, sourceDocId, op),
          });
          break;
        }

        case 'retarget_link': {
          planned.push({
            kind: 'mutator',
            mutator: this.planRetargetLink(blocks, sourceDocId, op),
          });
          break;
        }

        case 'create_doc_and_link': {
          const mode = op.mode ?? 'embed';
          let anchorBlockId: string | undefined;
          let noteId: string | undefined;
          if (mode === 'inline') {
            anchorBlockId = this.resolveAnchor(blocks, op.anchorBlockId);
          } else {
            // Validated up front - same as `planCreateLink`'s embed branch -
            // so a source doc with no note block throws BEFORE any new doc is
            // created below, never leaving an orphaned, registered-but-
            // unlinked doc behind.
            noteId = findNoteBlockId(blocks);
            if (!noteId) {
              throw new NotFoundException(
                `Doc "${sourceDocId}" has no note block to hold the link`
              );
            }
          }
          planned.push({ kind: 'createDocAndLink', op, anchorBlockId, noteId });
          break;
        }

        default: {
          // Exhaustive: all 4 LinkOp variants are handled above.
          const unknownOp = op as LinkOp;
          throw new Error(
            `Doc-links op "${unknownOp.op}" is not yet implemented`
          );
        }
      }
    }

    // Everything validated - now, and only now, create any new docs and
    // build their link mutators, in order.
    const created: CreatedLink[] = [];
    const mutators: Mutator[] = [];
    for (const item of planned) {
      if (item.kind === 'mutator') {
        mutators.push(item.mutator);
        if (item.created) {
          created.push(item.created);
        }
        continue;
      }

      const { docId: newDocId } = await this.docWriter.createDoc(
        workspaceId,
        item.op.title,
        '',
        editorId
      );
      const mode = item.op.mode ?? 'embed';
      if (mode === 'embed') {
        // `noteId` was already resolved (and validated) up front, above.
        const noteId = item.noteId as string;
        const blockId = nanoid();
        mutators.push(doc =>
          appendEmbedLinkBlock(doc, noteId, blockId, newDocId)
        );
        created.push({ op: 'create_doc_and_link', blockId, newDocId });
      } else {
        const anchorBlockId = item.anchorBlockId as string;
        mutators.push(doc => {
          const liveBlock = doc
            .getMap('blocks')
            .get(anchorBlockId) as Y.Map<unknown>;
          insertInlineReference(liveBlock, newDocId);
        });
        created.push({
          op: 'create_doc_and_link',
          blockId: anchorBlockId,
          newDocId,
        });
      }
    }

    await this.applyAndPush(
      workspaceId,
      sourceDocId,
      doc => {
        for (const mutate of mutators) {
          mutate(doc);
        }
      },
      { editorId }
    );

    return { applied: ops.length, created };
  }

  /** Resolves an explicit `anchorBlockId` (verifying it has `prop:text`) or defaults to the doc's last paragraph. */
  private resolveAnchor(
    blocks: Y.Map<unknown>,
    anchorBlockId?: string
  ): string {
    const resolved = anchorBlockId ?? findLastParagraphBlockId(blocks);
    if (!resolved) {
      throw new NotFoundException(
        anchorBlockId
          ? `Anchor block "${anchorBlockId}" not found`
          : 'No anchor block found (and none specified) for an inline link'
      );
    }
    const block = blocks.get(resolved) as Y.Map<unknown> | undefined;
    if (!block || !(block.get('prop:text') instanceof Y.Text)) {
      throw new NotFoundException(
        `Anchor block "${resolved}" not found or has no prop:text`
      );
    }
    return resolved;
  }

  private planCreateLink(
    blocks: Y.Map<unknown>,
    op: CreateLinkOp
  ): { mutator: Mutator; blockId: string } {
    const mode = op.mode ?? 'embed';
    if (mode === 'embed') {
      const noteId = findNoteBlockId(blocks);
      if (!noteId) {
        throw new NotFoundException(
          'Document has no note block to hold the link'
        );
      }
      const blockId = nanoid();
      return {
        blockId,
        mutator: doc =>
          appendEmbedLinkBlock(doc, noteId, blockId, op.targetDocId),
      };
    }

    const anchorBlockId = this.resolveAnchor(blocks, op.anchorBlockId);
    return {
      blockId: anchorBlockId,
      mutator: doc => {
        const liveBlock = doc
          .getMap('blocks')
          .get(anchorBlockId) as Y.Map<unknown>;
        insertInlineReference(liveBlock, op.targetDocId);
      },
    };
  }

  private planRemoveLink(
    blocks: Y.Map<unknown>,
    sourceDocId: string,
    op: RemoveLinkOp
  ): Mutator {
    if (op.blockId) {
      const blockId = op.blockId;
      const block = blocks.get(blockId) as Y.Map<unknown> | undefined;
      if (!block) {
        throw new NotFoundException(
          `Block "${blockId}" not found in doc "${sourceDocId}"`
        );
      }
      if (block.get('sys:flavour') === EMBED_LINK_FLAVOUR) {
        const actualPageId = block.get('prop:pageId');
        if (actualPageId !== op.targetDocId) {
          throw new NotFoundException(
            `Block "${blockId}" links to "${actualPageId}", not the requested target "${op.targetDocId}"`
          );
        }
        return doc => removeBlockAndDetach(doc, blockId);
      }
      const ytext = block.get('prop:text') as Y.Text | undefined;
      if (findReferenceOffset(ytext, op.targetDocId) === undefined) {
        throw new NotFoundException(
          `No inline reference to "${op.targetDocId}" found in block "${blockId}"`
        );
      }
      return doc => {
        const liveBlock = doc.getMap('blocks').get(blockId) as Y.Map<unknown>;
        removeInlineReference(liveBlock, op.targetDocId);
      };
    }

    const embedBlockId = findEmbedBlockId(blocks, op.targetDocId);
    if (embedBlockId) {
      return doc => removeBlockAndDetach(doc, embedBlockId);
    }
    const inlineBlockId = findInlineReferenceBlockId(blocks, op.targetDocId);
    if (!inlineBlockId) {
      throw new NotFoundException(
        `No link to "${op.targetDocId}" found in doc "${sourceDocId}"`
      );
    }
    return doc => {
      const liveBlock = doc
        .getMap('blocks')
        .get(inlineBlockId) as Y.Map<unknown>;
      removeInlineReference(liveBlock, op.targetDocId);
    };
  }

  private planRetargetLink(
    blocks: Y.Map<unknown>,
    sourceDocId: string,
    op: RetargetLinkOp
  ): Mutator {
    if (op.blockId) {
      const blockId = op.blockId;
      const block = blocks.get(blockId) as Y.Map<unknown> | undefined;
      if (!block) {
        throw new NotFoundException(
          `Block "${blockId}" not found in doc "${sourceDocId}"`
        );
      }
      if (block.get('sys:flavour') === EMBED_LINK_FLAVOUR) {
        const actualPageId = block.get('prop:pageId');
        if (op.fromTargetDocId && actualPageId !== op.fromTargetDocId) {
          throw new NotFoundException(
            `Block "${blockId}" links to "${actualPageId}", not the requested source "${op.fromTargetDocId}"`
          );
        }
        return doc => {
          const liveBlock = doc.getMap('blocks').get(blockId) as Y.Map<unknown>;
          liveBlock.set('prop:pageId', op.toTargetDocId);
        };
      }
      if (!op.fromTargetDocId) {
        throw new Error(
          'retarget_link: fromTargetDocId is required to retarget an inline reference'
        );
      }
      const fromTargetDocId = op.fromTargetDocId;
      const ytext = block.get('prop:text') as Y.Text | undefined;
      if (findReferenceOffset(ytext, fromTargetDocId) === undefined) {
        throw new NotFoundException(
          `No inline reference to "${fromTargetDocId}" found in block "${blockId}"`
        );
      }
      return doc => {
        const liveBlock = doc.getMap('blocks').get(blockId) as Y.Map<unknown>;
        retargetInlineReference(liveBlock, fromTargetDocId, op.toTargetDocId);
      };
    }

    if (!op.fromTargetDocId) {
      throw new Error(
        'retarget_link: fromTargetDocId (or blockId) is required to locate the link'
      );
    }
    const fromTargetDocId = op.fromTargetDocId;

    const embedBlockId = findEmbedBlockId(blocks, fromTargetDocId);
    if (embedBlockId) {
      return doc => {
        const liveBlock = doc
          .getMap('blocks')
          .get(embedBlockId) as Y.Map<unknown>;
        liveBlock.set('prop:pageId', op.toTargetDocId);
      };
    }
    const inlineBlockId = findInlineReferenceBlockId(blocks, fromTargetDocId);
    if (!inlineBlockId) {
      throw new NotFoundException(
        `No link to "${fromTargetDocId}" found in doc "${sourceDocId}"`
      );
    }
    return doc => {
      const liveBlock = doc
        .getMap('blocks')
        .get(inlineBlockId) as Y.Map<unknown>;
      retargetInlineReference(liveBlock, fromTargetDocId, op.toTargetDocId);
    };
  }
}
