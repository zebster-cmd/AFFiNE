import test from 'ava';

import {
  readDocPropertiesRow,
  readFavorite,
  readPageMetaFromRoot,
  readPropertyDefs,
  readTagOptionsFromRoot,
  resolveCustomProperties,
  resolveTags,
} from '../../core/doc/doc-properties-reader';
import {
  buildCustomPropertyInfoDoc,
  buildDocPropertiesDoc,
  buildFavoriteDoc,
  buildRootDoc,
} from './fixtures/doc-properties-doc';

const DOC = 'doc-1';

// 2.1 — tags resolved (ids → name + color) from the root doc
test('reads a doc title/trash and resolves its tag ids to name + color', t => {
  const root = buildRootDoc({
    pages: [{ id: DOC, title: 'My Doc', trash: false, tags: ['t1', 't2'] }],
    tagOptions: [
      { id: 't1', value: 'Urgent', color: 'red' },
      { id: 't2', value: 'Work', color: 'blue' },
      { id: 't3', value: 'Unused', color: 'grey' },
    ],
  });

  const page = readPageMetaFromRoot(root, DOC);
  t.truthy(page);
  t.is(page?.title, 'My Doc');
  t.is(page?.trash, false);

  const tags = resolveTags(page!.tagIds, readTagOptionsFromRoot(root));
  t.deepEqual(tags, [
    { id: 't1', name: 'Urgent', color: 'red' },
    { id: 't2', name: 'Work', color: 'blue' },
  ]);
});

test('returns null page meta for an unknown doc id', t => {
  const root = buildRootDoc({ pages: [{ id: DOC, title: 'X' }] });
  t.is(readPageMetaFromRoot(root, 'nope'), null);
});

test('an unresolved tag id falls back to the id as its name', t => {
  const root = buildRootDoc({
    pages: [{ id: DOC, tags: ['ghost'] }],
    tagOptions: [],
  });
  const tags = resolveTags(
    readPageMetaFromRoot(root, DOC)!.tagIds,
    readTagOptionsFromRoot(root)
  );
  t.deepEqual(tags, [{ id: 'ghost', name: 'ghost' }]);
});

// 2.2 — journal/mode/custom values from docProperties, resolved via defs
test('reads journal, primaryMode, and custom values resolved to name/type', t => {
  const props = buildDocPropertiesDoc({
    [DOC]: {
      journal: '2026-07-14',
      primaryMode: 'edgeless',
      custom: { p1: 'hello', p2: '42' },
    },
  });
  const info = buildCustomPropertyInfoDoc([
    { id: 'p1', name: 'Summary', type: 'text' },
    { id: 'p2', name: 'Priority', type: 'number' },
  ]);

  const row = readDocPropertiesRow(props, DOC);
  t.is(row.journal, '2026-07-14');
  t.is(row.primaryMode, 'edgeless');

  const resolved = resolveCustomProperties(row.custom, readPropertyDefs(info));
  t.deepEqual(resolved, [
    { id: 'p1', name: 'Summary', type: 'text', value: 'hello' },
    { id: 'p2', name: 'Priority', type: 'number', value: '42' },
  ]);
});

test('missing docProperties row yields empty journal/mode/custom', t => {
  const props = buildDocPropertiesDoc({
    'other-doc': { journal: '2026-01-01' },
  });
  const row = readDocPropertiesRow(props, DOC);
  t.is(row.journal, null);
  t.is(row.primaryMode, null);
  t.deepEqual(row.custom, {});
});

test('soft-deleted property definitions are excluded', t => {
  const info = buildCustomPropertyInfoDoc([
    { id: 'p1', name: 'Kept', type: 'text' },
  ]);
  const defs = readPropertyDefs(info);
  t.true(defs.has('p1'));
  t.is(defs.get('p1')?.name, 'Kept');
});

// 2.3 — favorite state from the userspace doc
test('reads favorite state from the per-user favorites doc', t => {
  const fav = buildFavoriteDoc([{ docId: DOC, index: 'a0' }]);
  t.true(readFavorite(fav, DOC));
  t.false(readFavorite(fav, 'other-doc'));
  t.false(readFavorite(null, DOC));
});
