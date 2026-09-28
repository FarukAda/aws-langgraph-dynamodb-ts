# 26. Treat a reader-side limit as a refusal, not as payload loss

## Status

Accepted.

## Context

Two limits bound what a read may hold in memory: `s3.maxDownloadBytes` for an
offloaded object and `compression.maxDecompressedBytes` for a gunzipped
payload. Neither was checked when writing, so an adapter could store a
payload no reader configured like itself would open — an upload larger than
its own download cap, a compressed payload that inflates past its own
decompression cap — and nothing said so until a read failed. Record 12 then
counted a decompression-guard trip among the losses `onCorruptMessage: 'skip'`
drops, reported only to a logger that is silent by default, although the
payload is intact and a reader with a larger cap reads it.

## Decision

The writer never produces what its own reader would refuse. A payload larger
than `compression.maxDecompressedBytes` is stored uncompressed (`compress`,
`src/shared/codec/compression.ts`); an offloaded payload larger than
`s3.maxDownloadBytes` is refused with `VALIDATION` naming `payload` before it
is uploaded (`S3Offloader.upload`); and a configuration whose
`s3.maxDownloadBytes` is below its `s3.thresholdBytes` — one that could offload
nothing it could read back — is refused at construction. On the read side,
`COMPRESSION_LIMIT` is a refusal by this reader, not the payload's loss:
`isPermanentPayloadLoss` no longer includes it, so `getMessages` fails the
read under both policies, as it already did for an object over the download
cap. Record 12 is amended accordingly.

## Consequences

Positive. A write that succeeded is readable by every reader configured like
the writer, and a reader whose caps are lower than a payload is told so
instead of silently shortening a conversation.

Negative. A reader configured with lower caps than a writer cannot read that
writer's large payloads until its caps are raised, and under `'skip'` that is
now a failed read instead of a missing message. A payload between the
decompression cap and the download cap is stored uncompressed and costs its
full size.

Neutral. The caps and their defaults are unchanged.
