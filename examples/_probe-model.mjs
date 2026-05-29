import { ChatBedrockConverse } from '@langchain/aws';

const candidates = [
  'eu.anthropic.claude-haiku-4-5-20251001-v1:0',
  'eu.anthropic.claude-3-haiku-20240307-v1:0',
  'anthropic.claude-3-haiku-20240307-v1:0',
  'eu.anthropic.claude-sonnet-4-5-20250929-v1:0',
  'anthropic.claude-3-sonnet-20240229-v1:0',
];

for (const model of candidates) {
  try {
    const llm = new ChatBedrockConverse({ model, region: 'eu-west-1', temperature: 0 });
    const res = await llm.invoke('Reply with exactly: OK');
    console.log(`WORKS: ${model} -> ${JSON.stringify(res.content).slice(0, 60)}`);
    process.exit(0);
  } catch (e) {
    console.log(`fail: ${model} -> ${e.name}: ${String(e.message).slice(0, 90)}`);
  }
}
console.log('NONE worked');
process.exit(1);
