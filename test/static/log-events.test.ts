import {
  logEvents,
  logEventsIn,
  misdocumentedFields,
  mislevelledEvents,
  readmeLoggingSection,
  undocumentedEvents,
} from './guards/log-events';

describe('logEventsIn', () => {
  it('extracts the literal part of every logger call whatever the message shape', () => {
    const source = [
      "context.logger.warn('plain message', { a: 1 });",
      "logger.error('left part ' + 'right part', {});",
      'options.logger.info(`${operation}: deleted rows`, { deleted });',
      'logger.warn(`head ${x} tail`);',
      "logger.debug('ignored');",
      "other.warn('not a logger');",
    ].join('\n');
    expect(logEventsIn(source)).toEqual([
      { level: 'warn', message: 'plain message', fields: ['a'] },
      { level: 'error', message: 'left part ', fields: [] },
      { level: 'info', message: ': deleted rows', fields: ['deleted'] },
      /** No structured argument at all, so there are no fields to document. */
      { level: 'warn', message: 'head ' },
    ]);
  });

  it('refuses a message that is not a literal, so every event stays documentable', () => {
    expect(() => logEventsIn('logger.warn(message)')).toThrow(/not a literal/);
  });
});

describe('undocumentedEvents', () => {
  it('reports the events whose message text the section lacks', () => {
    const events = [
      { level: 'warn' as const, message: 'known' },
      { level: 'error' as const, message: 'unknown' },
    ];
    expect(undocumentedEvents('| warn | `known` |', events)).toEqual([events[1]]);
  });
});

describe('the README Logging section (CORE-08, DOCS-06)', () => {
  it('documents every info, warn and error event the code emits', () => {
    const events = logEvents();
    expect(events.length).toBeGreaterThan(10);
    expect(undocumentedEvents(readmeLoggingSection(), events)).toEqual([]);
  });
});

describe('the README Logging section names the right fields (DOCS-07)', () => {
  it('documents exactly the fields each event attaches', () => {
    expect(misdocumentedFields(readmeLoggingSection(), logEvents())).toEqual([]);
  });

  it('reports a row that lists a field the call never attaches', () => {
    const events = logEventsIn("logger.warn('probe event', { a: 1 });");
    const section = '| `warn` | `probe event` | `a`, `b` | meaning |';
    expect(misdocumentedFields(section, events)).toEqual([
      { message: 'probe event', emitted: ['a'], documented: ['a', 'b'] },
    ]);
  });

  it('accepts a row that matches, whatever the order', () => {
    const events = logEventsIn("logger.warn('probe event', { b: 1, a: 2 });");
    const section = '| `warn` | `probe event` | `a`, `b` | meaning |';
    expect(misdocumentedFields(section, events)).toEqual([]);
  });
});

describe('the README Logging section names the right level (DOCS-07)', () => {
  it('documents the level each event is emitted at', () => {
    expect(mislevelledEvents(readmeLoggingSection(), logEvents())).toEqual([]);
  });

  it('reports a row whose level is not the one the call uses', () => {
    const events = logEventsIn("logger.warn('probe event', { a: 1 });");
    expect(mislevelledEvents('| `info` | `probe event` | `a` | meaning |', events)).toEqual([
      { message: 'probe event', emitted: 'warn', documented: 'info' },
    ]);
  });

  it('ignores an event the section does not document at all', () => {
    const events = logEventsIn("logger.warn('probe event', { a: 1 });");
    expect(mislevelledEvents('| `warn` | `other event` | `a` | meaning |', events)).toEqual([]);
  });
});
