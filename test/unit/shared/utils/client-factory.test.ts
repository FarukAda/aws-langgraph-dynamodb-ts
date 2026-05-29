/**
 * Unit tests for src/shared/utils/client-factory.ts (resolveDynamoDBClient).
 *
 * Real source surface:
 *   resolveDynamoDBClient(options: { client?: DynamoDBDocument; clientConfig?: DynamoDBClientConfig })
 *     -> { ddbClient: DynamoDBClient | undefined; client: DynamoDBDocument; ownsClient: boolean }
 *   - options.client provided  -> { ddbClient: undefined, client, ownsClient: false }
 *   - else                     -> new DynamoDBClient(clientConfig || {}), ownsClient: true
 *
 * Seam (REQ-46 / AC-38): an injectable `createClient?: (cfg) => DynamoDBClient`
 * defaulting to `new DynamoDBClient`. The `createClient`-bearing cases depend on
 * the not-yet-added seam and are EXPECTED to fail to compile until it lands;
 * that is the intended test-author state. The default-construction and
 * ownsClient assertions reference the current real surface and must pass.
 *
 * Also hosts the strict-mock self-test (AC-2) and the strict-assertion-helper
 * self-test (AC-4) per the plan table.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

import { resolveDynamoDBClient } from '../../../../src/shared/utils/client-factory';
import {
  expectExactUpdateCommand,
  expectExactGetCommand,
} from '../../../shared/helpers/strict-ddb-assertions';
import {
  createStrictDdbMock,
  STRICT_REJECT_SENTINEL,
  type StrictDdbMock,
} from '../../../shared/mocks/dynamodb';

describe('client-factory: resolveDynamoDBClient', () => {
  it('builds and owns a DynamoDBClient/DynamoDBDocument when only clientConfig is given', () => {
    const resolved = resolveDynamoDBClient({ clientConfig: { region: 'eu-west-1' } });

    expect(resolved.ownsClient).toBe(true);
    expect(resolved.ddbClient).toBeInstanceOf(DynamoDBClient);
    expect(resolved.client).toBeInstanceOf(DynamoDBDocument);
  }); // AC-38

  it('builds and owns a client when called with no options at all (default empty config branch)', () => {
    const resolved = resolveDynamoDBClient({});

    expect(resolved.ownsClient).toBe(true);
    expect(resolved.ddbClient).toBeInstanceOf(DynamoDBClient);
    expect(resolved.client).toBeInstanceOf(DynamoDBDocument);
  }); // AC-38

  it('does not own and returns ddbClient undefined when an external client is injected (negative branch)', () => {
    const existing = DynamoDBDocument.from(new DynamoDBClient({}));

    const resolved = resolveDynamoDBClient({ client: existing });

    expect(resolved.client).toBe(existing);
    expect(resolved.ownsClient).toBe(false);
    expect(resolved.ddbClient).toBeUndefined();
  }); // AC-38

  it('invokes the injected createClient factory with the clientConfig on the build-own-client branch', () => {
    const created = new DynamoDBClient({ region: 'us-east-2' });
    const createClient = jest.fn((_cfg: unknown) => created);

    const resolved = resolveDynamoDBClient({
      clientConfig: { region: 'us-east-2' },
      // SEAM (REQ-46): not yet present on the options type — expected to fail to compile until added.
      createClient,
    } as Parameters<typeof resolveDynamoDBClient>[0] & { createClient: typeof createClient });

    expect(createClient).toHaveBeenCalledTimes(1);
    expect(createClient).toHaveBeenCalledWith({ region: 'us-east-2' });
    expect(resolved.ddbClient).toBe(created);
    expect(resolved.ownsClient).toBe(true);
  }); // AC-38

  it('does not call the injected factory when an existing client is provided', () => {
    const existing = DynamoDBDocument.from(new DynamoDBClient({}));
    const createClient = jest.fn();

    const resolved = resolveDynamoDBClient({
      client: existing,
      // SEAM (REQ-46): not yet present on the options type — expected to fail to compile until added.
      createClient,
    } as Parameters<typeof resolveDynamoDBClient>[0] & { createClient: typeof createClient });

    expect(resolved.ownsClient).toBe(false);
    expect(createClient).not.toHaveBeenCalled();
  }); // AC-38
});

describe('strict DDB mock self-test (REQ-5)', () => {
  let ddb: StrictDdbMock;

  beforeEach(() => {
    ddb = createStrictDdbMock();
  });

  afterEach(() => {
    ddb.mock.restore();
  });

  it('rejects with the sentinel error when an un-stubbed command is sent', async () => {
    const doc = ddb.mock as unknown as DynamoDBDocument;

    await expect(doc.send(new GetCommand({ TableName: 't', Key: { id: 'x' } }))).rejects.toThrow(
      STRICT_REJECT_SENTINEL,
    );
  }); // AC-2

  it('resolves the explicitly stubbed command and rejects a different un-stubbed command', async () => {
    const doc = ddb.mock as unknown as DynamoDBDocument;
    ddb.mock.on(GetCommand).resolves({ Item: { id: 'x' } });

    await expect(doc.send(new GetCommand({ TableName: 't', Key: { id: 'x' } }))).resolves.toEqual({
      Item: { id: 'x' },
    });
    await expect(doc.send(new UpdateCommand({ TableName: 't', Key: { id: 'x' } }))).rejects.toThrow(
      STRICT_REJECT_SENTINEL,
    );
  }); // AC-2
});

describe('strict-ddb-assertion helper self-test (REQ-6/REQ-7)', () => {
  let ddb: StrictDdbMock;

  beforeEach(() => {
    ddb = createStrictDdbMock();
  });

  afterEach(() => {
    ddb.mock.restore();
  });

  it('expectExactUpdateCommand passes on an exact input and throws when any single field differs', async () => {
    const doc = ddb.mock as unknown as DynamoDBDocument;
    ddb.mock.on(UpdateCommand).resolves({});
    const input = {
      TableName: 't',
      Key: { id: 'x' },
      UpdateExpression: 'SET #v = :v',
      ExpressionAttributeNames: { '#v': 'value' },
      ExpressionAttributeValues: { ':v': 1 },
    };
    await doc.send(new UpdateCommand(input));

    expect(() => expectExactUpdateCommand(ddb.mock, input)).not.toThrow();
    // One field differs -> matcher must throw.
    expect(() =>
      expectExactUpdateCommand(ddb.mock, {
        ...input,
        ExpressionAttributeValues: { ':v': 2 },
      }),
    ).toThrow();
  }); // AC-4

  it('expectExactGetCommand throws when no GetCommand of the asserted shape was sent', async () => {
    const doc = ddb.mock as unknown as DynamoDBDocument;
    ddb.mock.on(UpdateCommand).resolves({});
    await doc.send(new UpdateCommand({ TableName: 't', Key: { id: 'x' } }));

    // No GetCommand was ever sent: helper must fail the call-count assertion.
    expect(() => expectExactGetCommand(ddb.mock, { TableName: 't', Key: { id: 'x' } })).toThrow();
  }); // AC-4
});
