import { expectTypeOf } from 'expect-type';

import type { MessageWindow, SessionMetadata } from '../../src';

describe('chat history read window types', () => {
  it('exports MessageWindow and an optional SessionMetadata.expiresAt', () => {
    expectTypeOf<MessageWindow>().toEqualTypeOf<{ limit?: number; before?: Date }>();
    expectTypeOf<SessionMetadata['expiresAt']>().toEqualTypeOf<string | undefined>();
  });
});
