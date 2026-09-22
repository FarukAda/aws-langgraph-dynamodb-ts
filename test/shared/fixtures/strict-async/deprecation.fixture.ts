import { deprecate } from 'node:util';

/** Run only by the strict-async environment's end-to-end test, never by the unit tier. */
it('calls a deprecated API', () => {
  deprecate(() => undefined, 'fixture deprecation', 'DEP_STRICT_ASYNC_FIXTURE')();
});
