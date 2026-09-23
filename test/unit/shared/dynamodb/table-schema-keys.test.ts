import {
  PARTITION_KEY_ATTRIBUTE,
  rowKeyOf,
  SORT_KEY_ATTRIBUTE,
} from '../../../../src/shared/dynamodb/table-schema';

describe('the key attributes', () => {
  it('are the two names every row of the shared table is keyed by', () => {
    expect([PARTITION_KEY_ATTRIBUTE, SORT_KEY_ATTRIBUTE]).toEqual(['PK', 'SK']);
  });
});

describe('rowKeyOf', () => {
  it("takes a row's key and leaves every other attribute behind", () => {
    expect(rowKeyOf({ PK: 'CHKPT#t', SK: 'META##c', v: 1, metadata: {} })).toEqual({
      PK: 'CHKPT#t',
      SK: 'META##c',
    });
  });
});
