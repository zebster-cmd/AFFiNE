import { Logger } from '@nestjs/common';
import { z } from 'zod';

import {
  DocReader,
  listBoardsFromBinary,
  readBoardFromBinary,
} from '../../../core/doc';
import type { BoardJSON } from '../../../core/doc/database-types';
import { PermissionAccess } from '../../../core/permission';
import { type ToolError, toolError } from './error';
import { defineTool } from './tool';
import type { CopilotChatOptions } from './types';

const logger = new Logger('DatabaseReadTool');

const isToolError = (result: ToolError | object): result is ToolError =>
  'type' in result && result.type === 'error';

/** List-of-boards shape returned when `database_block_id` is omitted. */
export interface DatabaseListResult {
  databases: { blockId: string; title: string; viewModes: string[] }[];
}

export const buildDatabaseReadHandler = (
  ac: PermissionAccess,
  docReader: DocReader
) => {
  return async (
    options: CopilotChatOptions,
    docId: string,
    databaseBlockId?: string
  ): Promise<ToolError | BoardJSON | DatabaseListResult> => {
    if (!options?.user || !options.workspace) {
      return toolError(
        'Database Read Failed',
        'Missing user or workspace context'
      );
    }

    const canAccess = await ac
      .user(options.user)
      .workspace(options.workspace)
      .doc(docId)
      .can('Doc.Read');
    if (!canAccess) {
      logger.warn(
        `User ${options.user} does not have access to doc ${docId} in workspace ${options.workspace}`
      );
      return toolError(
        'Database Read Failed',
        `You do not have permission to read document ${docId} in this workspace.`
      );
    }

    const rec = await docReader.getDoc(options.workspace, docId);
    if (!rec?.bin) {
      return toolError(
        'Database Read Failed',
        `Doc with id ${docId} not found.`
      );
    }

    if (databaseBlockId) {
      // May throw (e.g. unknown block id) - left uncaught here so
      // createDatabaseReadTool's try/catch turns it into a toolError.
      return readBoardFromBinary(rec.bin, databaseBlockId);
    }

    return { databases: listBoardsFromBinary(rec.bin) };
  };
};

type DatabaseReadToolResult = Awaited<
  ReturnType<ReturnType<typeof buildDatabaseReadHandler>>
>;

export const createDatabaseReadTool = (
  getBoard: (
    docId: string,
    databaseBlockId?: string
  ) => Promise<DatabaseReadToolResult>
) => {
  return defineTool({
    description:
      'Read a database/kanban board embedded in a document. Given database_block_id, returns its full structure (columns with types/options, rows with decoded cell values, and views including kanban groups). Without database_block_id, lists every board in the document (blockId, title, view modes) so the model can pick one to read in detail.',
    inputSchema: z.object({
      doc_id: z
        .string()
        .describe('The document containing the database/kanban board'),
      database_block_id: z
        .string()
        .optional()
        .describe(
          'The specific database block to read; omit to list all boards in the document instead'
        ),
    }),
    execute: async ({ doc_id, database_block_id }) => {
      try {
        const result = await getBoard(doc_id, database_block_id);
        return isToolError(result) ? result : { ...result };
      } catch (err: any) {
        logger.error(`Failed to read database in doc ${doc_id}`, err);
        return toolError('Database Read Failed', err.message ?? String(err));
      }
    },
  });
};
