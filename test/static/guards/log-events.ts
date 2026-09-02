import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import * as ts from 'typescript';

import { listSourceFiles, SRC_ROOT } from './source-files';

/** One `logger.<level>(message, …)` call site: its level and the literal part of its message. */
export interface LogEvent {
  level: 'info' | 'warn' | 'error';
  message: string;
}

const LEVELS: readonly LogEvent['level'][] = ['info', 'warn', 'error'];

/**
 * The literal text a message expression is guaranteed to contain: a string
 * literal as is, the leftmost literal of a `+` chain, and for a template the
 * head text or, when the message starts with a placeholder, the first literal
 * span after it.
 */
function literalPart(node: ts.Expression): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return literalPart(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return literalPart(node.left);
  }
  if (ts.isTemplateExpression(node)) {
    return node.head.text !== '' ? node.head.text : node.templateSpans[0]?.literal.text;
  }
  return undefined;
}

/** Every info/warn/error event `source` emits through a `logger` property or variable. */
export function logEventsIn(source: string): LogEvent[] {
  const file = ts.createSourceFile('probe.ts', source, ts.ScriptTarget.Latest, true);
  const events: LogEvent[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      LEVELS.includes(node.expression.name.text as LogEvent['level']) &&
      node.expression.expression.getText(file).endsWith('logger') &&
      node.arguments.length > 0
    ) {
      const message = literalPart(node.arguments[0]);
      if (message === undefined)
        throw new Error(`log message is not a literal: ${node.getText(file)}`);
      events.push({ level: node.expression.name.text as LogEvent['level'], message });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return events;
}

/** Every info/warn/error event the library can emit, from all of `src`. */
export function logEvents(): LogEvent[] {
  return listSourceFiles().flatMap((file) => logEventsIn(readFileSync(file, 'utf8')));
}

/** The README's Logging section. */
export function readmeLoggingSection(): string {
  const readme = readFileSync(resolve(SRC_ROOT, '..', 'README.md'), 'utf8');
  const start = readme.indexOf('## Logging');
  if (start < 0) throw new Error('README has no Logging section');
  const rest = readme.slice(start + 1);
  const end = rest.search(/\n## /);
  return end < 0 ? rest : rest.slice(0, end);
}

/** How much of a message the README must quote: enough to identify it, not a whole multi-line literal. */
const QUOTED_PREFIX = 40;

/** The events whose message (its first characters, or all of a short one) the README section does not quote. */
export function undocumentedEvents(section: string, events: readonly LogEvent[]): LogEvent[] {
  return events.filter((event) => !section.includes(event.message.trim().slice(0, QUOTED_PREFIX)));
}
