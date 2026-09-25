import { readFileSync } from 'node:fs';

import * as dynamodb from '@aws-sdk/client-dynamodb';
import * as s3 from '@aws-sdk/client-s3';

import {
  AWS_ERROR_CODES,
  DEFAULT_RETRYABLE_ERRORS,
  TRANSIENT_NETWORK_ERROR_CODES,
} from '../../src/shared/errors/classify';
import { listSourceFiles } from './guards/source-files';

/**
 * Every AWS error name this package acts on is one AWS declares or documents.
 *
 * The SDK exports a class per exception the service model declares, so most
 * names are checkable against the installed package rather than a matter of
 * care. A few are not in the model — the common errors every AWS API can
 * return, S3's error codes, and the SDK's own transport names — and each of
 * those is listed below with the page that documents it. A name in neither
 * place is an invented one: the default retry list held `NetworkingError`,
 * which no installed SDK package emits, for exactly that reason.
 */
const DOCUMENTED: Readonly<Record<string, string>> = {
  AccessDeniedException: 'DynamoDB Developer Guide, Error handling with DynamoDB',
  IncompleteSignatureException: 'DynamoDB Developer Guide, Error handling with DynamoDB',
  MissingAuthenticationTokenException: 'DynamoDB Developer Guide, Error handling with DynamoDB',
  UnrecognizedClientException: 'DynamoDB Developer Guide, Error handling with DynamoDB',
  ValidationException: 'DynamoDB Developer Guide, Error handling with DynamoDB',
  ServiceUnavailable: 'DynamoDB Developer Guide, Error handling with DynamoDB (HTTP 503)',
  ExpiredTokenException: 'DynamoDB API Reference, Common Error Types',
  IncompleteSignature: 'DynamoDB API Reference, Common Error Types',
  InternalFailure: 'DynamoDB API Reference, Common Error Types',
  MalformedHttpRequestException: 'DynamoDB API Reference, Common Error Types',
  NotAuthorized: 'DynamoDB API Reference, Common Error Types',
  RequestEntityTooLargeException: 'DynamoDB API Reference, Common Error Types',
  RequestTimeoutException: 'DynamoDB API Reference, Common Error Types',
  ValidationError: 'DynamoDB API Reference, Common Error Types',
  ConditionalRequestConflict: 'Amazon S3 API Reference, Error responses',
  ExpiredToken: 'Amazon S3 API Reference, Error responses',
  InternalError: 'Amazon S3 API Reference, Error responses',
  InvalidAccessKeyId: 'Amazon S3 API Reference, Error responses',
  NoSuchLifecycleConfiguration: 'Amazon S3 API Reference, Error responses',
  PreconditionFailed: 'Amazon S3 API Reference, Error responses',
  RequestTimeout: 'Amazon S3 API Reference, Error responses',
  SignatureDoesNotMatch: 'Amazon S3 API Reference, Error responses',
  SlowDown: 'Amazon S3 API Reference, Error responses',
  TimeoutError: '@smithy/core retry TRANSIENT_ERROR_CODES; raised by @smithy/node-http-handler',
  AbortError: 'the name the SDK and the platform give a request an AbortSignal cancelled',
  DOMException: "the web platform's own error type; redaction.ts recognises its tag",
};

/**
 * The exceptions DynamoDB declares for the data-plane operations this package
 * issues — GetItem, PutItem, UpdateItem, DeleteItem, Query, Scan,
 * BatchWriteItem and TransactWriteItems — taken from each operation's
 * "Errors" section in the DynamoDB API Reference. The table must place every
 * one of them explicitly, even where the answer is the residual code, so a
 * failure the service documents is never classified by accident.
 */
const DATA_PLANE_EXCEPTIONS: readonly string[] = [
  'ConditionalCheckFailedException',
  'IdempotentParameterMismatchException',
  'InternalServerError',
  'InvalidEndpointException',
  'ItemCollectionSizeLimitExceededException',
  'ProvisionedThroughputExceededException',
  'ReplicatedWriteConflictException',
  'RequestLimitExceeded',
  'ResourceNotFoundException',
  'ThrottlingException',
  'TransactionCanceledException',
  'TransactionConflictException',
  'TransactionInProgressException',
];

/**
 * The exception classes a client package exports, found by prototype rather
 * than by suffix: DynamoDB's `InternalServerError` and S3's `NoSuchKey` do not
 * end in `Exception`. `isPrototypeOf`, because `instanceof` is banned here too.
 */
function declaredBy(sdk: object, base: { prototype: object }): Set<string> {
  return new Set(
    Object.entries(sdk)
      .filter(
        ([, value]) =>
          typeof value === 'function' &&
          value !== base &&
          Object.prototype.isPrototypeOf.call(
            base.prototype,
            (value as { prototype: object }).prototype,
          ),
      )
      .map(([name]) => name),
  );
}

const declared = new Set([
  ...declaredBy(dynamodb, dynamodb.DynamoDBServiceException),
  ...declaredBy(s3, s3.S3ServiceException),
]);

const isKnown = (name: string): boolean => declared.has(name) || Object.hasOwn(DOCUMENTED, name);

/** `source` with its comments removed; the `[^:]` keeps `https://` from reading as one. */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/gm, '$1');
}

describe('the AWS error names this package acts on are declared or documented', () => {
  it('reads a real set of names from the SDKs, so an empty scan cannot pass', () => {
    expect(declared.has('ConditionalCheckFailedException')).toBe(true);
    expect(declared.has('NoSuchKey')).toBe(true);
    expect(declared.size).toBeGreaterThan(40);
  });

  it('holds no name in the classifier table that AWS neither declares nor documents', () => {
    expect(Object.keys(AWS_ERROR_CODES).filter((name) => !isKnown(name))).toEqual([]);
  });

  it('places every documented data-plane exception explicitly', () => {
    expect(DATA_PLANE_EXCEPTIONS.filter((name) => !declared.has(name))).toEqual([]);
    expect(DATA_PLANE_EXCEPTIONS.filter((name) => !Object.hasOwn(AWS_ERROR_CODES, name))).toEqual(
      [],
    );
  });

  it('retries only names that can arrive, and network codes', () => {
    expect(
      DEFAULT_RETRYABLE_ERRORS.filter(
        (name) => !isKnown(name) && !TRANSIENT_NETWORK_ERROR_CODES.includes(name),
      ),
    ).toEqual([]);
  });

  it.each(listSourceFiles().map((file) => [file] as const))(
    '%s names no …Exception AWS does not declare or document',
    (file) => {
      const named = [
        ...codeOnly(readFileSync(file, 'utf8')).matchAll(/\b([A-Z][A-Za-z]*Exception)\b/g),
      ]
        .map((match) => match[1])
        .filter((name) => name !== 'DynamoDBServiceException' && name !== 'S3ServiceException');
      expect(named.filter((name) => !isKnown(name))).toEqual([]);
    },
  );
});
