import { Logger } from '@nestjs/common';
import { z } from 'zod';

import { DatabaseWriter } from '../../../core/doc';
import type { CreateBoardSpec } from '../../../core/doc/database-writer';
import { PermissionAccess } from '../../../core/permission';
import { toolError } from './error';
import { defineTool } from './tool';
import type { CopilotChatOptions } from './types';

const logger = new Logger('DatabaseCreateTool');

const PropertyTypeInputSchema = z.enum([
  'title',
  'rich-text',
  'text',
  'select',
  'multi-select',
  'number',
  'progress',
  'checkbox',
  'date',
  'link',
]);

const ColumnSpecSchema = z.object({
  name: z.string().describe('Column display name'),
  type: PropertyTypeInputSchema.describe('Column property type'),
  options: z
    .array(z.object({ value: z.string(), color: z.string().optional() }))
    .optional()
    .describe('Select/multi-select options (ignored for other column types)'),
});

const ViewSpecSchema = z.object({
  mode: z.enum(['table', 'kanban']).describe('The view mode'),
  name: z.string().optional().describe('Display name for the view'),
  groupByColumnName: z
    .string()
    .optional()
    .describe(
      'Kanban only: name of an existing (or about-to-be-created) select column to group cards by. If omitted for a kanban view, a default "Status" select column is created.'
    ),
});

const RowSpecSchema = z.object({
  title: z.string().optional().describe('The row title (title column value)'),
  cells: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Cell values keyed by column name'),
});

const CreateBoardInputSchema = z.object({
  doc_id: z.string().describe('The document to add the board to'),
  title: z.string().describe('The board (database block) title'),
  columns: z.array(ColumnSpecSchema).describe('The columns to create'),
  view: ViewSpecSchema.describe('The initial view to create'),
  rows: z
    .array(RowSpecSchema)
    .optional()
    .describe('Initial rows to seed the board with'),
});

export const buildDatabaseCreateHandler = (
  ac: PermissionAccess,
  writer: DatabaseWriter
) => {
  return async (
    options: CopilotChatOptions,
    docId: string,
    spec: CreateBoardSpec
  ) => {
    if (!options?.user || !options.workspace) {
      return toolError(
        'Database Create Failed',
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
        'Database Create Failed',
        `You do not have permission to update document ${docId} in this workspace.`
      );
    }

    const result = await writer.createBoard(
      options.workspace,
      docId,
      spec,
      options.user
    );

    return { success: true, blockId: result.blockId };
  };
};

export const createDatabaseCreateTool = (
  createBoard: (docId: string, spec: CreateBoardSpec) => Promise<object>
) => {
  return defineTool({
    description:
      'Create a new database/kanban board (an affine:database block) inside an existing document, with the given columns, an initial view, and optional seed rows. Supported column property types: title, rich-text, text, select, multi-select, number, progress, checkbox, date, link. A title column is always ensured even if not listed. Row `cells` are keyed by column *name* (not id). For a kanban view, `groupByColumnName` names the select column to group cards by; omit it to auto-create a default "Status" select column.',
    inputSchema: CreateBoardInputSchema,
    execute: async ({ doc_id, title, columns, view, rows }) => {
      try {
        return await createBoard(doc_id, { title, columns, view, rows });
      } catch (err: any) {
        logger.error(`Failed to create database board in doc ${doc_id}`, err);
        return toolError('Database Create Failed', err.message ?? String(err));
      }
    },
  });
};
