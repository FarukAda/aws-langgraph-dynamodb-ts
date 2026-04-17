/**
 * Unit tests for S3Offloader utility
 */

import { S3Offloader, S3OffloadConfig } from '../../../src/shared';

// Mock @aws-sdk/client-s3
const mockSend = jest.fn();
const mockDestroy = jest.fn();

jest.mock('@aws-sdk/client-s3', () => {
  return {
    S3Client: jest.fn().mockImplementation(() => ({
      send: mockSend,
      destroy: mockDestroy,
    })),
    PutObjectCommand: jest.fn().mockImplementation((input: any) => ({ ...input, _type: 'Put' })),
    GetObjectCommand: jest.fn().mockImplementation((input: any) => ({ ...input, _type: 'Get' })),
    DeleteObjectCommand: jest.fn().mockImplementation((input: any) => ({
      ...input,
      _type: 'Delete',
    })),
    DeleteObjectsCommand: jest.fn().mockImplementation((input: any) => ({
      ...input,
      _type: 'DeleteObjects',
    })),
    GetBucketLifecycleConfigurationCommand: jest
      .fn()
      .mockImplementation((input: any) => ({ ...input, _type: 'GetLifecycle' })),
    PutBucketLifecycleConfigurationCommand: jest
      .fn()
      .mockImplementation((input: any) => ({ ...input, _type: 'PutLifecycle' })),
  };
});

describe('S3Offloader', () => {
  let offloader: S3Offloader;
  const defaultConfig: S3OffloadConfig = {
    bucketName: 'test-bucket',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    offloader = new S3Offloader(defaultConfig);
  });

  describe('constructor', () => {
    it('should use default values for optional config', () => {
      const o = new S3Offloader({ bucketName: 'my-bucket' });
      expect(o).toBeInstanceOf(S3Offloader);
    });

    it('should accept custom configuration', () => {
      const o = new S3Offloader({
        bucketName: 'custom-bucket',
        keyPrefix: 'custom/',
        thresholdBytes: 100 * 1024,
        clientConfig: { region: 'eu-west-1' },
      });
      expect(o).toBeInstanceOf(S3Offloader);
    });
  });

  describe('shouldOffload', () => {
    it('should return false for data below default threshold (350KB)', () => {
      const smallData = new Uint8Array(349 * 1024); // Just under 350KB
      expect(offloader.shouldOffload(smallData)).toBe(false);
    });

    it('should return true for data at or above default threshold', () => {
      const exactData = new Uint8Array(350 * 1024); // Exactly 350KB
      expect(offloader.shouldOffload(exactData)).toBe(true);

      const largeData = new Uint8Array(400 * 1024);
      expect(offloader.shouldOffload(largeData)).toBe(true);
    });

    it('should respect custom threshold', () => {
      const custom = new S3Offloader({ bucketName: 'b', thresholdBytes: 100 });

      expect(custom.shouldOffload(new Uint8Array(99))).toBe(false);
      expect(custom.shouldOffload(new Uint8Array(100))).toBe(true);
      expect(custom.shouldOffload(new Uint8Array(200))).toBe(true);
    });

    it('should return false for empty data', () => {
      expect(offloader.shouldOffload(new Uint8Array(0))).toBe(false);
    });
  });

  describe('buildKey', () => {
    it('should build a key with default prefix', () => {
      const key = offloader.buildKey('thread-123', 'ckpt-456', 'checkpoint');
      expect(key).toBe('langgraph-checkpoints/thread-123/ckpt-456/checkpoint.bin');
    });

    it('should build a key with custom prefix', () => {
      const custom = new S3Offloader({ bucketName: 'b', keyPrefix: 'custom/' });
      const key = custom.buildKey('thread-abc', 'ckpt-def', 'metadata');
      expect(key).toBe('custom/thread-abc/ckpt-def/metadata.bin');
    });

    it('should handle write fields with indexes', () => {
      const key = offloader.buildKey('thread-1', 'ckpt-2', 'write-0');
      expect(key).toBe('langgraph-checkpoints/thread-1/ckpt-2/write-0.bin');
    });
  });

  describe('upload', () => {
    it('should upload data to S3 and return the key', async () => {
      mockSend.mockResolvedValueOnce({});

      const data = new Uint8Array([1, 2, 3]);
      const result = await offloader.upload('test-key', data);

      expect(result).toBe('test-key');
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          Bucket: 'test-bucket',
          Key: 'test-key',
          Body: data,
          ContentType: 'application/octet-stream',
        }),
      );
    });

    it('should default ServerSideEncryption to AES256 when not configured', async () => {
      mockSend.mockResolvedValueOnce({});

      await offloader.upload('test-key', new Uint8Array([1]));

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({ ServerSideEncryption: 'AES256' }),
      );
    });

    it('should honor an explicit serverSideEncryption override', async () => {
      const kmsOffloader = new S3Offloader({
        bucketName: 'test-bucket',
        serverSideEncryption: 'aws:kms',
        sseKmsKeyId: 'alias/my-key',
      });
      mockSend.mockResolvedValueOnce({});

      await kmsOffloader.upload('test-key', new Uint8Array([1]));

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          ServerSideEncryption: 'aws:kms',
          SSEKMSKeyId: 'alias/my-key',
        }),
      );
    });
  });

  describe('download', () => {
    it('should download data from S3', async () => {
      const data = new Uint8Array([4, 5, 6]);
      mockSend.mockResolvedValueOnce({
        Body: { transformToByteArray: () => Promise.resolve(data) },
      });

      const result = await offloader.download('test-key');
      expect(result).toEqual(data);
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('should throw if body is empty', async () => {
      mockSend.mockResolvedValueOnce({ Body: null });

      await expect(offloader.download('empty-key')).rejects.toThrow(
        'S3 object body is empty for key: empty-key',
      );
    });
  });

  describe('delete', () => {
    it('should delete an object from S3', async () => {
      mockSend.mockResolvedValueOnce({});

      await offloader.delete('test-key');

      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          Bucket: 'test-bucket',
          Key: 'test-key',
        }),
      );
    });
  });

  describe('deleteBatch', () => {
    it('should batch delete objects from S3', async () => {
      mockSend.mockResolvedValueOnce({});

      const keys = ['key-1', 'key-2', 'key-3'];
      await offloader.deleteBatch(keys);

      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          Bucket: 'test-bucket',
          Delete: {
            Objects: [{ Key: 'key-1' }, { Key: 'key-2' }, { Key: 'key-3' }],
            Quiet: true,
          },
        }),
      );
    });

    it('should skip deletion for empty keys array', async () => {
      await offloader.deleteBatch([]);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('should batch in groups of 1000', async () => {
      mockSend.mockResolvedValue({});
      const keys = Array.from({ length: 2500 }, (_, i) => `key-${i}`);

      await offloader.deleteBatch(keys);

      // Should be 3 calls: 1000 + 1000 + 500
      expect(mockSend).toHaveBeenCalledTimes(3);
    });

    it('should log warning on partial delete failure without throwing', async () => {
      // Mock console.warn since getLogger().warn uses console
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

      mockSend.mockResolvedValueOnce({
        Errors: [{ Key: 'key-2', Code: 'InternalError', Message: 'Internal failure' }],
      });

      const keys = ['key-1', 'key-2', 'key-3'];

      // Should NOT throw
      await expect(offloader.deleteBatch(keys)).resolves.not.toThrow();

      // Should have logged a warning (getLogger().warn calls console.warn with [langgraph-dynamodb] prefix)
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('1 objects failed to delete'));

      warnSpy.mockRestore();
    });
  });

  describe('getKeyPrefix', () => {
    it('should return the default key prefix', () => {
      expect(offloader.getKeyPrefix()).toBe('langgraph-checkpoints/');
    });

    it('should return a custom key prefix', () => {
      const custom = new S3Offloader({ bucketName: 'b', keyPrefix: 'custom/' });
      expect(custom.getKeyPrefix()).toBe('custom/');
    });
  });

  describe('ensureLifecycleRule', () => {
    it('should add new rule when no lifecycle config exists', async () => {
      // Simulate NoSuchLifecycleConfiguration error
      const noConfigError = new Error('No lifecycle');
      noConfigError.name = 'NoSuchLifecycleConfiguration';
      mockSend.mockRejectedValueOnce(noConfigError); // Get fails
      mockSend.mockResolvedValueOnce({}); // Put succeeds

      await offloader.ensureLifecycleRule(30);

      // Should have called Get then Put
      expect(mockSend).toHaveBeenCalledTimes(2);
      const putCall = mockSend.mock.calls[1][0];
      expect(putCall._type).toBe('PutLifecycle');
      expect(putCall.LifecycleConfiguration.Rules).toHaveLength(1);
      expect(putCall.LifecycleConfiguration.Rules[0]).toEqual({
        ID: 'langgraph-ttl-langgraph-checkpoints',
        Filter: { Prefix: 'langgraph-checkpoints/' },
        Status: 'Enabled',
        Expiration: { Days: 30 },
      });
    });

    it('should preserve existing rules and append new one', async () => {
      const existingRule = {
        ID: 'user-custom-rule',
        Filter: { Prefix: 'logs/' },
        Status: 'Enabled',
        Expiration: { Days: 90 },
      };

      mockSend.mockResolvedValueOnce({ Rules: [existingRule] }); // Get returns existing
      mockSend.mockResolvedValueOnce({}); // Put succeeds

      await offloader.ensureLifecycleRule(7);

      expect(mockSend).toHaveBeenCalledTimes(2);
      const putCall = mockSend.mock.calls[1][0];
      expect(putCall.LifecycleConfiguration.Rules).toHaveLength(2);
      // Existing rule preserved
      expect(putCall.LifecycleConfiguration.Rules[0]).toEqual(existingRule);
      // New rule appended
      expect(putCall.LifecycleConfiguration.Rules[1].ID).toBe(
        'langgraph-ttl-langgraph-checkpoints',
      );
    });

    it('should skip if matching rule already exists with correct days', async () => {
      const matchingRule = {
        ID: 'langgraph-ttl-langgraph-checkpoints',
        Filter: { Prefix: 'langgraph-checkpoints/' },
        Status: 'Enabled',
        Expiration: { Days: 30 },
      };

      mockSend.mockResolvedValueOnce({ Rules: [matchingRule] }); // Get returns matching

      await offloader.ensureLifecycleRule(30);

      // Only Get was called, no Put
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('should handle NoSuchLifecycleConfiguration gracefully', async () => {
      const noConfigError = new Error('The lifecycle configuration does not exist');
      noConfigError.name = 'NoSuchLifecycleConfiguration';

      mockSend.mockRejectedValueOnce(noConfigError); // Get fails with expected error
      mockSend.mockResolvedValueOnce({}); // Put succeeds

      // Should NOT throw
      await expect(offloader.ensureLifecycleRule(14)).resolves.not.toThrow();

      expect(mockSend).toHaveBeenCalledTimes(2);
      const putCall = mockSend.mock.calls[1][0];
      expect(putCall.LifecycleConfiguration.Rules[0].ID).toBe(
        'langgraph-ttl-langgraph-checkpoints',
      );
    });

    it('should update rule in place when TTL changes (no stale rule left behind)', async () => {
      const oldRule = {
        ID: 'langgraph-ttl-langgraph-checkpoints',
        Filter: { Prefix: 'langgraph-checkpoints/' },
        Status: 'Enabled',
        Expiration: { Days: 30 },
      };
      const otherRule = {
        ID: 'user-rule',
        Filter: { Prefix: 'other/' },
        Status: 'Enabled',
        Expiration: { Days: 365 },
      };

      // Rule ID is TTL-independent, so raising the TTL from 30 to 60 must update
      // the same rule in place rather than appending a new one.
      const modifiedRule = { ...oldRule, Expiration: { Days: 60 } };

      mockSend.mockResolvedValueOnce({ Rules: [otherRule, modifiedRule] });
      mockSend.mockResolvedValueOnce({});

      await offloader.ensureLifecycleRule(30);

      expect(mockSend).toHaveBeenCalledTimes(2);
      const putCall = mockSend.mock.calls[1][0];
      expect(putCall.LifecycleConfiguration.Rules).toHaveLength(2);
      // Other rule preserved
      expect(putCall.LifecycleConfiguration.Rules[0]).toEqual(otherRule);
      // Our rule updated with correct days
      expect(putCall.LifecycleConfiguration.Rules[1].Expiration.Days).toBe(30);
    });

    it('regression: raising TTL on an existing rule updates it instead of appending', async () => {
      // Two sequential ensureLifecycleRule calls with different TTL values must result in
      // ONE rule with the latest TTL, not two rules from different library versions.
      const existing = {
        ID: 'langgraph-ttl-langgraph-checkpoints',
        Filter: { Prefix: 'langgraph-checkpoints/' },
        Status: 'Enabled',
        Expiration: { Days: 30 },
      };

      mockSend.mockResolvedValueOnce({ Rules: [existing] });
      mockSend.mockResolvedValueOnce({});

      await offloader.ensureLifecycleRule(90);

      const putCall = mockSend.mock.calls[1][0];
      expect(putCall.LifecycleConfiguration.Rules).toHaveLength(1);
      expect(putCall.LifecycleConfiguration.Rules[0].Expiration.Days).toBe(90);
    });

    it('should re-throw non-lifecycle errors from GetBucketLifecycleConfiguration', async () => {
      const accessDenied = new Error('Access Denied');
      accessDenied.name = 'AccessDenied';
      mockSend.mockRejectedValueOnce(accessDenied);

      await expect(offloader.ensureLifecycleRule(30)).rejects.toThrow('Access Denied');
    });
  });

  describe('destroy', () => {
    it('should be safe to call when client was never initialized', () => {
      const fresh = new S3Offloader({ bucketName: 'fresh-bucket' });
      // No S3 operations were performed, so client was never created
      expect(() => fresh.destroy()).not.toThrow();
      expect(mockDestroy).not.toHaveBeenCalled();
    });

    it('should destroy the S3 client after it has been used', async () => {
      // Trigger client creation by performing an operation
      mockSend.mockResolvedValueOnce({});
      await offloader.upload('trigger-key', new Uint8Array([1]));

      offloader.destroy();
      expect(mockDestroy).toHaveBeenCalledTimes(1);
    });
  });
});
