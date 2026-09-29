# Examples

These are demos against real AWS, not a test tier. Every script creates or
reuses a real DynamoDB table and makes real API calls, and two of them also
call Bedrock. Running them costs money — DynamoDB on-demand request charges
for all four, plus Bedrock model invocations for `live-store.mjs`
(embeddings) and `live-agent.mjs` (chat completions).

## Before you run one

```bash
npm ci
npm run build
```

Every example imports `../dist/esm/index.js`, the ES-module build, so the package must be built first.
Then, for each script:

- AWS credentials, resolved through the SDK's default credential chain
  (environment variables, a shared config/credentials file, an assumed role,
  IMDS, …). No credentials are read from `.env` or passed on the command line.
- `AWS_REGION` — required. `examples/_harness.mjs` reads it once for every
  script and exits immediately with `Set AWS_REGION before running this
  example.` if it is unset or empty.
- `LANGGRAPH_DEMO_TABLE` — optional. Overrides the table name a script
  creates. Unset, the checkpointer scripts (`live-checkpointer.mjs`,
  `live-persist.mjs`, `live-agent.mjs`) use `langgraph-saver-demo` and the
  store script (`live-store.mjs`) uses `langgraph-store-demo`. Setting it
  points *every* script at the same table name, so leave it unset to keep the
  saver and store demos in separate tables.

`live-store.mjs` and `live-agent.mjs` call Bedrock, so the account and region
you run them in also need access to the Bedrock models they use.

## The scripts

| Script | What it shows | AWS services | Leaves resources? | Clean up |
|---|---|---|---|---|
| `live-checkpointer.mjs` | Two independent `DynamoDBSaver` instances sharing state through one DynamoDB table: the second resumes what the first wrote, plus `getState`, full checkpoint history, time-travel to an older checkpoint by id, and `deleteThread` | DynamoDB | No — deletes the table it created when it finishes, also when the run fails; a table that already existed is left in place | Only if the delete itself fails: the script says so, and `aws dynamodb delete-table --table-name langgraph-saver-demo --region "$AWS_REGION"` removes it |
| `live-persist.mjs` | The same `DynamoDBSaver` persistence across two turns, left in place to inspect in the console | DynamoDB | Yes — table `langgraph-saver-demo` (or `$LANGGRAPH_DEMO_TABLE`) | `aws dynamodb delete-table --table-name langgraph-saver-demo --region "$AWS_REGION"` |
| `live-store.mjs` | `DynamoDBStore` semantic search: stores three items with Titan embeddings (`amazon.titan-embed-text-v2:0` via `BedrockEmbeddings`), then searches by meaning and prints the ranked scores | DynamoDB, Bedrock (embeddings) | Yes — table `langgraph-store-demo` (or `$LANGGRAPH_DEMO_TABLE`) | `aws dynamodb delete-table --table-name langgraph-store-demo --region "$AWS_REGION"` |
| `live-agent.mjs` | A real LangChain agent (`createAgent` with `ChatBedrockConverse`) whose only memory is `DynamoDBSaver`: session 1 tells it a fact, then a brand-new agent and saver in session 2 recall it, so a correct answer can only have come from DynamoDB | DynamoDB, Bedrock (chat model) | Yes — table `langgraph-saver-demo` (or `$LANGGRAPH_DEMO_TABLE`) | `aws dynamodb delete-table --table-name langgraph-saver-demo --region "$AWS_REGION"` |

`live-agent.mjs` sets its model id in the script itself (the `MODEL` constant
near the top) to `eu.anthropic.claude-haiku-4-5-20251001-v1:0`, an EU
cross-region inference profile. Outside the EU, edit `MODEL` to a model or
inference profile enabled in the region you run it in before running the
script.

Run any script with:

```bash
AWS_REGION=<region> node examples/<script>.mjs
```

or through its npm script, which builds the package first:

```bash
AWS_REGION=<region> npm run example:checkpointer   # or example:persist, example:store, example:agent
```

## Cleaning up

`live-checkpointer.mjs` deletes the table at the end, also after a failed run, only when it created it;
a table named through `LANGGRAPH_DEMO_TABLE` that already existed is left in
place, so it is yours to keep or remove. Otherwise there is nothing to clean up
afterwards, unless the delete itself failed, in which case the script says so. The other three leave their table in place so
you can inspect it in the DynamoDB console, and each names the command to
remove it in a comment at the top of its own file. Those commands, gathered
here:

```bash
aws dynamodb delete-table --table-name langgraph-saver-demo --region "$AWS_REGION"
aws dynamodb delete-table --table-name langgraph-store-demo --region "$AWS_REGION"
```

Substitute the table name you actually used if `LANGGRAPH_DEMO_TABLE` was
set.
