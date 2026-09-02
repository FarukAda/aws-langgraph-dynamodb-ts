import { actionsUsedBy, documentedActions, readReadme, usedActions } from './guards/iam-actions';

describe('actionsUsedBy', () => {
  it('maps DocumentClient methods and S3 commands to IAM actions, transactions to their item actions', () => {
    expect(
      actionsUsedBy(
        'await client.get({}); await client.transactWrite({}); client.send(new PutObjectCommand({}));',
      ),
    ).toEqual([
      'dynamodb:DeleteItem',
      'dynamodb:GetItem',
      'dynamodb:PutItem',
      'dynamodb:UpdateItem',
      's3:PutObject',
    ]);
  });

  it('refuses an unmapped method or command so a new call site must be documented', () => {
    expect(() => actionsUsedBy('client.executeStatement({})')).toThrow(
      /unmapped DocumentClient method/,
    );
    expect(() => actionsUsedBy('new HeadObjectCommand({})')).toThrow(/unmapped S3 command/);
  });
});

describe('documentedActions', () => {
  it('collects the quoted actions from every policy block of the IAM section only', () => {
    const readme = [
      '## IAM permissions',
      '```json',
      '{ "Action": ["dynamodb:GetItem", "dynamodb:Query"] }',
      '```',
      '{ "Action": ["s3:GetObject"], "Condition": { "dynamodb:LeadingKeys": ["x"] } }',
      '## Next',
      '"dynamodb:Scan"',
    ].join('\n');
    expect(documentedActions(readme)).toEqual([
      'dynamodb:GetItem',
      'dynamodb:Query',
      's3:GetObject',
    ]);
    expect(() => documentedActions('nothing')).toThrow(/no IAM permissions section/);
  });
});

describe('the README IAM section (SEC-01, SEC-02)', () => {
  it('grants exactly the DynamoDB and S3 actions the code uses', () => {
    expect(documentedActions(readReadme())).toEqual(usedActions());
  });
});
