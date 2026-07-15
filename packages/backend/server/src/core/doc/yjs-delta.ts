import { Logger, NotFoundException } from '@nestjs/common';
import * as Y from 'yjs';

import { EventBus } from '../../base';
import { PgWorkspaceDocStorageAdapter } from './adapters/workspace';

/** Normalize a stored binary (Buffer or view) into a Buffer. */
export function toBuffer(bin: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(bin)
    ? bin
    : Buffer.from(bin.buffer, bin.byteOffset, bin.byteLength);
}

/**
 * Load `bin` into a fresh `Y.Doc`, capture its state vector, run `mutate`
 * inside a single `doc.transact`, and return ONLY the delta
 * (`Y.encodeStateAsUpdate(doc, beforeSV)`), mirroring
 * {@link DatabaseWriter}'s `applyToBinary` but without any block-flavour
 * assumption so it works for the workspace root doc, the ORM db docs, the
 * userspace favorites doc, and a doc's own content.
 *
 * A `null`/empty `bin` yields a fresh doc (used when a doc — e.g. a user's
 * favorites doc — does not exist yet); the delta is then the full state.
 *
 * CAVEAT (same as DatabaseWriter): mutating a plain JS object already inside a
 * `Y.Array` in place is not observed by the state-vector diff. Replace array
 * elements (`arr.delete(i, 1); arr.insert(i, [next])`) instead of editing in
 * place.
 */
export function applyYDocDelta(
  bin: Buffer | Uint8Array | null | undefined,
  mutate: (doc: Y.Doc) => void
): Uint8Array {
  const doc = new Y.Doc();
  if (bin && bin.byteLength > 0) {
    Y.applyUpdate(doc, toBuffer(bin));
  }
  const before = Y.encodeStateVector(doc);
  doc.transact(() => {
    mutate(doc);
  });
  return Y.encodeStateAsUpdate(doc, before);
}

/**
 * Shared base for server-side YJS-direct writers. Provides the load →
 * transact → encode-delta → push-delta → emit pipeline used by
 * {@link DocPropertiesWriter} and {@link DocLinksWriter}, mirroring the
 * concurrency-safe pattern of {@link DatabaseWriter} (delta against the
 * pre-mutation state vector; never overwrite the whole doc).
 */
export abstract class YjsDeltaWriter {
  protected readonly logger = new Logger(this.constructor.name);

  constructor(
    protected readonly storage: PgWorkspaceDocStorageAdapter,
    protected readonly event: EventBus
  ) {}

  /** Fetch a doc's current binary, or `null` if it does not exist yet. */
  protected async getBinary(
    workspaceId: string,
    docId: string
  ): Promise<Buffer | null> {
    const rec = await this.storage.getDoc(workspaceId, docId);
    if (!rec?.bin) {
      return null;
    }
    return toBuffer(rec.bin);
  }

  /**
   * Load `docId`, apply `mutate` in one transaction, and push only the delta.
   * When `allowMissing` is set (e.g. a user's not-yet-created favorites doc), a
   * missing doc starts from a fresh `Y.Doc` instead of throwing.
   */
  protected async applyAndPush(
    workspaceId: string,
    docId: string,
    mutate: (doc: Y.Doc) => void,
    opts: { editorId?: string; allowMissing?: boolean } = {}
  ): Promise<void> {
    const bin = await this.getBinary(workspaceId, docId);
    if (bin === null && !opts.allowMissing) {
      throw new NotFoundException(`Document ${docId} not found`);
    }

    const delta = applyYDocDelta(bin, mutate);
    const timestamp = await this.storage.pushDocUpdates(
      workspaceId,
      docId,
      [delta],
      opts.editorId
    );
    this.event.emit('doc.updates.pushed', {
      spaceType: 'workspace',
      spaceId: workspaceId,
      docId,
      updates: [delta],
      timestamp,
      editor: opts.editorId,
    });
  }
}
