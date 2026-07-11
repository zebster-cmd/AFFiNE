import test from 'ava';
import * as Y from 'yjs';

import { buildBoardDoc } from './fixtures/database-doc';

test('buildBoardDoc produces a doc with a database block and its rows as children', t => {
  const bin = buildBoardDoc({
    title: 'Tasks',
    columns: [
      { id: 'c_title', name: 'Title', type: 'title' },
      {
        id: 'c_status',
        name: 'Status',
        type: 'select',
        options: [{ id: 'o_todo', value: 'Todo' }],
      },
    ],
    rows: [{ rowId: 'r1', title: 'First', cells: { c_status: 'o_todo' } }],
    views: [{ id: 'v1', name: 'Table', mode: 'table' }],
  });
  const doc = new Y.Doc();
  Y.applyUpdate(doc, bin);
  const blocks = doc.getMap('blocks');
  const dbId = [...blocks.keys()].find(
    id =>
      (blocks.get(id) as Y.Map<any>).get('sys:flavour') === 'affine:database'
  );
  t.truthy(dbId);
  const db = blocks.get(dbId!) as Y.Map<any>;
  t.deepEqual((db.get('sys:children') as Y.Array<string>).toArray(), ['r1']);
  const cells = db.get('prop:cells') as Y.Map<any>;
  t.is((cells.get('r1') as Y.Map<any>).get('c_status').get('value'), 'o_todo');
});
