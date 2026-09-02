import {
  logEvents,
  logEventsIn,
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
      { level: 'warn', message: 'plain message' },
      { level: 'error', message: 'left part ' },
      { level: 'info', message: ': deleted rows' },
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
