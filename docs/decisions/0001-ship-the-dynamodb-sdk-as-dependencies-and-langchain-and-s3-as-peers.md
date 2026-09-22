# 1. Ship the DynamoDB SDK as dependencies, LangChain and S3 as peers

## Status

Accepted.

## Context

This package wraps DynamoDB behind three LangGraph and LangChain integration
points — a checkpointer, a store and a chat-message history — and offers an
optional S3 offload for payloads too large for a DynamoDB item. Each
collaborator it takes from the host application falls into one of two
categories, and the two need opposite treatment.

Some collaborators are checked by class identity. `@langchain/core` supplies
the base classes this package's adapters extend and the types a caller's own
code constructs; if the host application and this package each resolved a
different copy, a value built by one side would not be an instance the other
recognises. `@langchain/langgraph-checkpoint` supplies the serializer
protocol the checkpointer's default `serde` implements, for the same reason.
Other collaborators are checked structurally instead: an injected DynamoDB
`client` is validated against `DynamoDBDocumentLike`, a type naming the eight
methods this package calls, not against the SDK's own class, precisely so
the check still holds when the application and this package end up with two
copies of the AWS SDK in the tree — a duplicate copy there costs bundle
size, not correctness. A third force sits underneath both: most applications
never configure S3 offload at all, and the S3 client is comparatively heavy
to force on every install.

## Decision

We declare `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb` and
`@aws-sdk/util-dynamodb` as ordinary `dependencies`, and `@langchain/core`,
`@langchain/langgraph-checkpoint` and `@aws-sdk/client-s3` as
`peerDependencies`, with the S3 package marked optional in
`peerDependenciesMeta`. A module whose declarations ship publicly never
imports the S3 peer, enforced by `test/static/optional-peer.test.ts`, and
the S3 client is loaded through a dynamic `import()` on first use, so
constructing an adapter without S3 configured never touches it.

## Consequences

Positive. The DynamoDB SDK installs with no extra step, and because this
package's own DynamoDB collaborators are checked by shape rather than by
class, a consumer pinned to a different SDK version still works correctly.
`@langchain/core` and `@langchain/langgraph-checkpoint` stay single-instance
across the application and this package, which is the property that
actually needs a peer declaration. An application that never configures S3
installs nothing for it.

Negative. A consumer on an older `@aws-sdk/client-dynamodb` still ends up
with two copies of that SDK installed, a bundle-size cost this decision
accepts rather than removes. An application that does configure S3 must
install the peer itself, and a bundler that lacks it must mark `@aws-sdk/*`
external or the build fails.

Neutral. This is not "AWS SDK as dependency, everything else as peer": it
tracks whether a collaborator is checked by class or by shape. A sibling
project also makes its AWS SDK a peer, because a duplicated copy there gives
a caller's injected client its own credential chain and configuration; this
package's DynamoDB collaborators are checked structurally instead, so which
copy of the SDK built the client does not change how it is used.
