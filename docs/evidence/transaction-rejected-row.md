# The rejected row's shape on a `TransactWriteItems` cancellation

Run conditions: run 1 in [`README.md`](./README.md).

## E-4: `CancellationReasons[].Item` through `DynamoDBDocument` is raw, unmarshalled `AttributeValue` data

**Request (`Put` side)** — write a row mixing attribute types (`N`, `S`, `L`, `M`);
send a one-item `transactWrite` `Put` with `ConditionExpression:
'attribute_not_exists(PK)'` and `ReturnValuesOnConditionCheckFailure: 'ALL_OLD'`
against it; capture a plain `PutCommand` rejection against the same row for
comparison.

**Response**

```
{
  "name": "TransactionCanceledException",
  "message": "Transaction cancelled, please refer cancellation reasons for specific reasons [ConditionalCheckFailed]",
  "CancellationReasons": [
    {
      "Item": {
        "rev":    { "N": "7" },
        "nested": { "M": { "n": { "N": "1" } } },
        "SK":     { "S": "row" },
        "note":   { "S": "old" },
        "PK":     { "S": "l4" },
        "tags":   { "L": [ { "S": "a" }, { "S": "b" } ] }
      },
      "Code": "ConditionalCheckFailed",
      "Message": "The conditional request failed"
    }
  ]
}

control (PutCommand rejection) Item: {"nested":{"M":{"n":{"N":"1"}}},"PK":{"S":"l4"},"rev":{"N":"7"},"SK":{"S":"row"},"tags":{"L":[{"S":"a"},{"S":"b"}]},"note":{"S":"old"}}
```

**Request (`Delete` side)** — a transactional `Delete` guarded by a revision
condition that a row does not satisfy.

**Response**

```
CancellationReasons: [{"Item":{"rev":{"S":"R1"},"SK":{"S":"d3"},"note":{"S":"x"},"PK":{"S":"p"},"v":{"N":"7"}},"Code":"ConditionalCheckFailed"}]
```

Both are raw attribute values, nested maps and lists intact — `typeof item.rev` is
`{"N":"7"}`, never `7`.

**What this settles.** The document client unmarshalls a *response* but not an
*error payload*: a row attached to a `TransactWriteItems` cancellation reason
arrives in DynamoDB's own attribute-value shape, byte-identical to what the same
client leaves on a plain `PutCommand`/`DeleteCommand` rejection's `Item`. That
identity is why a rejected row needs exactly one unmarshalling path with two
places to look (the error's own `Item`, or the cancellation reason's), rather than
two decoders that could drift apart. It holds for both a `Put` and a `Delete`
inside a transaction.

Also confirmed incidentally: `ReturnValuesOnConditionCheckFailure: 'ALL_OLD'` is
honoured on a transaction item by real AWS, and a one-item transaction's
`CancellationReasons` carries exactly one entry with `Code: 'ConditionalCheckFailed'`.

**What the probe did not cover.** A transaction with more than one item, where
`CancellationReasons` carries an entry per item and most of them are `Code: 'None'`
— only the single-item shape this package ever sends was probed.
