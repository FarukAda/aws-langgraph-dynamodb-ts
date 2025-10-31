import { validateConfigurable } from '../../../src/checkpointer/actions/validate-configurable';
import { CheckpointerValidationError } from '../../../src/checkpointer/utils';

describe('validateConfigurable', () => {
  it('should validate valid configurable with all fields', () => {
    const result = validateConfigurable({
      thread_id: 'thread-123',
      checkpoint_ns: 'namespace',
      checkpoint_id: 'checkpoint-456',
    });

    expect(result.thread_id).toBe('thread-123');
    expect(result.checkpoint_ns).toBe('namespace');
    expect(result.checkpoint_id).toBe('checkpoint-456');
  });

  it('should validate configurable with only thread_id', () => {
    const result = validateConfigurable({
      thread_id: 'thread-123',
    });

    expect(result.thread_id).toBe('thread-123');
    expect(result.checkpoint_ns).toBe('');
    expect(result.checkpoint_id).toBeUndefined();
  });

  it('should default checkpoint_ns to empty string', () => {
    const result = validateConfigurable({
      thread_id: 'thread-123',
      checkpoint_id: 'checkpoint-456',
    });

    expect(result.checkpoint_ns).toBe('');
  });

  it('should throw error when configurable is undefined', () => {
    expect(() => validateConfigurable(undefined)).toThrow(CheckpointerValidationError);
    expect(() => validateConfigurable(undefined)).toThrow('Missing configurable');
  });

  it('should throw error when thread_id is missing', () => {
    expect(() =>
      validateConfigurable({
        checkpoint_ns: 'namespace',
      }),
    ).toThrow(CheckpointerValidationError);
    expect(() =>
      validateConfigurable({
        checkpoint_ns: 'namespace',
      }),
    ).toThrow('thread_id must be a string');
  });

  it('should throw error when thread_id is not a string', () => {
    expect(() =>
      validateConfigurable({
        thread_id: 123 as any,
      }),
    ).toThrow(CheckpointerValidationError);
    expect(() =>
      validateConfigurable({
        thread_id: 123 as any,
      }),
    ).toThrow('thread_id must be a string');
  });

  it('should throw error when thread_id is empty', () => {
    expect(() =>
      validateConfigurable({
        thread_id: '',
      }),
    ).toThrow(CheckpointerValidationError);
    expect(() =>
      validateConfigurable({
        thread_id: '',
      }),
    ).toThrow('thread_id cannot be empty');
  });

  it('should throw error when thread_id contains separator', () => {
    expect(() =>
      validateConfigurable({
        thread_id: 'thread:::id',
      }),
    ).toThrow(CheckpointerValidationError);
    expect(() =>
      validateConfigurable({
        thread_id: 'thread:::id',
      }),
    ).toThrow('thread_id cannot contain separator');
  });

  it('should throw error when checkpoint_ns is not a string', () => {
    expect(() =>
      validateConfigurable({
        thread_id: 'thread-123',
        checkpoint_ns: 123 as any,
      }),
    ).toThrow(CheckpointerValidationError);
    expect(() =>
      validateConfigurable({
        thread_id: 'thread-123',
        checkpoint_ns: 123 as any,
      }),
    ).toThrow('checkpoint_ns must be a string');
  });

  it('should throw error when checkpoint_ns contains separator', () => {
    expect(() =>
      validateConfigurable({
        thread_id: 'thread-123',
        checkpoint_ns: 'ns:::name',
      }),
    ).toThrow(CheckpointerValidationError);
  });

  it('should throw error when checkpoint_id is not a string', () => {
    expect(() =>
      validateConfigurable({
        thread_id: 'thread-123',
        checkpoint_id: 123 as any,
      }),
    ).toThrow(CheckpointerValidationError);
    expect(() =>
      validateConfigurable({
        thread_id: 'thread-123',
        checkpoint_id: 123 as any,
      }),
    ).toThrow('checkpoint_id must be a string');
  });

  it('should throw error when checkpoint_id is empty string', () => {
    expect(() =>
      validateConfigurable({
        thread_id: 'thread-123',
        checkpoint_id: '',
      }),
    ).toThrow(CheckpointerValidationError);
    expect(() =>
      validateConfigurable({
        thread_id: 'thread-123',
        checkpoint_id: '',
      }),
    ).toThrow('checkpoint_id cannot be empty');
  });

  it('should throw error when checkpoint_id contains separator', () => {
    expect(() =>
      validateConfigurable({
        thread_id: 'thread-123',
        checkpoint_id: 'checkpoint:::id',
      }),
    ).toThrow(CheckpointerValidationError);
  });

  it('should accept checkpoint_ns as empty string', () => {
    const result = validateConfigurable({
      thread_id: 'thread-123',
      checkpoint_ns: '',
    });

    expect(result.checkpoint_ns).toBe('');
  });

  it('should handle extra properties in configurable', () => {
    const result = validateConfigurable({
      thread_id: 'thread-123',
      extra_field: 'extra_value',
    });

    expect(result.thread_id).toBe('thread-123');
    expect(result.checkpoint_ns).toBe('');
    expect(result.checkpoint_id).toBeUndefined();
  });
});
