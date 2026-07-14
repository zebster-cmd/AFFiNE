import { Logger } from '@nestjs/common';
import { z } from 'zod';

import type { DocLinksView } from '../../../core/doc/doc-links-reader';
import { DocLinksReader } from '../../../core/doc/doc-links-reader';
import { PermissionAccess } from '../../../core/permission';
import { type ToolError, toolError } from './error';
import { defineTool } from './tool';
import type { CopilotChatOptions } from './types';

const logger = new Logger('DocLinksReadTool');

const isToolError = (result: ToolError | object): result is ToolError =>
  'type' in result && result.type === 'error';

export const buildDocLinksReadHandler = (
  ac: PermissionAccess,
  reader: DocLinksReader
) => {
  return async (
    options: CopilotChatOptions,
    docId: string
  ): Promise<ToolError | DocLinksView> => {
    if (!options?.user || !options.workspace) {
      return toolError(
        'Doc Links Read Failed',
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
        'Doc Links Read Failed',
        `You do not have permission to read document ${docId} in this workspace.`
      );
    }

    return reader.read(options.workspace, docId);
  };
};

type DocLinksReadToolResult = Awaited<
  ReturnType<ReturnType<typeof buildDocLinksReadHandler>>
>;

export const createDocLinksReadTool = (
  getLinks: (docId: string) => Promise<DocLinksReadToolResult>
) => {
  return defineTool({
    description:
      "Read a document's links: outgoing (documents this document references, either as an embed or an inline mention) and backlinks (documents elsewhere in the workspace that reference this document). Each entry includes the other document's id, the block carrying the reference, and its best-effort resolved title.",
    inputSchema: z.object({
      doc_id: z.string().describe('The document to read links for'),
    }),
    execute: async ({ doc_id }) => {
      try {
        const result = await getLinks(doc_id);
        return isToolError(result) ? result : { ...result };
      } catch (err: any) {
        logger.error(`Failed to read links of doc ${doc_id}`, err);
        return toolError('Doc Links Read Failed', err.message ?? String(err));
      }
    },
  });
};
