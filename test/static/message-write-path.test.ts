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
    expect(
      findMessageWritePathBreaks([{ path: 'history/actions/add.ts', text: '{ Put: { Item } }' }]),
    ).toEqual(['history/actions/add.ts: builds a Put action']);
  });

  it('flags a direct client.put, which no transaction would carry', () => {
    expect(
      findMessageWritePathBreaks([{ path: 'history/internal/x.ts', text: 'await client.put(i);' }]),
    ).toEqual(['history/internal/x.ts: writes a row with client.put']);
  });

  it('accepts the owning file and ignores the other adapters', () => {
    expect(
      findMessageWritePathBreaks([
        { path: MESSAGE_PUT_OWNER, text: '{ Put: { TableName, Item } }' },
        { path: 'store/internal/persist.ts', text: 'client.put({ Item }); { Put: { Item } }' },
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
