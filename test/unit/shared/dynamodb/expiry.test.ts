import type { QueryCommandInput, ScanCommandInput } from '@aws-sdk/lib-dynamodb';

import { isExpiredRow, withoutExpired } from '../../../../src/shared/dynamodb/expiry';

describe('isExpiredRow', () => {
  it('is true at or past the ttl and false before it or without one', () => {
    expect(isExpiredRow({}, 100)).toBe(false);
    expect(isExpiredRow({ ttl: 101 }, 100)).toBe(false);
    expect(isExpiredRow({ ttl: 100 }, 100)).toBe(true);
    expect(isExpiredRow({ ttl: 99 }, 100)).toBe(true);
  });
});

describe('withoutExpired', () => {
  it('adds the ttl filter to a query without one', () => {
    const query: QueryCommandInput = { TableName: 't', KeyConditionExpression: '#pk = :pk' };
    const params = withoutExpired(query, 100);
    expect(params.FilterExpression).toBe('attribute_not_exists(#ttl) OR #ttl > :now');
    expect(params.ExpressionAttributeNames).toEqual({ '#ttl': 'ttl' });
    expect(params.ExpressionAttributeValues).toEqual({ ':now': 100 });
  });

  it('ANDs an existing filter and merges the names and values', () => {
    const scan: ScanCommandInput = {
      TableName: 't',
      FilterExpression: 'attribute_exists(#ns)',
      ExpressionAttributeNames: { '#ns': 'namespace' },
      ExpressionAttributeValues: { ':pk': 'p' },
    };
    const params = withoutExpired(scan, 100);
    expect(params.FilterExpression).toBe(
      '(attribute_exists(#ns)) AND (attribute_not_exists(#ttl) OR #ttl > :now)',
    );
    expect(params.ExpressionAttributeNames).toEqual({ '#ns': 'namespace', '#ttl': 'ttl' });
    expect(params.ExpressionAttributeValues).toEqual({ ':pk': 'p', ':now': 100 });
  });
});
