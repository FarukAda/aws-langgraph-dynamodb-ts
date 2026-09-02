import fc from 'fast-check';

import { redactSecrets } from '../../src/shared/logging/redaction';

const key = fc.oneof(
  fc.string({ unit: 'grapheme-ascii', minLength: 1, maxLength: 12 }),
  fc.constantFrom('password', 'apiKey', 'secretAccessKey', 'token', 'Authorization', 'user_ssn'),
);
const document = fc.dictionary(key, fc.jsonValue({ maxDepth: 3 }), { maxKeys: 8 });

describe('redactSecrets (property)', () => {
  it('is idempotent and never mutates its input', () => {
    fc.assert(
      fc.property(document, (input) => {
        const before = JSON.stringify(input);
        const once = redactSecrets(input);
        expect(JSON.stringify(input)).toBe(before);
        expect(redactSecrets(once)).toEqual(once);
      }),
      { numRuns: 300 },
    );
  });
});
