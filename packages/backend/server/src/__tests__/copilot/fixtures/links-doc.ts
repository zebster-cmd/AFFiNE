import * as Y from 'yjs';

/** Fixed id of the `affine:page` block built by {@link buildLinksDoc}. */
export const DEFAULT_PAGE_BLOCK_ID = 'page';
/** Fixed id of the `affine:note` block built by {@link buildLinksDoc}. */
export const DEFAULT_NOTE_BLOCK_ID = 'note';

/** One `affine:paragraph` child block of {@link buildLinksDoc}'s note. */
export interface ParagraphFixture {
  id: string;
  text?: string;
  /**
   * If set, an inline `@`-reference space-delta
   * (`{ reference: { type: 'LinkedPage', pageId } }`) is appended to the end
   * of this paragraph's `prop:text`, mirroring the real BlockSuite inline
   * reference shape (see the change's design.md Decision 5).
   */
  reference?: { pageId: string };
}

/** One `affine:embed-linked-doc` child block of {@link buildLinksDoc}'s note. */
export interface EmbedLinkFixture {
  id: string;
  pageId: string;
}

export interface BuildLinksDocSpec {
  paragraphs?: ParagraphFixture[];
  embeds?: EmbedLinkFixture[];
}

/**
 * Builds a deterministic `Y.Doc` binary containing
 * `affine:page` -> `affine:note` -> (`affine:paragraph`* + `affine:embed-linked-doc`*),
 * for testing `DocLinksReader`/`DocLinksWriter`. All ids are taken verbatim
 * from `spec` - nothing is randomly generated - mirroring
 * `buildBoardDoc` (`fixtures/database-doc.ts`).
 */
export function buildLinksDoc(spec: BuildLinksDocSpec = {}): Uint8Array {
  const doc = new Y.Doc();
  const blocks = doc.getMap('blocks');
  const paragraphs = spec.paragraphs ?? [];
  const embeds = spec.embeds ?? [];

  doc.transact(() => {
    // affine:page
    const page = new Y.Map<unknown>();
    page.set('sys:id', DEFAULT_PAGE_BLOCK_ID);
    page.set('sys:flavour', 'affine:page');
    page.set('sys:version', 1);
    const pageChildren = new Y.Array<string>();
    pageChildren.push([DEFAULT_NOTE_BLOCK_ID]);
    page.set('sys:children', pageChildren);
    blocks.set(DEFAULT_PAGE_BLOCK_ID, page);

    // affine:note
    const note = new Y.Map<unknown>();
    note.set('sys:id', DEFAULT_NOTE_BLOCK_ID);
    note.set('sys:flavour', 'affine:note');
    note.set('sys:version', 1);
    const noteChildren = new Y.Array<string>();
    noteChildren.push([...paragraphs.map(p => p.id), ...embeds.map(e => e.id)]);
    note.set('sys:children', noteChildren);
    blocks.set(DEFAULT_NOTE_BLOCK_ID, note);

    // affine:paragraph children
    for (const paragraph of paragraphs) {
      const block = new Y.Map<unknown>();
      block.set('sys:id', paragraph.id);
      block.set('sys:flavour', 'affine:paragraph');
      block.set('sys:version', 1);
      block.set('sys:children', new Y.Array<string>());
      const ytext = new Y.Text(paragraph.text ?? '');
      // Attach the block (and therefore `ytext`) to the doc BEFORE inserting
      // the formatted `{ reference }` delta below - Yjs only supports
      // attribute-carrying inserts on a `Y.Text` that's already integrated
      // into a document (a still-"preliminary" `Y.Text` silently encodes the
      // format wrong, corrupting the resulting binary).
      block.set('prop:text', ytext);
      blocks.set(paragraph.id, block);
      if (paragraph.reference) {
        ytext.insert(ytext.length, ' ', {
          reference: {
            type: 'LinkedPage',
            pageId: paragraph.reference.pageId,
          },
        });
      }
    }

    // affine:embed-linked-doc children
    for (const embed of embeds) {
      const block = new Y.Map<unknown>();
      block.set('sys:id', embed.id);
      block.set('sys:flavour', 'affine:embed-linked-doc');
      block.set('sys:version', 1);
      block.set('sys:children', new Y.Array<string>());
      block.set('prop:pageId', embed.pageId);
      block.set('prop:style', 'vertical');
      block.set('prop:caption', null);
      block.set('prop:title', null);
      block.set('prop:description', null);
      block.set('prop:footnoteIdentifier', null);
      blocks.set(embed.id, block);
    }
  });

  return Y.encodeStateAsUpdate(doc);
}
