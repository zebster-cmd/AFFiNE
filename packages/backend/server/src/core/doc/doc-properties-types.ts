/**
 * Shared types + storage-doc-id builders for the copilot doc-properties tools.
 *
 * Doc attributes live across three YJS docs (all in the same
 * `PgWorkspaceDocStorageAdapter`, addressed by their storage-level id):
 * - the workspace ROOT doc (id == workspaceId): `meta.pages[]` (title, trash,
 *   tags[]) and `meta.properties.tags.options` (tag definitions);
 * - `db$<ws>$docProperties`: one flat Y.Map row per doc (journal, primaryMode,
 *   `custom:<propertyId>` values — all stored as strings);
 * - `db$<ws>$docCustomPropertyInfo`: one flat Y.Map row per property definition.
 * Favorite state is per-user in `userdata$<userId>$<ws>$favorite`.
 */

/** Storage-level doc id of the workspace docProperties ORM doc. */
export function docPropertiesDocId(workspaceId: string): string {
  return `db$${workspaceId}$docProperties`;
}

/** Storage-level doc id of the workspace docCustomPropertyInfo ORM doc. */
export function docCustomPropertyInfoDocId(workspaceId: string): string {
  return `db$${workspaceId}$docCustomPropertyInfo`;
}

/**
 * Storage-level doc id of a user's favorites doc. Ordering is
 * userId → workspaceId → table (`userdata$<userId>$<workspaceId>$favorite`),
 * per the nbstore id-converter.
 */
export function favoriteDocId(userId: string, workspaceId: string): string {
  return `userdata$${userId}$${workspaceId}$favorite`;
}

/** Row-map name of a doc favorite entry inside the favorites doc. */
export function favoriteKey(docId: string): string {
  return `doc:${docId}`;
}

/** Reserved soft-delete flag used by the workspace ORM's YjsTableAdapter. */
export const ORM_DELETE_FLAG = '$$DELETED';

/**
 * User-creatable custom-property types (a subset of `WorkspacePropertyType`).
 * NOTE: `select`/`multi-select` are NOT here — those exist only inside
 * `affine:database` blocks (handled by the database tools).
 */
export const DOC_PROPERTY_TYPES = [
  'text',
  'number',
  'checkbox',
  'date',
  'tags',
] as const;
export type DocPropertyType = (typeof DOC_PROPERTY_TYPES)[number];

export function isDocPropertyType(value: string): value is DocPropertyType {
  return (DOC_PROPERTY_TYPES as readonly string[]).includes(value);
}

/** Primary mode of a doc. */
export type DocPrimaryMode = 'page' | 'edgeless';

/** A tag resolved from its id to its human-readable definition. */
export interface TagView {
  id: string;
  name: string;
  color?: string;
}

/** A custom property resolved from `custom:<id>` to name/type/value. */
export interface CustomPropertyView {
  id: string;
  name?: string;
  type?: string;
  value: string | null;
}

/** The aggregated attribute view returned by `doc_properties_read`. */
export interface DocPropertiesView {
  docId: string;
  title: string;
  trash: boolean;
  favorite: boolean;
  journal: string | null;
  primaryMode: DocPrimaryMode | null;
  tags: TagView[];
  properties: CustomPropertyView[];
}

/** A tag definition option as stored in `meta.properties.tags.options`. */
export interface TagOption {
  id: string;
  value: string;
  color?: string;
  parentId?: string;
}
