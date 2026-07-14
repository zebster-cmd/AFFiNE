import { Injectable, NotFoundException } from '@nestjs/common';
import { nanoid } from 'nanoid';
import * as Y from 'yjs';
import { z } from 'zod';

import {
  type PropertyDef,
  readPageMetaFromRoot,
  readPropertyDefs,
  readTagOptionsFromRoot,
} from './doc-properties-reader';
import {
  docCustomPropertyInfoDocId,
  type DocPrimaryMode,
  docPropertiesDocId,
  type DocPropertyType,
  favoriteDocId,
  favoriteKey,
  isDocPropertyType,
  ORM_DELETE_FLAG,
  type TagOption,
} from './doc-properties-types';
import { YjsDeltaWriter } from './yjs-delta';

/** Set `set_title`/`set_trash`. */
export interface SetTitleOp {
  op: 'set_title';
  title: string;
}
export interface SetTrashOp {
  op: 'set_trash';
  trash: boolean;
}
/** `docProperties` metadata ops. */
export interface SetJournalOp {
  op: 'set_journal';
  /** `YYYY-MM-DD`; `''` clears the journal date. */
  journal: string;
}
export interface SetModeOp {
  op: 'set_mode';
  mode: DocPrimaryMode;
}
/** Tag ops - `tag`/`property` accept a name (id fallback, see {@link findTagMatches}/{@link findPropertyMatches}). */
export interface AddTagOp {
  op: 'add_tag';
  tag: string;
}
export interface RemoveTagOp {
  op: 'remove_tag';
  tag: string;
}
export interface CreateTagOp {
  op: 'create_tag';
  name: string;
  color?: string;
}
/** Custom-property ops. `type` is a plain string so an unsupported type (e.g. `select`) reaches our own validation error rather than failing zod parsing. */
export interface SetPropertyOp {
  op: 'set_property';
  property: string;
  value: unknown;
}
export interface DefinePropertyOp {
  op: 'define_property';
  name: string;
  type: string;
  show?: string;
  index?: string;
}
/** Per-acting-user favorite toggle. */
export interface SetFavoriteOp {
  op: 'set_favorite';
  favorite: boolean;
}

/** The 10 mutation ops a `doc_properties_update` batch may contain. */
export type DocPropertyOp =
  | SetTitleOp
  | SetTrashOp
  | SetJournalOp
  | SetModeOp
  | AddTagOp
  | RemoveTagOp
  | CreateTagOp
  | SetPropertyOp
  | DefinePropertyOp
  | SetFavoriteOp;

const SetTitleOpSchema = z.object({
  op: z.literal('set_title'),
  title: z.string(),
});
const SetTrashOpSchema = z.object({
  op: z.literal('set_trash'),
  trash: z.boolean(),
});
const SetJournalOpSchema = z.object({
  op: z.literal('set_journal'),
  journal: z.string(),
});
const SetModeOpSchema = z.object({
  op: z.literal('set_mode'),
  mode: z.enum(['page', 'edgeless']),
});
const AddTagOpSchema = z.object({
  op: z.literal('add_tag'),
  tag: z.string(),
});
const RemoveTagOpSchema = z.object({
  op: z.literal('remove_tag'),
  tag: z.string(),
});
const CreateTagOpSchema = z.object({
  op: z.literal('create_tag'),
  name: z.string(),
  color: z.string().optional(),
});
const SetPropertyOpSchema = z.object({
  op: z.literal('set_property'),
  property: z.string(),
  value: z.unknown(),
});
const DefinePropertyOpSchema = z.object({
  op: z.literal('define_property'),
  name: z.string(),
  type: z.string(),
  show: z.string().optional(),
  index: z.string().optional(),
});
const SetFavoriteOpSchema = z.object({
  op: z.literal('set_favorite'),
  favorite: z.boolean(),
});

/** Zod schema for {@link DocPropertyOp}, used by the `doc_properties_update` tool input. */
export const DocPropertyOpSchema = z.discriminatedUnion('op', [
  SetTitleOpSchema,
  SetTrashOpSchema,
  SetJournalOpSchema,
  SetModeOpSchema,
  AddTagOpSchema,
  RemoveTagOpSchema,
  CreateTagOpSchema,
  SetPropertyOpSchema,
  DefinePropertyOpSchema,
  SetFavoriteOpSchema,
]);

/** Same string->boolean coercion as `database-codec.ts`'s `checkboxCodec`, kept local to avoid a cross-module dependency for one function. */
function coerceBoolean(value: unknown): boolean {
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    if (s === 'false' || s === '0' || s === 'no' || s === '') {
      return false;
    }
    if (s === 'true' || s === '1' || s === 'yes') {
      return true;
    }
  }
  return Boolean(value);
}

/**
 * Encodes/decodes `custom:<propertyId>` values, which `docProperties` always
 * persists as strings (mirroring the frontend ORM). `decode` is best-effort,
 * keyed off the property's declared {@link DocPropertyType}; unknown/missing
 * types fall back to returning the raw stored string.
 */
export const DocPropertiesCodec = {
  encode(type: DocPropertyType, value: unknown): string {
    switch (type) {
      case 'text':
        return String(value ?? '');
      case 'number':
        return String(Number(value));
      case 'checkbox':
        return String(coerceBoolean(value));
      case 'date':
        return String(value ?? '');
      case 'tags':
        return Array.isArray(value)
          ? value.map(v => String(v)).join(',')
          : String(value ?? '');
      default:
        return String(value ?? '');
    }
  },

  decode(type: DocPropertyType | undefined, stored: string): unknown {
    switch (type) {
      case 'number':
        return Number(stored);
      case 'checkbox':
        return stored === 'true';
      case 'tags':
        return stored === '' ? [] : stored.split(',');
      case 'text':
      case 'date':
      default:
        return stored;
    }
  },
};

/** Finds `docId`'s entry in the root doc's `meta.pages[]`, or `undefined`. */
function findPageEntry(doc: Y.Doc, docId: string): Y.Map<unknown> | undefined {
  const meta = doc.getMap('meta');
  const pages = meta.get('pages') as Y.Array<Y.Map<unknown>> | undefined;
  if (!pages) {
    return undefined;
  }
  return pages.toArray().find(page => page.get('id') === docId);
}

/**
 * Appends a new tag option to `meta.properties.tags.options`, handling both
 * observed shapes of that container (per the task brief): a real `Y.Array`
 * (push a fresh element - tracked incrementally by Yjs) or a plain JS array
 * (replace the whole array via `Y.Map.set`, since mutating a plain array
 * already inside a `Y.Map` in place would not be observed by the delta diff).
 */
function appendTagOption(doc: Y.Doc, option: TagOption): void {
  const meta = doc.getMap('meta');
  const properties = meta.get('properties') as Y.Map<unknown> | undefined;
  if (!properties) {
    throw new NotFoundException(
      'Workspace root doc has no meta.properties map'
    );
  }
  const tagsProp = properties.get('tags') as Y.Map<unknown> | undefined;
  if (!tagsProp) {
    throw new NotFoundException(
      'Workspace root doc has no meta.properties.tags map'
    );
  }
  const options = tagsProp.get('options');
  if (options instanceof Y.Array) {
    options.push([option]);
  } else {
    const existing = Array.isArray(options) ? options : [];
    tagsProp.set('options', [...existing, option]);
  }
}

/**
 * Resolves a tag reference (id or name) against the workspace's tag
 * definitions. An exact id match always wins (a single match); otherwise all
 * definitions whose `value` equals `ref` are returned, so callers can detect
 * zero/ambiguous matches.
 */
function findTagMatches(ref: string, options: TagOption[]): TagOption[] {
  const byId = options.find(option => option.id === ref);
  if (byId) {
    return [byId];
  }
  return options.filter(option => option.value === ref);
}

/** Same id-first, then-name resolution as {@link findTagMatches}, for custom-property definitions. */
function findPropertyMatches(
  ref: string,
  defs: Map<string, PropertyDef>
): PropertyDef[] {
  const byId = defs.get(ref);
  if (byId) {
    return [byId];
  }
  return [...defs.values()].filter(def => def.name === ref);
}

function describeTagCandidates(matches: TagOption[]): string {
  return matches
    .map(m => `${m.id}${m.color ? ` [${m.color}]` : ''}`)
    .join(', ');
}

function describePropertyCandidates(matches: PropertyDef[]): string {
  return matches.map(m => m.id).join(', ');
}

/**
 * Returns `page`'s `tags` field as a `Y.Array`, creating and attaching a
 * fresh empty one first if it's missing or not a `Y.Array` (legacy or
 * externally-created `meta.pages[]` entries may have no `tags` field at all -
 * mirrors the reader's tolerance of a missing tags array in
 * `readPageMetaFromRoot`).
 */
function ensureTagsArray(page: Y.Map<unknown>): Y.Array<string> {
  const existing = page.get('tags');
  if (existing instanceof Y.Array) {
    return existing as Y.Array<string>;
  }
  const tags = new Y.Array<string>();
  page.set('tags', tags);
  return tags;
}

/**
 * Picks an index for a newly favorited doc that sorts after every currently
 * favorited row, instead of a fixed constant (which collides whenever more
 * than one doc is favorited). This is a simple monotonic scheme, not true
 * fractional indexing - the `fractional-indexing` package isn't a dependency
 * of this package - but appending a suffix to the current maximum keeps
 * plain string comparison ordering correct.
 */
function nextFavoriteIndex(existingIndices: string[]): string {
  if (existingIndices.length === 0) {
    return 'a0';
  }
  const max = existingIndices.reduce((a, b) => (b > a ? b : a));
  return `${max}a`;
}

/**
 * Reads the `index` field of every non-deleted favorite row in a user's
 * favorites doc, for {@link nextFavoriteIndex}.
 */
function readFavoriteIndices(bin: Buffer | null): string[] {
  if (!bin) {
    return [];
  }
  const doc = new Y.Doc();
  Y.applyUpdate(doc, bin);
  const indices: string[] = [];
  for (const key of doc.share.keys()) {
    if (!key.startsWith('doc:')) {
      continue;
    }
    const row = doc.getMap(key).toJSON() as Record<string, unknown>;
    if (row[ORM_DELETE_FLAG] === true) {
      continue;
    }
    if (typeof row.index === 'string') {
      indices.push(row.index);
    }
  }
  return indices;
}

const ROOT_OPS = new Set<DocPropertyOp['op']>([
  'set_title',
  'set_trash',
  'add_tag',
  'remove_tag',
  'create_tag',
]);
const PAGE_OPS = new Set<DocPropertyOp['op']>([
  'set_title',
  'set_trash',
  'add_tag',
  'remove_tag',
]);
const INFO_OPS = new Set<DocPropertyOp['op']>([
  'define_property',
  'set_property',
]);

const JOURNAL_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Applies a `doc_properties_update` op batch to a doc's attributes, which
 * span four independent YJS docs (the workspace root, `docProperties`,
 * `docCustomPropertyInfo`, and the acting user's favorites doc). Mirrors
 * `DatabaseWriter`'s load/transact/encode-delta/push shape via
 * {@link YjsDeltaWriter}, but a single logical batch here may need to push
 * deltas to more than one doc.
 *
 * Atomicity: true cross-doc 2-phase commit isn't possible, so `applyOps`
 * resolves and validates every op up front (name->id resolution, existence
 * checks, type checks) BEFORE performing any write. Only once the whole batch
 * is known-valid does it group the resulting mutations by target doc and push
 * one delta per affected doc - giving the "no partial write on an invalid op"
 * guarantee the spec requires without needing real multi-doc transactions.
 */
@Injectable()
export class DocPropertiesWriter extends YjsDeltaWriter {
  async applyOps(
    workspaceId: string,
    docId: string,
    userId: string,
    ops: DocPropertyOp[],
    editorId?: string
  ): Promise<{
    applied: number;
    createdTagIds: string[];
    createdPropertyIds: string[];
  }> {
    const needsRoot = ops.some(op => ROOT_OPS.has(op.op));
    const needsPageCheck = ops.some(op => PAGE_OPS.has(op.op));
    const needsInfo = ops.some(op => INFO_OPS.has(op.op));
    const needsFavorite = ops.some(op => op.op === 'set_favorite');

    // `docProperties` is write-only here: set_journal/set_mode/set_property
    // never need to read existing content to validate or apply. The root doc
    // (tags/page), docCustomPropertyInfo (to resolve set_property's property
    // name), and the favorites doc (to pick a non-colliding index for a new
    // favorite, see `nextFavoriteIndex`) do need a read first.
    const [rootBin, infoBin, favoriteBin] = await Promise.all([
      needsRoot ? this.getBinary(workspaceId, workspaceId) : null,
      needsInfo
        ? this.getBinary(workspaceId, docCustomPropertyInfoDocId(workspaceId))
        : null,
      needsFavorite
        ? this.getBinary(workspaceId, favoriteDocId(userId, workspaceId))
        : null,
    ]);

    if (needsRoot && rootBin === null) {
      throw new NotFoundException(
        `Workspace root doc not found for workspace "${workspaceId}"`
      );
    }

    const pageMeta = needsRoot ? readPageMetaFromRoot(rootBin, docId) : null;
    if (needsPageCheck && !pageMeta) {
      throw new Error(`Doc "${docId}" not found in workspace root meta.pages`);
    }

    // Simulated (cloned) resolution state: mutated as create_tag/define_property
    // ops are validated, so a later op in the SAME batch can reference a tag/
    // property the batch itself just created, before anything is pushed.
    let tagOptions: TagOption[] = needsRoot
      ? [...readTagOptionsFromRoot(rootBin)]
      : [];
    const propertyDefs = new Map<string, PropertyDef>(
      needsInfo ? readPropertyDefs(infoBin) : []
    );
    const currentTagIds = new Set(pageMeta?.tagIds ?? []);
    // Simulated resolution state for set_favorite, mirroring tagOptions/
    // propertyDefs above: mutated as a batch's own set_favorite ops are
    // processed so each gets a distinct, ordering-correct index.
    let favoriteIndices: string[] = needsFavorite
      ? readFavoriteIndices(favoriteBin)
      : [];

    const createdTagIds: string[] = [];
    const createdPropertyIds: string[] = [];
    const rootMutators: Array<(doc: Y.Doc) => void> = [];
    const propsMutators: Array<(doc: Y.Doc) => void> = [];
    const infoMutators: Array<(doc: Y.Doc) => void> = [];
    const favoriteMutators: Array<(doc: Y.Doc) => void> = [];

    for (const op of ops) {
      switch (op.op) {
        case 'set_title': {
          const title = op.title;
          rootMutators.push(doc => {
            // Existence already guaranteed by the up-front `pageMeta` check
            // (`needsPageCheck`) above, before any mutator runs.
            const page = findPageEntry(doc, docId) as Y.Map<unknown>;
            page.set('title', title);
          });
          break;
        }

        case 'set_trash': {
          const trash = op.trash;
          rootMutators.push(doc => {
            // Existence already guaranteed by the up-front `pageMeta` check
            // (`needsPageCheck`) above, before any mutator runs.
            const page = findPageEntry(doc, docId) as Y.Map<unknown>;
            page.set('trash', trash);
          });
          break;
        }

        case 'set_journal': {
          if (op.journal !== '' && !JOURNAL_FORMAT.test(op.journal)) {
            throw new Error(
              `set_journal expects "YYYY-MM-DD" or "" to clear, got "${op.journal}"`
            );
          }
          const journal = op.journal;
          propsMutators.push(doc => {
            const row = doc.getMap(docId);
            if (!row.has('id')) {
              row.set('id', docId);
            }
            if (journal === '') {
              row.delete('journal');
            } else {
              row.set('journal', journal);
            }
          });
          break;
        }

        case 'set_mode': {
          const mode = op.mode;
          propsMutators.push(doc => {
            const row = doc.getMap(docId);
            if (!row.has('id')) {
              row.set('id', docId);
            }
            row.set('primaryMode', mode);
          });
          break;
        }

        case 'add_tag': {
          const matches = findTagMatches(op.tag, tagOptions);
          if (matches.length === 0) {
            throw new Error(
              `add_tag: no tag named "${op.tag}" exists; call create_tag first.`
            );
          }
          if (matches.length > 1) {
            throw new Error(
              `add_tag: tag name "${op.tag}" is ambiguous (${describeTagCandidates(matches)}); specify a tag id.`
            );
          }
          const tagId = matches[0].id;
          if (!currentTagIds.has(tagId)) {
            currentTagIds.add(tagId);
            rootMutators.push(doc => {
              // Existence already guaranteed by the up-front `pageMeta` check
              // (`needsPageCheck`) above, before any mutator runs.
              const page = findPageEntry(doc, docId) as Y.Map<unknown>;
              const tags = ensureTagsArray(page);
              if (!tags.toArray().includes(tagId)) {
                tags.push([tagId]);
              }
            });
          }
          break;
        }

        case 'remove_tag': {
          const matches = findTagMatches(op.tag, tagOptions);
          if (matches.length === 0) {
            throw new Error(`remove_tag: no tag named "${op.tag}" exists.`);
          }
          if (matches.length > 1) {
            throw new Error(
              `remove_tag: tag name "${op.tag}" is ambiguous (${describeTagCandidates(matches)}); specify a tag id.`
            );
          }
          const tagId = matches[0].id;
          if (!currentTagIds.has(tagId)) {
            throw new Error(
              `remove_tag: tag "${op.tag}" is not present on doc "${docId}".`
            );
          }
          currentTagIds.delete(tagId);
          rootMutators.push(doc => {
            // Existence already guaranteed by the up-front `pageMeta` check
            // (`needsPageCheck`) above, before any mutator runs.
            const page = findPageEntry(doc, docId) as Y.Map<unknown>;
            const tags = ensureTagsArray(page);
            const idx = tags.toArray().indexOf(tagId);
            if (idx !== -1) {
              tags.delete(idx, 1);
            }
          });
          break;
        }

        case 'create_tag': {
          if (tagOptions.some(option => option.value === op.name)) {
            throw new Error(
              `create_tag: a tag named "${op.name}" already exists.`
            );
          }
          const newTag: TagOption = {
            id: nanoid(),
            value: op.name,
            color: op.color ?? 'grey',
          };
          tagOptions = [...tagOptions, newTag];
          createdTagIds.push(newTag.id);
          rootMutators.push(doc => appendTagOption(doc, newTag));
          break;
        }

        case 'set_property': {
          const matches = findPropertyMatches(op.property, propertyDefs);
          if (matches.length === 0) {
            throw new Error(
              `set_property: no property named "${op.property}" exists; call define_property first.`
            );
          }
          if (matches.length > 1) {
            throw new Error(
              `set_property: property name "${op.property}" is ambiguous (${describePropertyCandidates(matches)}); specify a property id.`
            );
          }
          const def = matches[0];
          if (!def.type || !isDocPropertyType(def.type)) {
            throw new Error(
              `set_property: property "${op.property}" has unsupported type "${def.type}".`
            );
          }
          const type = def.type;
          const propertyId = def.id;
          const encoded = DocPropertiesCodec.encode(type, op.value);
          propsMutators.push(doc => {
            const row = doc.getMap(docId);
            if (!row.has('id')) {
              row.set('id', docId);
            }
            row.set(`custom:${propertyId}`, encoded);
          });
          break;
        }

        case 'define_property': {
          if (!isDocPropertyType(op.type)) {
            throw new Error(
              `define_property: unsupported property type "${op.type}"; select/multi-select only exist inside database blocks.`
            );
          }
          if ([...propertyDefs.values()].some(def => def.name === op.name)) {
            throw new Error(
              `define_property: a property named "${op.name}" already exists.`
            );
          }
          const newId = nanoid();
          const type = op.type;
          const name = op.name;
          const show = op.show ?? 'always-hide';
          const index = op.index ?? 'a0';
          propertyDefs.set(newId, { id: newId, name, type });
          createdPropertyIds.push(newId);
          infoMutators.push(doc => {
            const row = doc.getMap(newId);
            row.set('id', newId);
            row.set('name', name);
            row.set('type', type);
            row.set('show', show);
            row.set('index', index);
          });
          break;
        }

        case 'set_favorite': {
          const favorite = op.favorite;
          // Resolved now (not inside the mutator) so it reflects this batch's
          // own prior set_favorite ops too, same as tagOptions/propertyDefs.
          // Only computed (and non-null) when favoriting; unused otherwise.
          let newIndex: string | null = null;
          if (favorite) {
            newIndex = nextFavoriteIndex(favoriteIndices);
            favoriteIndices = [...favoriteIndices, newIndex];
          }
          favoriteMutators.push(doc => {
            const key = favoriteKey(docId);
            const row = doc.getMap(key);
            if (favorite) {
              if (row.has(ORM_DELETE_FLAG)) {
                row.delete(ORM_DELETE_FLAG);
              }
              row.set('key', key);
              row.set('index', newIndex as string);
            } else {
              // Mirror the ORM's soft-delete: clear every non-key field, then
              // flag the row deleted - readFavorite() then reports `false`.
              // (Y.Map's `keys()` iterator is backed by a live JS Map, so
              // deleting the current entry mid-iteration is safe and still
              // visits every other key - verified empirically.)
              for (const field of row.keys()) {
                if (field !== 'key') {
                  row.delete(field);
                }
              }
              row.set('key', key);
              row.set(ORM_DELETE_FLAG, true);
            }
          });
          break;
        }

        default: {
          // Exhaustive: all 10 DocPropertyOp variants are handled above. This
          // branch only fires if a future op is added to the union without a
          // matching case.
          const unknownOp = op as DocPropertyOp;
          throw new Error(
            `Doc-properties op "${unknownOp.op}" is not yet implemented`
          );
        }
      }
    }

    // Everything validated - now, and only now, push one delta per affected doc.
    if (rootMutators.length) {
      await this.applyAndPush(
        workspaceId,
        workspaceId,
        doc => {
          for (const mutate of rootMutators) {
            mutate(doc);
          }
        },
        { editorId }
      );
    }
    if (propsMutators.length) {
      await this.applyAndPush(
        workspaceId,
        docPropertiesDocId(workspaceId),
        doc => {
          for (const mutate of propsMutators) {
            mutate(doc);
          }
        },
        { editorId, allowMissing: true }
      );
    }
    if (infoMutators.length) {
      await this.applyAndPush(
        workspaceId,
        docCustomPropertyInfoDocId(workspaceId),
        doc => {
          for (const mutate of infoMutators) {
            mutate(doc);
          }
        },
        { editorId, allowMissing: true }
      );
    }
    if (favoriteMutators.length) {
      await this.applyAndPush(
        workspaceId,
        favoriteDocId(userId, workspaceId),
        doc => {
          for (const mutate of favoriteMutators) {
            mutate(doc);
          }
        },
        { editorId, allowMissing: true }
      );
    }

    return {
      applied: ops.length,
      createdTagIds,
      createdPropertyIds,
    };
  }
}
