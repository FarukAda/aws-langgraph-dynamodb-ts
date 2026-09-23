import { readFileSync } from 'node:fs';
import { relative, sep } from 'node:path';

import {
  findMessageWritePathBreaks,
  MESSAGE_PUT_OWNER,
  type ScannedFile,
} from './guards/message-write-path';
import { listSourceFiles, SRC_ROOT } from './guards/source-files';

const scan = (): ScannedFile[] =>
  listSourceFiles().map((path) => ({
    path: relative(SRC_ROOT, path).split(sep).join('/'),
    text: readFileSync(path, 'utf8'),
  }));

describe('findMessageWritePathBreaks', () => {
  it('flags a Put action built anywhere in history but the owning file', () => {
    const text = 'const a = { Put: { TableName: t, Item: i } };';
    expect(findMessageWritePathBreaks([{ path: 'history/actions/add.ts', text }])).toEqual([
      'history/actions/add.ts: builds a Put action',
    ]);
  });

  it('flags a hoisted action, whose value the key alone does not show', () => {
    const text = `const action = { TableName: t, Item: i };
const w = { Put: action };`;
    expect(findMessageWritePathBreaks([{ path: 'history/internal/x.ts', text }])).toEqual([
      'history/internal/x.ts: builds a Put action',
    ]);
  });

  it('flags a PutRequest, which reaches the table through batchWriteAll', () => {
    const text = 'const w = [{ PutRequest: { Item: i } }];';
    expect(findMessageWritePathBreaks([{ path: 'history/internal/x.ts', text }])).toEqual([
      'history/internal/x.ts: builds a PutRequest action',
    ]);
  });

  it('flags a direct .put call, which no transaction would carry', () => {
    expect(
      findMessageWritePathBreaks([{ path: 'history/internal/x.ts', text: 'await c.put(i);' }]),
    ).toEqual(['history/internal/x.ts: writes a row with .put']);
  });

  it('ignores a write action quoted in a comment or a string', () => {
    const quoted = '/** Built as Put: { Item } by the owner; never call c.put( here. */';
    const text = quoted + ' const doc = "see Put: { Item } elsewhere";';
    expect(findMessageWritePathBreaks([{ path: 'history/internal/x.ts', text }])).toEqual([]);
  });

  it('accepts the owning file and ignores the other adapters', () => {
    expect(
      findMessageWritePathBreaks([
        { path: MESSAGE_PUT_OWNER, text: 'const w = { Put: { TableName: t, Item: i } };' },
        { path: 'store/internal/item-write.ts', text: 'const w = { Put: { Item: i } }; c.put(i);' },
      ]),
    ).toEqual([]);
  });
});

describe('the chat-history write path', () => {
  /**
   * The session row's `writeId` is what `clear` pins on, and it is only
   * trustworthy while it changes exactly when a message row is added. That
   * holds because both go out in one transaction, built in one file. A unit
   * test on that file cannot see a future path added beside it; this can.
   */
  it('adds a message row only through the transaction that stamps the session write id', () => {
    expect(findMessageWritePathBreaks(scan())).toEqual([]);
  });
});
