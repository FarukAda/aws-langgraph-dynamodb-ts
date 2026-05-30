import type { SerializerProtocol } from '@langchain/langgraph-checkpoint';

/**
 * A minimal JSON serializer implementing LangGraph's {@link SerializerProtocol},
 * used by adapters (the store, history) that persist plain JSON values through
 * the shared payload codec.
 */
export const JSON_SERDE: SerializerProtocol = {
  async dumpsTyped(value) {
    return ['json', new TextEncoder().encode(JSON.stringify(value))];
  },
  async loadsTyped(_type, data) {
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
    return JSON.parse(text);
  },
};
