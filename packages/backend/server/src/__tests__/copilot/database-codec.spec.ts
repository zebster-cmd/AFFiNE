import test from 'ava';
import * as Y from 'yjs';

import {
  CodecError,
  decodeCell,
  encodeCell,
  isReadOnlyType,
  type StoredColumn,
} from '../../core/doc/database-codec';

function column(overrides: Partial<StoredColumn> = {}): StoredColumn {
  return {
    id: 'c1',
    type: 'text',
    name: 'Column',
    data: {},
    ...overrides,
  };
}

test('select encodeCell auto-creates a missing option and returns its id', t => {
  const col = column({ type: 'select', data: { options: [] } });
  const ydoc = new Y.Doc();

  const id = encodeCell(col, 'Todo', ydoc) as string;

  t.is(typeof id, 'string');
  t.is(col.data.options?.length, 1);
  t.is(col.data.options?.[0].value, 'Todo');
  t.is(col.data.options?.[0].id, id);
  t.truthy(col.data.options?.[0].color);
});

test('select encodeCell reuses an existing option matched case-insensitively', t => {
  const col = column({
    type: 'select',
    data: { options: [{ id: 'o_todo', value: 'Todo', color: 'red' }] },
  });
  const ydoc = new Y.Doc();

  const id = encodeCell(col, 'todo', ydoc) as string;

  t.is(id, 'o_todo');
  t.is(col.data.options?.length, 1);
});

test('multi-select encodeCell returns an array of option ids, auto-creating as needed', t => {
  const col = column({
    type: 'multi-select',
    data: { options: [{ id: 'o_a', value: 'A' }] },
  });
  const ydoc = new Y.Doc();

  const ids = encodeCell(col, ['A', 'B'], ydoc);

  t.deepEqual(ids, ['o_a', col.data.options?.[1]?.id]);
  t.is(col.data.options?.length, 2);
  t.is(col.data.options?.[1].value, 'B');
});

test('number encodeCell/decodeCell pass values through', t => {
  const col = column({ type: 'number' });
  const ydoc = new Y.Doc();

  t.is(encodeCell(col, 42, ydoc), 42);
  t.is(decodeCell(col, 42), 42);
});

test('progress encodeCell/decodeCell pass values through', t => {
  const col = column({ type: 'progress' });
  const ydoc = new Y.Doc();

  t.is(encodeCell(col, 75, ydoc), 75);
  t.is(decodeCell(col, 75), 75);
});

test('checkbox encodeCell coerces truthy/falsy values to boolean', t => {
  const col = column({ type: 'checkbox' });
  const ydoc = new Y.Doc();

  t.is(encodeCell(col, true, ydoc), true);
  t.is(encodeCell(col, 'yes', ydoc), true);
  t.is(encodeCell(col, 0, ydoc), false);
  t.is(decodeCell(col, true), true);
  t.is(decodeCell(col, false), false);
});

test('checkbox encodeCell parses boolean-like strings instead of trusting truthiness', t => {
  const col = column({ type: 'checkbox' });
  const ydoc = new Y.Doc();

  // The bare `Boolean('false')` is `true`; the codec must special-case these.
  t.is(encodeCell(col, 'false', ydoc), false);
  t.is(encodeCell(col, 'true', ydoc), true);
  t.is(encodeCell(col, '0', ydoc), false);
});

test('date encodeCell/decodeCell accept epoch-ms numbers', t => {
  const col = column({ type: 'date' });
  const ydoc = new Y.Doc();
  const epochMs = 1_700_000_000_000;

  t.is(encodeCell(col, epochMs, ydoc), epochMs);
  t.is(decodeCell(col, epochMs), epochMs);
});

test('link encodeCell/decodeCell pass strings through', t => {
  const col = column({ type: 'link' });
  const ydoc = new Y.Doc();

  t.is(encodeCell(col, 'https://affine.pro', ydoc), 'https://affine.pro');
  t.is(decodeCell(col, 'https://affine.pro'), 'https://affine.pro');
});

test('text encodeCell produces a Y.Text and decodeCell reverses it once integrated', t => {
  const col = column({ type: 'text' });
  const ydoc = new Y.Doc();

  const stored = encodeCell(col, 'hello world', ydoc);
  t.true(stored instanceof Y.Text);

  // A freshly-constructed Y.Text only holds real content once it is
  // integrated into a doc (e.g. set on a Y.Map), which is how the actual
  // writer uses the encoded value — mirror that here before reading it back.
  const scratch = ydoc.getMap('scratch');
  scratch.set('v', stored);

  t.is(decodeCell(col, scratch.get('v')), 'hello world');
});

test('rich-text encodeCell produces a Y.Text and decodeCell reverses it once integrated', t => {
  const col = column({ type: 'rich-text' });
  const ydoc = new Y.Doc();

  const stored = encodeCell(col, 'formatted text', ydoc);
  t.true(stored instanceof Y.Text);

  const scratch = ydoc.getMap('scratch');
  scratch.set('v', stored);

  t.is(decodeCell(col, scratch.get('v')), 'formatted text');
});

test('title encodeCell throws CodecError', t => {
  const col = column({ type: 'title' });
  const ydoc = new Y.Doc();

  const err = t.throws(() => encodeCell(col, 'My Title', ydoc), {
    instanceOf: CodecError,
  });
  t.truthy(err);
});

test('created-time encodeCell throws CodecError', t => {
  const col = column({ type: 'created-time' });
  const ydoc = new Y.Doc();

  t.throws(() => encodeCell(col, Date.now(), ydoc), {
    instanceOf: CodecError,
  });
});

test('updated-time encodeCell throws CodecError', t => {
  const col = column({ type: 'updated-time' });
  const ydoc = new Y.Doc();

  t.throws(() => encodeCell(col, Date.now(), ydoc), {
    instanceOf: CodecError,
  });
});

test('decodeCell on a read-only column returns the stored value unchanged', t => {
  const col = column({ type: 'created-time' });
  const epochMs = 1_700_000_000_000;

  // Read-only types only reject on encode; decode is an identity pass-through.
  t.is(decodeCell(col, epochMs), epochMs);
});

test('isReadOnlyType reports title/created-time/updated-time as read-only', t => {
  t.true(isReadOnlyType('title'));
  t.true(isReadOnlyType('created-time'));
  t.true(isReadOnlyType('updated-time'));
  t.false(isReadOnlyType('text'));
  t.false(isReadOnlyType('select'));
  t.false(isReadOnlyType('number'));
});

test('select decodeCell reverses encodeCell back to the option label', t => {
  const col = column({ type: 'select', data: { options: [] } });
  const ydoc = new Y.Doc();

  const id = encodeCell(col, 'In Progress', ydoc);

  t.is(decodeCell(col, id), 'In Progress');
});

test('select decodeCell returns the raw id when the option is not found', t => {
  const col = column({
    type: 'select',
    data: { options: [{ id: 'o_todo', value: 'Todo' }] },
  });

  // Documents the defensive fallback: an unknown/stale id decodes to itself.
  t.is(decodeCell(col, 'o_missing'), 'o_missing');
});

test('multi-select decodeCell reverses encodeCell back to option labels', t => {
  const col = column({ type: 'multi-select', data: { options: [] } });
  const ydoc = new Y.Doc();

  const ids = encodeCell(col, ['Alpha', 'Beta'], ydoc) as string[];

  t.deepEqual(decodeCell(col, ids), ['Alpha', 'Beta']);
});
