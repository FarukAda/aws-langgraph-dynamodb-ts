import { EventEmitter } from 'node:events';

/** Run only by the strict-async environment's end-to-end test, never by the unit tier. */
it('adds one listener too many', () => {
  const emitter = new EventEmitter();
  for (let i = 0; i <= EventEmitter.defaultMaxListeners; i += 1)
    emitter.on('abort', () => undefined);
});
