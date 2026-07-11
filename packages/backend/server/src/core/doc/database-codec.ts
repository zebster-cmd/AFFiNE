import { nanoid } from 'nanoid';
import * as Y from 'yjs';

import type { PropertyType } from './database-types';

/** A single select/multi-select option, as stored on `column.data.options`. */
export interface StoredOption {
  id: string;
  value: string;
  color?: string;
}

/**
 * The in-doc column object, i.e. one entry of the database block's
 * `prop:columns` array (see `buildBoardDoc` in
 * `src/__tests__/copilot/fixtures/database-doc.ts` for the exact shape
 * written by the doc builder).
 */
export interface StoredColumn {
  id: string;
  type: PropertyType;
  name: string;
  data: { options?: StoredOption[] } & Record<string, unknown>;
}

/**
 * Thrown by {@link encodeCell} for property types that cannot be written
 * through a cell value: `title` (written via the row's child block's
 * `prop:text` instead) and the read-only `created-time`/`updated-time`
 * projections.
 */
export class CodecError extends Error {
  constructor(
    message: string,
    readonly type: PropertyType
  ) {
    super(message);
    this.name = 'CodecError';
  }
}

const READ_ONLY_TYPES: ReadonlySet<PropertyType> = new Set<PropertyType>([
  'title',
  'created-time',
  'updated-time',
]);

/** Property types whose value `encodeCell` refuses to write. */
export function isReadOnlyType(type: PropertyType): boolean {
  return READ_ONLY_TYPES.has(type);
}

/**
 * Colors assigned (round-robin, by current option count) to auto-created
 * select/multi-select options. Mirrors the editor's default option color
 * order — `selectOptionColors` in
 * `blocksuite/affine/data-view/src/core/component/tags/colors.ts` — collapsed
 * to plain color names since the backend has no CSS var resolution.
 */
const OPTION_COLOR_PALETTE = [
  'red',
  'magenta',
  'orange',
  'yellow',
  'green',
  'teal',
  'blue',
  'purple',
  'grey',
  'white',
] as const;

function pickColor(existingCount: number): string {
  return OPTION_COLOR_PALETTE[existingCount % OPTION_COLOR_PALETTE.length];
}

/**
 * Looks up an option on `column.data.options` by value (case-insensitive),
 * auto-creating (and mutating `column.data.options`) when absent. Returns
 * the option's id either way.
 */
function resolveOption(column: StoredColumn, value: string): string {
  const options = (column.data.options ??= []);
  const existing = options.find(
    option => option.value.toLowerCase() === value.toLowerCase()
  );
  if (existing) {
    return existing.id;
  }

  const created: StoredOption = {
    id: nanoid(),
    value,
    color: pickColor(options.length),
  };
  options.push(created);
  return created.id;
}

/** Reverse lookup: option id -> label, falling back to the raw id if unknown. */
function optionLabel(column: StoredColumn, id: string): string {
  const options = column.data.options ?? [];
  return options.find(option => option.id === id)?.value ?? id;
}

interface Codec {
  encode(column: StoredColumn, modelValue: unknown, ydoc: Y.Doc): unknown;
  decode(column: StoredColumn, stored: unknown): unknown;
}

function readOnlyCodec(type: PropertyType): Codec {
  return {
    encode: () => {
      throw new CodecError(
        `Property type "${type}" is read-only and cannot be written via encodeCell.`,
        type
      );
    },
    decode: stored => stored,
  };
}

const textCodec: Codec = {
  encode: (_column, modelValue) => new Y.Text(String(modelValue ?? '')),
  decode: (_column, stored) =>
    stored instanceof Y.Text ? stored.toString() : String(stored ?? ''),
};

const selectCodec: Codec = {
  encode: (column, modelValue) => resolveOption(column, String(modelValue)),
  decode: (column, stored) =>
    typeof stored === 'string' ? optionLabel(column, stored) : null,
};

const multiSelectCodec: Codec = {
  encode: (column, modelValue) => {
    const values = Array.isArray(modelValue) ? modelValue : [modelValue];
    return values.map(value => resolveOption(column, String(value)));
  },
  decode: (column, stored) => {
    const ids = Array.isArray(stored) ? stored : [];
    return ids.map(id => optionLabel(column, String(id)));
  },
};

const numberCodec: Codec = {
  encode: (_column, modelValue) => Number(modelValue),
  decode: (_column, stored) => Number(stored),
};

const checkboxCodec: Codec = {
  encode: (_column, modelValue) => Boolean(modelValue),
  decode: (_column, stored) => Boolean(stored),
};

const dateCodec: Codec = {
  encode: (_column, modelValue) => Number(modelValue),
  decode: (_column, stored) => Number(stored),
};

const linkCodec: Codec = {
  encode: (_column, modelValue) => String(modelValue ?? ''),
  decode: (_column, stored) => String(stored ?? ''),
};

/** `Record<PropertyType, Codec>` — one encode/decode pair per supported property type. */
const CELL_CODECS: Record<PropertyType, Codec> = {
  title: readOnlyCodec('title'),
  'rich-text': textCodec,
  text: textCodec,
  select: selectCodec,
  'multi-select': multiSelectCodec,
  number: numberCodec,
  progress: numberCodec,
  checkbox: checkboxCodec,
  date: dateCodec,
  link: linkCodec,
  'created-time': readOnlyCodec('created-time'),
  'updated-time': readOnlyCodec('updated-time'),
};

/**
 * Encodes a model-facing value (string/number/boolean/string[]) into the
 * in-doc stored form for `column`'s property type. `select`/`multi-select`
 * auto-create missing options on `column.data.options` (mutating it) and
 * return the resulting option id(s). Throws {@link CodecError} for
 * `title`/`created-time`/`updated-time` (see {@link isReadOnlyType}).
 *
 * `ydoc` is accepted so callers can bind a `Y.Text` to the right doc if
 * needed; scalar codecs ignore it.
 */
export function encodeCell(
  column: StoredColumn,
  modelValue: unknown,
  ydoc: Y.Doc
): unknown {
  return CELL_CODECS[column.type].encode(column, modelValue, ydoc);
}

/** Decodes an in-doc stored cell value back into its model-facing form. */
export function decodeCell(column: StoredColumn, stored: unknown): unknown {
  return CELL_CODECS[column.type].decode(column, stored);
}
