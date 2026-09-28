[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / ErrorDetailsFor

# Type Alias: ErrorDetailsFor\<C\>

> **ErrorDetailsFor**\<`C`\> = `C` *extends* keyof [`ErrorDetailsByCode`](../interfaces/ErrorDetailsByCode.md) ? [`ErrorDetailsByCode`](../interfaces/ErrorDetailsByCode.md)\[`C`\] : `undefined`

Defined in: [shared/errors/base-error.ts:96](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L96)

The details a code carries; `undefined` for every code not in [ErrorDetailsByCode](../interfaces/ErrorDetailsByCode.md).

## Type Parameters

### C

`C` *extends* [`ErrorCode`](../enumerations/ErrorCode.md)
