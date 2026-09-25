import type { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';
import { expectTypeOf } from 'expect-type';

import type { BaseAdapterOptions, BackfillOptions, DynamoDBDocumentLike } from '../../src/index';
import { CLIENT_MEMBERS } from '../../src/shared/validation/collaborators';
import { allKeysOf } from '../../src/shared/validation/option-shape';

/**
 * The structural type's members, exhaustive in both directions: `allKeysOf`
 * fails to compile if this list omits a method the type names or invents one
 * it does not. It exists so the assertion below can read the type at runtime
 * and hold it against the list the constructor actually enforces.
 */
const STRUCTURAL_MEMBERS = allKeysOf<DynamoDBDocumentLike>({
  batchWrite: 'batchWrite',
  delete: 'delete',
  get: 'get',
  put: 'put',
  query: 'query',
  scan: 'scan',
  transactWrite: 'transactWrite',
  update: 'update',
});

describe('the injected DocumentClient is typed by shape', () => {
  /**
   * Two lists in two files meaning the same thing is the drift this guard
   * exists for. A method added to one alone gives a client the compiler
   * accepts and the constructor rejects, or the reverse — either of which is
   * worse than the single rule both are trying to express.
   */
  it('names exactly the methods the constructor requires at runtime', () => {
    expect([...STRUCTURAL_MEMBERS].sort()).toEqual([...CLIENT_MEMBERS].sort());
  });

  it('accepts the SDK own document client and still refuses an empty object', () => {
    expectTypeOf<DynamoDBDocument>().toMatchTypeOf<DynamoDBDocumentLike>();
    expectTypeOf<Record<string, never>>().not.toMatchTypeOf<DynamoDBDocumentLike>();
    expectTypeOf<BaseAdapterOptions['client']>().toEqualTypeOf<DynamoDBDocumentLike | undefined>();
    expectTypeOf<BackfillOptions['client']>().toEqualTypeOf<DynamoDBDocumentLike>();
  });
});
