import type {
  BaseStore,
  CheckpointListOptions,
  SearchOperation,
} from '@langchain/langgraph-checkpoint';
import { expectTypeOf } from 'expect-type';

/**
 * At run time these option objects ignore keys this version does not read,
 * since LangGraph defines them and passes its own through (decision record
 * 28). These pins make the type check fail the day LangGraph adds a key, so
 * the weekly latest-peers workflow reports it and a maintainer decides whether
 * this package should read it. `getDeltaChannelHistory`'s options are pinned
 * equal to upstream's parameter type in `public-surface.test.ts`.
 */
describe('option objects LangGraph defines', () => {
  it('have exactly the keys this version reads', () => {
    expectTypeOf<keyof CheckpointListOptions>().toEqualTypeOf<'limit' | 'before' | 'filter'>();
    expectTypeOf<keyof SearchOperation>().toEqualTypeOf<
      'namespacePrefix' | 'filter' | 'limit' | 'offset' | 'query'
    >();
    expectTypeOf<keyof NonNullable<Parameters<BaseStore['listNamespaces']>[0]>>().toEqualTypeOf<
      'prefix' | 'suffix' | 'maxDepth' | 'limit' | 'offset'
    >();
  });
});
