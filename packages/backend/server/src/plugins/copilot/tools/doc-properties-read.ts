import { Logger } from '@nestjs/common';
import { z } from 'zod';

import { DocPropertiesReader } from '../../../core/doc/doc-properties-reader';
import type { DocPropertiesView } from '../../../core/doc/doc-properties-types';
import { PermissionAccess } from '../../../core/permission';
import { type ToolError, toolError } from './error';
import { defineTool } from './tool';
import type { CopilotChatOptions } from './types';

const logger = new Logger('DocPropertiesReadTool');

const isToolError = (result: ToolError | object): result is ToolError =>
  'type' in result && result.type === 'error';

export const buildDocPropertiesReadHandler = (
  ac: PermissionAccess,
  reader: DocPropertiesReader
) => {
  return async (
    options: CopilotChatOptions,
    docId: string
  ): Promise<ToolError | DocPropertiesView> => {
    if (!options?.user || !options.workspace) {
      return toolError(
        'Doc Properties Read Failed',
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
        'Doc Properties Read Failed',
        `You do not have permission to read document ${docId} in this workspace.`
      );
    }

    const view = await reader.read(options.workspace, docId, options.user);
    if (!view) {
      return toolError(
        'Doc Properties Read Failed',
        `Doc with id ${docId} not found.`
      );
    }

    return view;
  };
};

type DocPropertiesReadToolResult = Awaited<
  ReturnType<ReturnType<typeof buildDocPropertiesReadHandler>>
>;

export const createDocPropertiesReadTool = (
  getProperties: (docId: string) => Promise<DocPropertiesReadToolResult>
) => {
  return defineTool({
    description:
      "Read a document's attributes: title, trash state, favorite state, journal date, primary mode (page/edgeless), tags (resolved to name/color), and custom properties (resolved to name/type/value). Does not include the document's body text - use doc_read for that.",
    inputSchema: z.object({
      doc_id: z.string().describe('The document to read attributes for'),
    }),
    execute: async ({ doc_id }) => {
      try {
        const result = await getProperties(doc_id);
        return isToolError(result) ? result : { ...result };
      } catch (err: any) {
        logger.error(`Failed to read properties of doc ${doc_id}`, err);
        return toolError(
          'Doc Properties Read Failed',
          err.message ?? String(err)
        );
      }
    },
  });
};
