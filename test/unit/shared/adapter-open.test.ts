import { openAdapter } from '../../../src/shared/adapter';
import { SILENT_LOGGER } from '../../../src/shared/logging/logger';
import { fakeClientMethods } from '../../shared/helpers/ddb-mock';

describe('openAdapter', () => {
  it("runs the shared option checks, then the adapter's, then the collaborator checks", () => {
    const order: string[] = [];
    expect(() =>
      openAdapter({ tableName: '' }, 'store', { options: () => order.push('own') }),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION', context: { field: 'tableName' } }));
    expect(order).toEqual([]);

    openAdapter({ tableName: 'tbl', client: fakeClientMethods(), logger: SILENT_LOGGER }, 'store', {
      options: () => order.push('options'),
      collaborators: () => order.push('collaborators'),
    });
    expect(order).toEqual(['options', 'collaborators']);
  });

  it('fills the shared defaults and releases nothing it was handed', () => {
    const client = { ...fakeClientMethods(), destroy: jest.fn() };
    const shell = openAdapter({ tableName: 'tbl', client }, 'checkpointer');
    expect(shell.core).toMatchObject({
      tableName: 'tbl',
      client,
      indexShards: 8,
      readConcurrency: 8,
    });
    shell.release();
    expect(client.destroy).not.toHaveBeenCalled();
  });
});
