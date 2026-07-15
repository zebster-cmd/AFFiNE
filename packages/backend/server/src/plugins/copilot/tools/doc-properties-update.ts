import { Logger } from '@nestjs/common';
import { z } from 'zod';

import {
  DocPropertiesWriter,
  type DocPropertyOp,
  DocPropertyOpSchema,
} from '../../../core/doc/doc-properties-writer';
import { PermissionAccess } from '../../../core/permission';
import { toolError } from './error';
import { defineTool } from './tool';
import type { CopilotChatOptions } from './types';

const logger = new Logger('DocPropertiesUpdateTool');

export const buildDocPropertiesUpdateHandler = (
  ac: PermissionAccess,
  writer: DocPropertiesWriter
) => {
  return async (
    options: CopilotChatOptions,
    docId: string,
    operations: DocPropertyOp[]
  ) => {
    if (!options?.user || !options.workspace) {
      return toolError(
        'Doc Properties Update Failed',
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
        'Doc Properties Update Failed',
        `You do not have permission to update document ${docId} in this workspace.`
      );
    }

    const result = await writer.applyOps(
      options.workspace,
      docId,
      options.user,
      operations,
      options.user
    );

    return {
      success: true,
      applied: result.applied,
      createdTagIds: result.createdTagIds,
      createdPropertyIds: result.createdPropertyIds,
    };
  };
};

export const createDocPropertiesUpdateTool = (
  applyOps: (docId: string, operations: DocPropertyOp[]) => Promise<object>
) => {
  return defineTool({
    description:
      'Apply a batch of mutation operations to a document\'s attributes. Supported ops: set_title, set_trash, set_journal ("YYYY-MM-DD" or "" to clear), set_mode (page/edgeless), add_tag/remove_tag (by tag name or id), create_tag, define_property (text/number/checkbox/date/tags - select/multi-select only exist inside database blocks), set_property (by property name or id), and set_favorite. Ops are applied in order within a single transaction; an invalid op aborts the whole batch.',
    inputSchema: z.object({
      doc_id: z.string().describe('The document whose attributes to update'),
      operations: z
        .array(DocPropertyOpSchema)
        .min(1)
        .describe('The ordered batch of mutation ops to apply'),
    }),
    execute: async ({ doc_id, operations }) => {
      try {
        // zod's `z.unknown()` (SetPropertyOp's `value`) infers the property as
        // optional even though the schema always requires the key, so the
        // parsed array's static type isn't quite `DocPropertyOp[]` - safe to
        // assert since zod has already validated the shape at runtime.
        return await applyOps(doc_id, operations as DocPropertyOp[]);
      } catch (err: any) {
        logger.error(
          `Failed to apply doc-properties ops to doc ${doc_id}`,
          err
        );
        return toolError(
          'Doc Properties Update Failed',
          err.message ?? String(err)
        );
      }
    },
  });
};
