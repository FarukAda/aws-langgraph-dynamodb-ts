import type { SerializerProtocol } from '@langchain/langgraph-checkpoint';

import { DynamoDBLangGraphError } from '../errors/base-error';
import { ErrorCode } from '../errors/error-code';
import { ValidationError } from '../errors/errors';
import { redactedMessage } from '../logging/secret-patterns';

/**
 * A minimal JSON serializer implementing LangGraph's {@link SerializerProtocol},
 * used by the adapters that persist plain JSON values through the shared
 * payload codec.
 *
 * `dumpsTyped` accepts any value `JSON.stringify` can represent and refuses the
 * rest. A value it cannot represent — `undefined`, a function, a symbol —
 * stringifies to `undefined` and would be stored as **zero bytes**, which reads
 * back as a parse error; a circular structure or a `BigInt` makes it throw. Both
 * are reported as `ValidationError` naming `value`, at the write, rather than
 * as an unreadable row later.
 *
 * `loadsTyped` accepts the bytes or text `dumpsTyped` produced and reports
 * anything else as `PAYLOAD_CORRUPT`: bytes that do not parse can never be
 * read, so the caller reports instead of retrying.
 */
export const JSON_SERDE: SerializerProtocol = {
  async dumpsTyped(value) {
    let text: string | undefined;
    try {
      text = JSON.stringify(value);
    } catch (error) {
      throw new ValidationError(
        `value cannot be serialized as JSON: ${redactedMessage(error as Error)}`,
        'value',
      );
    }
    if (text === undefined) {
      throw new ValidationError(
        'value has no JSON representation (undefined, a function or a symbol), so it cannot be ' +
          'stored; store null instead to record an absent value',
        'value',
      );
    }
    return ['json', new TextEncoder().encode(text)];
  },
  async loadsTyped(_type, data) {
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new DynamoDBLangGraphError(
        'the stored payload is not the JSON this serializer wrote, so it cannot be decoded',
        ErrorCode.PAYLOAD_CORRUPT,
        {},
        error as Error,
      );
    }
  },
};
