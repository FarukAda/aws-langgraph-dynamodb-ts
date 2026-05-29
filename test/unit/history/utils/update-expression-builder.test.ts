/**
 * Unit tests for src/history/utils/update-expression-builder.ts.
 *
 * Locks AC-10 / REQ-14 and the seam AC-38 (injected clock). STRICT: the #ttl
 * reserved-word aliasing is the load-bearing contract.
 *
 * Pinned EXACTLY from source:
 *   buildOptimisticMetadataUpdate(title, newCount, expectedCount, ttlDays?, now?)
 *   setParts (in order):
 *     'updatedAt = :updatedAt',
 *     'itemType = :itemType',
 *     'messageCount = :newCount',
 *     'title = if_not_exists(title, :title)',
 *     'createdAt = if_not_exists(createdAt, :createdAt)'
 *   + '#ttl = :ttl' appended ONLY when ttlDays !== undefined.
 *   updateExpression === 'SET ' + setParts.join(', ').
 *   expressionAttributeValues base:
 *     { ':updatedAt': now, ':createdAt': now, ':newCount': newCount,
 *       ':itemType': 'metadata', ':title': title }
 *     + ':expectedCount' when expectedCount !== undefined
 *     + ':ttl' (= calculateTTLTimestamp(ttlDays)) when ttlDays !== undefined.
 *   conditionExpression: 'attribute_not_exists(messageCount)' for a new session,
 *     else 'messageCount = :expectedCount'.
 *   expressionAttributeNames: present and === { '#ttl': 'ttl' } ONLY when
 *     ttlDays set; the KEY is ABSENT entirely when ttlDays is undefined.
 *
 * `now` value comes from Date.now() (frozen to FROZEN_NOW_MS by the global setup)
 * unless the injected clock seam (5th param) is provided.
 *
 * SEAM NOTE (AC-38): the optional 5th `now` param is the not-yet-added clock
 * seam (plan §B). The three "clock seam" tests below are EXPECTED to fail to
 * compile until that seam lands; they are the failing-test signal for REQ-45.
 */
import {
  buildOptimisticMetadataUpdate,
  buildMessageItems,
  buildMessageSK,
  formatMessageIndex,
} from '../../../../src/history/utils/update-expression-builder';
import { makeMessages } from '../../../shared/fixtures/test-data';
import { FROZEN_NOW_MS, EXPECTED_TTL_30D } from '../../../shared/helpers/frozen-time';

const TITLE = 'My Session';
const NEW_COUNT = 3;
const EXPECTED_COUNT = 2;

const BASE_SET =
  'SET updatedAt = :updatedAt, itemType = :itemType, messageCount = :newCount, ' +
  'title = if_not_exists(title, :title), createdAt = if_not_exists(createdAt, :createdAt)';

describe('update-expression-builder', () => {
  describe('#ttl aliasing (ttlDays SET)', () => {
    it('appends "#ttl = :ttl" and produces the exact updateExpression string', () => {
      const out = buildOptimisticMetadataUpdate(TITLE, NEW_COUNT, EXPECTED_COUNT, 30);
      expect(out.updateExpression).toBe(`${BASE_SET}, #ttl = :ttl`);
    }); // AC-10

    it('returns expressionAttributeNames deep-equal to exactly { "#ttl": "ttl" }', () => {
      const out = buildOptimisticMetadataUpdate(TITLE, NEW_COUNT, EXPECTED_COUNT, 30);
      expect(out.expressionAttributeNames).toEqual({ '#ttl': 'ttl' });
    }); // AC-10

    it('returns the exact full expressionAttributeValues including :ttl at the frozen epoch', () => {
      const out = buildOptimisticMetadataUpdate(TITLE, NEW_COUNT, EXPECTED_COUNT, 30);
      expect(out.expressionAttributeValues).toEqual({
        ':updatedAt': FROZEN_NOW_MS,
        ':createdAt': FROZEN_NOW_MS,
        ':newCount': NEW_COUNT,
        ':itemType': 'metadata',
        ':title': TITLE,
        ':expectedCount': EXPECTED_COUNT,
        ':ttl': EXPECTED_TTL_30D,
      });
    }); // AC-9
  });

  describe('#ttl aliasing (ttlDays UNSET)', () => {
    it('omits the expressionAttributeNames key entirely when ttlDays is undefined', () => {
      const out = buildOptimisticMetadataUpdate(TITLE, NEW_COUNT, EXPECTED_COUNT);
      expect('expressionAttributeNames' in out).toBe(false);
    }); // AC-10

    it('produces the base updateExpression with no #ttl/:ttl when ttlDays is undefined', () => {
      const out = buildOptimisticMetadataUpdate(TITLE, NEW_COUNT, EXPECTED_COUNT);
      expect(out.updateExpression).toBe(BASE_SET);
      expect(out.expressionAttributeValues).toEqual({
        ':updatedAt': FROZEN_NOW_MS,
        ':createdAt': FROZEN_NOW_MS,
        ':newCount': NEW_COUNT,
        ':itemType': 'metadata',
        ':title': TITLE,
        ':expectedCount': EXPECTED_COUNT,
      });
    }); // AC-10
  });

  describe('conditionExpression branch (optimistic lock)', () => {
    it('uses messageCount = :expectedCount and binds :expectedCount when expectedCount is provided', () => {
      const out = buildOptimisticMetadataUpdate(TITLE, NEW_COUNT, EXPECTED_COUNT, 30);
      expect(out.conditionExpression).toBe('messageCount = :expectedCount');
      expect(out.expressionAttributeValues[':expectedCount']).toBe(EXPECTED_COUNT);
    }); // AC-10

    it('uses attribute_not_exists(messageCount) and omits :expectedCount when expectedCount is undefined', () => {
      const out = buildOptimisticMetadataUpdate(TITLE, NEW_COUNT, undefined, 30);
      expect(out.conditionExpression).toBe('attribute_not_exists(messageCount)');
      expect(out.expressionAttributeValues).not.toHaveProperty(':expectedCount');
    }); // AC-10
  });

  describe('formatMessageIndex / buildMessageSK', () => {
    it('zero-pads the index to a 6-digit string', () => {
      expect(formatMessageIndex(0)).toBe('000000');
      expect(formatMessageIndex(1)).toBe('000001');
      expect(formatMessageIndex(999999)).toBe('999999');
    }); // AC-10

    it('builds the composite SK as "${sessionId}#msg#<6-digit>"', () => {
      expect(buildMessageSK('session-abc', 12)).toBe('session-abc#msg#000012');
    }); // AC-10
  });

  describe('buildMessageItems', () => {
    it('assigns ascending messageIndex = startIndex + i (kills startIndex - i mutant)', () => {
      // Two messages from startIndex 10 must be indexed 10, 11 (not 10, 9). The
      // index also drives the SK, so we pin both.
      const items = buildMessageItems('user-123', 'session-abc', makeMessages(2), 10);
      expect(items).toHaveLength(2);
      expect(items[0].messageIndex).toBe(10);
      expect(items[1].messageIndex).toBe(11);
      expect(items[0].sessionId).toBe('session-abc#msg#000010');
      expect(items[1].sessionId).toBe('session-abc#msg#000011');
    }); // AC-10

    it('omits the ttl field entirely when ttlDays is undefined (kills if(true) ttl mutant)', () => {
      const items = buildMessageItems('user-123', 'session-abc', makeMessages(1), 0);
      expect('ttl' in items[0]).toBe(false);
      // Full shape is pinned to guard against stray fields.
      expect(items[0]).toEqual({
        userId: 'user-123',
        sessionId: 'session-abc#msg#000000',
        itemType: 'message',
        messageIndex: 0,
        message: items[0].message,
      });
    }); // AC-10

    it('sets ttl on every item to the frozen 30-day TTL when ttlDays is provided', () => {
      const items = buildMessageItems('user-123', 'session-abc', makeMessages(2), 0, 30);
      expect(items[0].ttl).toBe(EXPECTED_TTL_30D);
      expect(items[1].ttl).toBe(EXPECTED_TTL_30D);
    }); // AC-10
  });

  describe('clock seam (AC-38)', () => {
    it('uses the default Date.now clock (frozen) when no clock is injected', () => {
      const out = buildOptimisticMetadataUpdate(TITLE, NEW_COUNT, EXPECTED_COUNT, 30);
      expect(out.expressionAttributeValues[':ttl']).toBe(EXPECTED_TTL_30D);
      expect(out.expressionAttributeValues[':updatedAt']).toBe(FROZEN_NOW_MS);
    }); // AC-38

    it('uses an injected clock for :updatedAt/:createdAt and the :ttl base instead of Date.now', () => {
      const injectedMs = FROZEN_NOW_MS + 5 * 86400 * 1000; // 5 days later
      const injectedClock = (): number => injectedMs;
      const out = buildOptimisticMetadataUpdate(
        TITLE,
        NEW_COUNT,
        EXPECTED_COUNT,
        30,
        injectedClock,
      );
      expect(out.expressionAttributeValues[':updatedAt']).toBe(injectedMs);
      expect(out.expressionAttributeValues[':ttl']).toBe(
        Math.floor(injectedMs / 1000) + 30 * 86400,
      );
      expect(out.expressionAttributeValues[':ttl']).not.toBe(EXPECTED_TTL_30D);
    }); // AC-38

    it('keeps the #ttl aliasing and expression shape byte-identical when a clock is injected', () => {
      const injectedClock = (): number => FROZEN_NOW_MS;
      const withClock = buildOptimisticMetadataUpdate(
        TITLE,
        NEW_COUNT,
        EXPECTED_COUNT,
        30,
        injectedClock,
      );
      const withoutClock = buildOptimisticMetadataUpdate(TITLE, NEW_COUNT, EXPECTED_COUNT, 30);
      expect(withClock.updateExpression).toBe(withoutClock.updateExpression);
      expect(withClock.conditionExpression).toBe(withoutClock.conditionExpression);
      expect(withClock.expressionAttributeNames).toEqual(withoutClock.expressionAttributeNames);
      expect(withClock.expressionAttributeValues).toEqual(withoutClock.expressionAttributeValues);
    }); // AC-38
  });
});
