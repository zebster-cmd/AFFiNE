import { Logger } from '@nestjs/common';
import { z } from 'zod';

import { DocReader } from '../../../core/doc';
import {
  DocLinksWriter,
  type LinkOp,
} from '../../../core/doc/doc-links-writer';
import {
  buildPageIndexFromRoot,
  type PageIndex,
} from '../../../core/doc/doc-properties-reader';
import { PermissionAccess } from '../../../core/permission';
import { type ToolError, toolError } from './error';
import { defineTool } from './tool';
import type { CopilotChatOptions } from './types';

const logger = new Logger('DocLinksUpdateTool');

/** Narrower guard for `resolveTarget`'s `string | ToolError` return. */
const isTargetError = (result: string | ToolError): result is ToolError =>
  typeof result !== 'string';

const LinkModeSchema = z.enum(['embed', 'inline']);

const CreateLinkToolOpSchema = z.object({
  op: z.literal('create_link'),
  target: z.string().describe('The document to link to, by id or exact title'),
  mode: LinkModeSchema.optional().describe(
    "Defaults to 'embed'; 'inline' inserts a @-mention style reference instead"
  ),
  anchorBlockId: z
    .string()
    .optional()
    .describe(
      "Inline mode only; defaults to the source document's last paragraph block"
    ),
});
const RemoveLinkToolOpSchema = z.object({
  op: z.literal('remove_link'),
  target: z
    .string()
    .describe('The linked document to remove, by id or exact title'),
  blockId: z
    .string()
    .optional()
    .describe(
      'Names the block to remove/search; omit to search every block in the document'
    ),
});
const RetargetLinkToolOpSchema = z.object({
  op: z.literal('retarget_link'),
  blockId: z
    .string()
    .optional()
    .describe('Same scoping as remove_link.blockId'),
  fromTarget: z
    .string()
    .optional()
    .describe(
      'The current target, by id or exact title; required to locate an inline reference when blockId is omitted'
    ),
  toTarget: z
    .string()
    .describe('The new target document, by id or exact title'),
});
const CreateDocAndLinkToolOpSchema = z.object({
  op: z.literal('create_doc_and_link'),
  title: z.string().describe('Title of the new document to create'),
  mode: LinkModeSchema.optional(),
  anchorBlockId: z.string().optional(),
});

/** The 4 mutation ops a `doc_links_update` batch may contain, referencing targets by name or id. */
export const DocLinksToolOpSchema = z.discriminatedUnion('op', [
  CreateLinkToolOpSchema,
  RemoveLinkToolOpSchema,
  RetargetLinkToolOpSchema,
  CreateDocAndLinkToolOpSchema,
]);
export type DocLinksToolOp = z.infer<typeof DocLinksToolOpSchema>;

/**
 * Resolves a target reference (doc id or exact title) against a `PageIndex`
 * built once per handler invocation (see `buildPageIndexFromRoot`): an exact
 * id match always wins; otherwise every doc whose title equals `ref` is a
 * candidate. Returns the resolved id, or a `ToolError` naming zero/ambiguous
 * matches.
 */
function resolveTarget(index: PageIndex, ref: string): string | ToolError {
  if (index.ids.has(ref)) {
    return ref;
  }
  const matches = index.byTitle.get(ref) ?? [];
  if (matches.length === 0) {
    return toolError(
      'Doc Links Update Failed',
      `No document found matching "${ref}" (by id or title).`
    );
  }
  if (matches.length > 1) {
    return toolError(
      'Doc Links Update Failed',
      `"${ref}" matches multiple documents (${matches.join(', ')}); specify a doc id instead.`
    );
  }
  return matches[0];
}

export const buildDocLinksUpdateHandler = (
  ac: PermissionAccess,
  writer: DocLinksWriter,
  docReader: DocReader
) => {
  return async (
    options: CopilotChatOptions,
    docId: string,
    operations: DocLinksToolOp[]
  ) => {
    if (!options?.user || !options.workspace) {
      return toolError(
        'Doc Links Update Failed',
        'Missing user or workspace context'
      );
    }

    const canAccess = await ac
      .user(options.user)
      .workspace(options.workspace)
      .doc(docId)
      .can('Doc.Update');
    if (!canAccess) {
      logger.warn(
        `User ${options.user} does not have access to doc ${docId} in workspace ${options.workspace}`
      );
      return toolError(
        'Doc Links Update Failed',
        `You do not have permission to update document ${docId} in this workspace.`
      );
    }

    const needsRoot = operations.some(op => op.op !== 'create_doc_and_link');
    const rootRec = needsRoot
      ? await docReader.getDoc(options.workspace, options.workspace)
      : null;
    if (needsRoot && !rootRec?.bin) {
      return toolError(
        'Doc Links Update Failed',
        `Workspace root doc not found for workspace "${options.workspace}"`
      );
    }
    const rootBin = rootRec?.bin ?? null;
    // Parse the root doc's page index ONCE per invocation (not once per op)
    // so an N-op batch does a single Y.Doc/applyUpdate pass instead of up to
    // 2N. When no op needs resolution, `rootBin` is null and this is a
    // trivial empty-doc parse.
    const targetIndex: PageIndex = buildPageIndexFromRoot(rootBin);

    const resolvedOps: LinkOp[] = [];
    for (const op of operations) {
      switch (op.op) {
        case 'create_link': {
          const targetDocId = resolveTarget(targetIndex, op.target);
          if (isTargetError(targetDocId)) return targetDocId;
          resolvedOps.push({
            op: 'create_link',
            targetDocId,
            mode: op.mode,
            anchorBlockId: op.anchorBlockId,
          });
          break;
        }

        case 'remove_link': {
          const targetDocId = resolveTarget(targetIndex, op.target);
          if (isTargetError(targetDocId)) return targetDocId;
          resolvedOps.push({
            op: 'remove_link',
            targetDocId,
            blockId: op.blockId,
          });
          break;
        }

        case 'retarget_link': {
          let fromTargetDocId: string | undefined;
          if (op.fromTarget) {
            const resolved = resolveTarget(targetIndex, op.fromTarget);
            if (isTargetError(resolved)) return resolved;
            fromTargetDocId = resolved;
          }
          const toTargetDocId = resolveTarget(targetIndex, op.toTarget);
          if (isTargetError(toTargetDocId)) return toTargetDocId;
          resolvedOps.push({
            op: 'retarget_link',
            blockId: op.blockId,
            fromTargetDocId,
            toTargetDocId,
          });
          break;
        }

        case 'create_doc_and_link': {
          resolvedOps.push({
            op: 'create_doc_and_link',
            title: op.title,
            mode: op.mode,
            anchorBlockId: op.anchorBlockId,
          });
          break;
        }

        default: {
          // Exhaustive: all 4 DocLinksToolOp variants are handled above.
          const unknownOp = op as DocLinksToolOp;
          return toolError(
            'Doc Links Update Failed',
            `Doc-links op "${unknownOp.op}" is not yet implemented`
          );
        }
      }
    }

    const result = await writer.applyOps(
      options.workspace,
      docId,
      resolvedOps,
      options.user
    );

    return {
      success: true,
      applied: result.applied,
      created: result.created,
    };
  };
};

export const createDocLinksUpdateTool = (
  applyOps: (docId: string, operations: DocLinksToolOp[]) => Promise<object>
) => {
  return defineTool({
    description:
      "Apply a batch of mutation operations to a document's links. Supported ops: create_link (embed block or inline @-mention to a target document), remove_link, retarget_link (repoints an existing link to a new document), and create_doc_and_link (spins off a brand-new document and links to it). Each op's target/fromTarget/toTarget may be given as a document id or an exact document title; an ambiguous or unmatched title is reported as an error. Ops are applied in order within a single transaction.",
    inputSchema: z.object({
      doc_id: z.string().describe('The document to update links on'),
      operations: z
        .array(DocLinksToolOpSchema)
        .min(1)
        .describe('The ordered batch of mutation ops to apply'),
    }),
    execute: async ({ doc_id, operations }) => {
      try {
        return await applyOps(doc_id, operations as DocLinksToolOp[]);
      } catch (err: any) {
        logger.error(`Failed to apply doc-links ops to doc ${doc_id}`, err);
        return toolError('Doc Links Update Failed', err.message ?? String(err));
      }
    },
  });
};
