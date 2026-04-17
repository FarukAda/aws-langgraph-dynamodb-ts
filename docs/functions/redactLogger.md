[**AWS LangGraph DynamoDB TypeScript v0.2.0**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / redactLogger

# Function: redactLogger()

> **redactLogger**(`inner`, `options?`): [`Logger`](../interfaces/Logger.md)

Defined in: [shared/utils/logger.ts:162](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/309842e8e569d78757523036e9b5315c5dae8193/src/shared/utils/logger.ts#L162)

Wrap an existing logger with automatic secret redaction applied to the
variadic args (the message string itself is passed through unchanged — don't
interpolate secrets into messages). Strings in args are left as-is; only
object properties whose keys match a secret pattern are replaced.

## Parameters

### inner

[`Logger`](../interfaces/Logger.md)

Logger to wrap

### options?

#### extraKeys?

readonly `string`[]

Additional lower-cased substrings to treat as secret keys

## Returns

[`Logger`](../interfaces/Logger.md)

## Example

```ts
import { setGlobalLogger, redactLogger, getLogger } from '@farukada/aws-langgraph-dynamodb-ts';
setGlobalLogger(redactLogger(getLogger()));
```
