import { decisionRecords, indexedRecordFiles, RECORD_STATUSES } from './guards/decision-records';

/**
 * A record is read instead of reconstructing reasoning from code that does not
 * contain it. That works only if every record answers the same questions in
 * the same places and the numbering can be trusted. These checks are
 * syntactic: they cannot judge a decision, only its shape.
 */
describe('every decision record has the shape a reader can rely on', () => {
  it('finds the records to check, so a broken scan cannot pass silently', () => {
    expect(decisionRecords().length).toBeGreaterThanOrEqual(5);
  });

  it.each(decisionRecords().map((record) => [record.file, record] as const))(
    '%s carries a title, status, context, decision and consequences',
    (_label, record) => {
      expect(record.text.startsWith(`# ${record.number}. `)).toBe(true);
      for (const section of ['## Status', '## Context', '## Decision', '## Consequences']) {
        expect(record.text).toContain(section);
      }
    },
  );

  it.each(decisionRecords().map((record) => [record.file, record] as const))(
    '%s names all three kinds of consequence',
    (_label, record) => {
      const consequences = record.text.slice(record.text.indexOf('## Consequences'));
      for (const kind of ['Positive', 'Negative', 'Neutral']) expect(consequences).toContain(kind);
    },
  );

  it.each(decisionRecords().map((record) => [record.file, record] as const))(
    '%s carries a status the index can render',
    (_label, record) => {
      expect(RECORD_STATUSES).toContain(/## Status\s*\n\s*\n([A-Za-z]+)/.exec(record.text)?.[1]);
    },
  );

  it('numbers the records sequentially from one, with none reused', () => {
    expect(decisionRecords().map((record) => record.number)).toEqual(
      decisionRecords().map((_record, index) => index + 1),
    );
  });

  it('lists every record in the index, and nothing that is not there', () => {
    expect([...indexedRecordFiles()].sort()).toEqual(
      decisionRecords()
        .map((record) => record.file)
        .sort(),
    );
  });
});
