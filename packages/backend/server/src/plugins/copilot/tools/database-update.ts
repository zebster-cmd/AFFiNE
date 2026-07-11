import { Logger } from '@nestjs/common';
import { z } from 'zod';

import { DatabaseWriter } from '../../../core/doc';
import {
  type DatabaseOp,
  DatabaseOpSchema,
} from '../../../core/doc/database-types';
import { PermissionAccess } from '../../../core/permission';
import { toolError } from './error';
import { defineTool } from './tool';
import type { CopilotChatOptions } from './types';

const logger = new Logger('DatabaseUpdateTool');

export const buildDatabaseUpdateHandler = (
  ac: PermissionAccess,
  writer: DatabaseWriter
) => {
  return async (
    options: CopilotChatOptions,
    docId: string,
    databaseBlockId: string,
    operations: DatabaseOp[]
  ) => {
    if (!options?.user || !options.workspace) {
      return toolError(
        'Database Update Failed',
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
        'Database Update Failed',
        `You do not have permission to update document ${docId} in this workspace.`
      );
    }

    await writer.applyOps(
      options.workspace,
      docId,
      databaseBlockId,
      operations,
      options.user
    );

    return {
      success: true,
      blockId: databaseBlockId,
      applied: operations.length,
    };
  };
};

export const createDatabaseUpdateTool = (
  applyOps: (
    docId: string,
    databaseBlockId: string,
    operations: DatabaseOp[]
  ) => Promise<object>
) => {
  return defineTool({
    description:
      'Apply a batch of mutation operations to an existing database/kanban board (an affine:database block). Supported ops: add_column, update_column (rename/edit options), delete_column, add_row (optionally seeding cells), update_cell (title column updates the row text instead), delete_row, add_view (table or kanban), and move_card (kanban only - moves a row into a different group, auto-creating the group option if new). Ops are applied in order within a single transaction.',
    inputSchema: z.object({
      doc_id: z
        .string()
        .describe('The document containing the database/kanban board'),
      database_block_id: z.string().describe('The database block to update'),
      operations: z
        .array(DatabaseOpSchema)
        .min(1)
        .describe('The ordered batch of mutation ops to apply'),
    }),
    execute: async ({ doc_id, database_block_id, operations }) => {
      try {
        // zod's `z.unknown()` (UpdateCellOp's `value`) infers the property as
        // optional even though the schema always requires the key, so the
        // parsed array's static type isn't quite `DatabaseOp[]` - safe to
        // assert since zod has already validated the shape at runtime.
        return await applyOps(
          doc_id,
          database_block_id,
          operations as DatabaseOp[]
        );
      } catch (err: any) {
        logger.error(
          `Failed to apply database ops to block ${database_block_id} in doc ${doc_id}`,
          err
        );
        return toolError('Database Update Failed', err.message ?? String(err));
      }
    },
  });
};
