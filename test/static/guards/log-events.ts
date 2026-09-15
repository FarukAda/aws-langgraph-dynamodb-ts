import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import * as ts from 'typescript';

import { listSourceFiles, SRC_ROOT } from './source-files';

/** One `logger.<level>(message, …)` call site: its level, the literal part of its message, and the fields it attaches. */
export interface LogEvent {
  level: 'info' | 'warn' | 'error';
  message: string;
  /** The field names of the structured argument, or undefined when they cannot be read statically. */
  fields?: readonly string[];
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

/**
 * The field names a structured log argument attaches, or undefined when the
 * call does not pass a plain object literal — a spread cannot be resolved here,
 * and guessing would document a field the code may not emit.
 */
function fieldsOf(node: ts.Expression | undefined): readonly string[] | undefined {
  if (node === undefined || !ts.isObjectLiteralExpression(node)) return undefined;
  const names: string[] = [];
  for (const property of node.properties) {
    if (ts.isShorthandPropertyAssignment(property)) names.push(property.name.text);
    else if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)) {
      names.push(property.name.text);
    } else return undefined;
  }
  return names;
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
      const fields = fieldsOf(node.arguments[1]);
      events.push({
        level: node.expression.name.text as LogEvent['level'],
        message,
        ...(fields === undefined ? {} : { fields }),
      });
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

/** An event whose documented field list disagrees with the one the code attaches. */
export interface FieldMismatch {
  message: string;
  emitted: readonly string[];
  documented: readonly string[];
}

/** The ```-quoted identifiers of a table cell, in order. */
function quotedNames(cell: string): string[] {
  return [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
}

/** The README table row that quotes `message`, or undefined when none does. */
function rowFor(section: string, message: string): string | undefined {
  const quoted = message.trim().slice(0, QUOTED_PREFIX);
  return section.split('\n').find((line) => line.startsWith('|') && line.includes(quoted));
}

/**
 * The events whose Fields column does not name exactly what the call attaches.
 *
 * Checking the message alone let four rows drift: fields that were never
 * emitted stayed listed, and emitted ones stayed missing. An operator reads
 * that column to build an alert, so a wrong one is a defect, not a typo.
 */
export function misdocumentedFields(section: string, events: readonly LogEvent[]): FieldMismatch[] {
  const mismatches: FieldMismatch[] = [];
  for (const event of events) {
    if (event.fields === undefined) continue;
    const row = rowFor(section, event.message);
    if (row === undefined) continue;
    const documented = quotedNames(row.split('|')[3] ?? '');
    const emitted = [...event.fields].sort();
    if (JSON.stringify([...documented].sort()) !== JSON.stringify(emitted)) {
      mismatches.push({ message: event.message, emitted, documented });
    }
  }
  return mismatches;
}

/** An event whose documented level disagrees with the one the call emits. */
export interface LevelMismatch {
  message: string;
  emitted: string;
  documented: string;
}

/**
 * The events whose Level column names a different level than the call emits.
 *
 * The level is what an operator alerts on: a row documenting `info` for an
 * event emitted at `warn` sends them looking in the wrong place, or builds an
 * alert that never fires. Checking it costs one column and closes the last of
 * the three things a row promises.
 */
export function mislevelledEvents(section: string, events: readonly LogEvent[]): LevelMismatch[] {
  const mismatches: LevelMismatch[] = [];
  for (const event of events) {
    const row = rowFor(section, event.message);
    if (row === undefined) continue;
    const documented = quotedNames(row.split('|')[1] ?? '')[0] ?? '';
    if (documented !== event.level) {
      mismatches.push({ message: event.message, emitted: event.level, documented });
    }
  }
  return mismatches;
}
