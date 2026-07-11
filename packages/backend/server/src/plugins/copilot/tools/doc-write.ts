import { Logger } from '@nestjs/common';
import { z } from 'zod';

import { DocWriter } from '../../../core/doc';
import { PermissionAccess } from '../../../core/permission';
import { toolError } from './error';
import { defineTool } from './tool';
import type { CopilotChatOptions } from './types';

const logger = new Logger('DocWriteTool');

const stripLeadingH1 = (content: string) =>
  content.replace(/^[ \t]{0,3}#\s+[^\n]*#*\s*\n*/, '');

const sanitizeTitle = (title: string) => title.replace(/[\r\n]+/g, ' ').trim();

// The markdown<->doc engine rejects a whole document when it hits a block
// flavour (or nested children) it cannot round-trip — most notably
// `affine:database` (tables/kanban). Turn its terse error into a message the
// model can act on, instead of surfacing the raw "unsupported block flavour"
// string.
const describeWriteError = (message: string): string => {
  const flavour = message.match(
    /unsupported block flavour:\s*([^\s"']+)/i
  )?.[1];
  if (flavour) {
    const name = flavour.replace(/^affine:/, '');
    return `This document contains a "${name}" block that this tool cannot edit yet (database/kanban blocks and some rich blocks are unsupported), so the whole update was rejected. Ask the user to edit that block manually, or work in a document without one. (underlying: ${message})`;
  }
  if (/unsupported children on block/i.test(message)) {
    return `This document contains a block with nested rows/children this tool cannot edit yet (most commonly a database/kanban block), so the whole update was rejected. (underlying: ${message})`;
  }
  return message;
};

export const buildDocCreateHandler = (
  ac: PermissionAccess,
  writer: DocWriter
) => {
  return async (
    options: CopilotChatOptions,
    title: string,
    content: string
  ) => {
    if (!options?.user || !options.workspace) {
      return toolError(
        'Doc Create Failed',
        'Missing user or workspace context'
      );
    }

    await ac
      .user(options.user)
      .workspace(options.workspace)
      .assert('Workspace.CreateDoc');

    const sanitizedTitle = sanitizeTitle(title);
    if (!sanitizedTitle) {
      return toolError('Doc Create Failed', 'Title cannot be empty');
    }

    const strippedContent = stripLeadingH1(content);
    const result = await writer.createDoc(
      options.workspace,
      sanitizedTitle,
      strippedContent,
      options.user
    );

    return {
      success: true,
      docId: result.docId,
      message: `Document "${sanitizedTitle}" created successfully`,
    };
  };
};

export const buildDocUpdateHandler = (
  ac: PermissionAccess,
  writer: DocWriter
) => {
  return async (
    options: CopilotChatOptions,
    docId: string,
    content: string
  ) => {
    const notFound = toolError(
      'Doc Update Failed',
      `Doc with id ${docId} not found.`
    );

    if (!options?.user || !options.workspace) {
      return notFound;
    }

    const canAccess = await ac
      .user(options.user)
      .workspace(options.workspace)
      .doc(docId)
      .can('Doc.Update');

    if (!canAccess) {
      return notFound;
    }

    await writer.updateDoc(options.workspace, docId, content, options.user);

    return {
      success: true,
      docId,
      message: 'Document updated successfully',
    };
  };
};

export const buildDocUpdateMetaHandler = (
  ac: PermissionAccess,
  writer: DocWriter
) => {
  return async (options: CopilotChatOptions, docId: string, title: string) => {
    const notFound = toolError(
      'Doc Meta Update Failed',
      `Doc with id ${docId} not found.`
    );

    if (!options?.user || !options.workspace) {
      return notFound;
    }

    const canAccess = await ac
      .user(options.user)
      .workspace(options.workspace)
      .doc(docId)
      .can('Doc.Update');

    if (!canAccess) {
      return notFound;
    }

    const sanitizedTitle = sanitizeTitle(title);
    if (!sanitizedTitle) {
      return toolError('Doc Meta Update Failed', 'Title cannot be empty');
    }

    await writer.updateDocMeta(
      options.workspace,
      docId,
      { title: sanitizedTitle },
      options.user
    );

    return {
      success: true,
      docId,
      message: 'Document title updated successfully',
    };
  };
};

export const createDocCreateTool = (
  createDoc: (title: string, content: string) => Promise<object>
) => {
  return defineTool({
    description:
      'Create a new document in the workspace with the given title and markdown content. Returns the ID of the created document. Supported blocks: headings, paragraphs, lists, quotes, code blocks, dividers, callouts, bookmarks/embeds, and GitHub-style pipe tables (which become lightweight table blocks). NOT supported: database/kanban blocks and images — do not attempt to create them.',
    inputSchema: z.object({
      title: z.string().min(1).describe('The title of the new document'),
      content: z
        .string()
        .describe('The markdown content for the document body'),
    }),
    execute: async ({ title, content }) => {
      try {
        return await createDoc(title, content);
      } catch (err: any) {
        logger.error(`Failed to create document: ${title}`, err);
        return toolError('Doc Create Failed', describeWriteError(err.message));
      }
    },
  });
};

export const createDocUpdateTool = (
  updateDoc: (docId: string, content: string) => Promise<object>
) => {
  return defineTool({
    description:
      'Update an existing document body from new markdown content (body only). Uses structural diffing to apply minimal changes. Does NOT update the document title. Supported blocks are the same as document creation, including GitHub-style pipe tables. NOT supported: database/kanban blocks and images. Important: a document that already CONTAINS a database/kanban block cannot be updated at all — the update will be rejected — so avoid calling this on such documents.',
    inputSchema: z.object({
      doc_id: z.string().describe('The ID of the document to update'),
      content: z
        .string()
        .describe(
          'The complete new markdown content for the document body (do NOT include a title H1)'
        ),
    }),
    execute: async ({ doc_id, content }) => {
      try {
        return await updateDoc(doc_id, content);
      } catch (err: any) {
        logger.error(`Failed to update document: ${doc_id}`, err);
        return toolError('Doc Update Failed', describeWriteError(err.message));
      }
    },
  });
};

export const createDocUpdateMetaTool = (
  updateDocMeta: (docId: string, title: string) => Promise<object>
) => {
  return defineTool({
    description: 'Update document metadata (currently title only).',
    inputSchema: z.object({
      doc_id: z.string().describe('The ID of the document to update'),
      title: z.string().min(1).describe('The new document title'),
    }),
    execute: async ({ doc_id, title }) => {
      try {
        return await updateDocMeta(doc_id, title);
      } catch (err: any) {
        logger.error(`Failed to update document meta: ${doc_id}`, err);
        return toolError('Doc Meta Update Failed', err.message);
      }
    },
  });
};
