/**
 * DynamoDB filter expression builder utilities
 */

import { FilterValue } from '../types';

const SUPPORTED_OPERATORS = ['$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin'] as const;

/**
 * Maximum array size for `$in` / `$nin` operators.
 *
 * DynamoDB caps the total ExpressionAttributeValues count at 100 per expression
 * and condition-/filter-expression length at 4 KB. 50 items per list keeps headroom
 * for other conditions in the same expression and produces predictable error
 * messages instead of the opaque `ValidationException` DynamoDB returns when the
 * expression limits are breached.
 */
const MAX_IN_LIST_SIZE = 50;

/**
 * Soft cap on the assembled FilterExpression string length. DynamoDB rejects
 * expressions longer than 4 KiB with a `ValidationException`. We check at 3.5 KiB
 * so we trip a clean, client-side error with actionable guidance before the
 * request burns a round trip.
 */
const MAX_FILTER_EXPRESSION_BYTES = 3.5 * 1024;

/**
 * Build DynamoDB filter expression from a filter object
 *
 * @param filter - Filter criteria object with field names and values
 * @param expressionAttributeNames - Object to populate with attribute name mappings
 * @param expressionAttributeValues - Object to populate with attribute value mappings
 * @returns Object containing the constructed filter expression
 */
export function buildFilterExpression(
  filter: Record<string, FilterValue | any>,
  expressionAttributeNames: Record<string, string>,
  expressionAttributeValues: Record<string, any>,
): {
  filterExpression: string;
} {
  const filterExpressions: string[] = [];
  let nameCounter = Object.keys(expressionAttributeNames).length;
  let valueCounter = Object.keys(expressionAttributeValues).length;

  // Add #value for nested access if not present
  if (!expressionAttributeNames['#value']) {
    expressionAttributeNames['#value'] = 'value';
  }

  for (const [fieldKey, fieldValue] of Object.entries(filter)) {
    const attrName = `#attr${nameCounter++}`;
    const valuePath = `#value.${attrName}`;
    expressionAttributeNames[attrName] = fieldKey;

    // Handle operator-based filtering
    if (typeof fieldValue === 'object' && fieldValue !== null && !Array.isArray(fieldValue)) {
      // Surface typos / unsupported operators rather than silently dropping the filter
      const unknownOps = Object.keys(fieldValue).filter(
        (k) => !(SUPPORTED_OPERATORS as readonly string[]).includes(k),
      );
      if (unknownOps.length > 0) {
        throw new Error(
          `Unsupported filter operator(s) for field "${fieldKey}": ${unknownOps.join(', ')}. ` +
            `Supported: ${SUPPORTED_OPERATORS.join(', ')}`,
        );
      }

      if (fieldValue.$eq !== undefined) {
        const valueKey = `:val${valueCounter++}`;
        expressionAttributeValues[valueKey] = fieldValue.$eq;
        filterExpressions.push(`${valuePath} = ${valueKey}`);
      }

      if (fieldValue.$ne !== undefined) {
        const valueKey = `:val${valueCounter++}`;
        expressionAttributeValues[valueKey] = fieldValue.$ne;
        filterExpressions.push(`${valuePath} <> ${valueKey}`);
      }

      if (fieldValue.$gt !== undefined) {
        const valueKey = `:val${valueCounter++}`;
        expressionAttributeValues[valueKey] = fieldValue.$gt;
        filterExpressions.push(`${valuePath} > ${valueKey}`);
      }

      if (fieldValue.$gte !== undefined) {
        const valueKey = `:val${valueCounter++}`;
        expressionAttributeValues[valueKey] = fieldValue.$gte;
        filterExpressions.push(`${valuePath} >= ${valueKey}`);
      }

      if (fieldValue.$lt !== undefined) {
        const valueKey = `:val${valueCounter++}`;
        expressionAttributeValues[valueKey] = fieldValue.$lt;
        filterExpressions.push(`${valuePath} < ${valueKey}`);
      }

      if (fieldValue.$lte !== undefined) {
        const valueKey = `:val${valueCounter++}`;
        expressionAttributeValues[valueKey] = fieldValue.$lte;
        filterExpressions.push(`${valuePath} <= ${valueKey}`);
      }

      if (fieldValue.$in !== undefined) {
        if (!Array.isArray(fieldValue.$in) || fieldValue.$in.length === 0) {
          throw new Error(`$in operator for "${fieldKey}" requires a non-empty array`);
        }
        if (fieldValue.$in.length > MAX_IN_LIST_SIZE) {
          throw new Error(
            `$in operator for "${fieldKey}" supports at most ${MAX_IN_LIST_SIZE} values ` +
              `(got ${fieldValue.$in.length}). Split the query or narrow the filter.`,
          );
        }
        const placeholders = fieldValue.$in.map((v: unknown) => {
          const valueKey = `:val${valueCounter++}`;
          expressionAttributeValues[valueKey] = v;
          return valueKey;
        });
        filterExpressions.push(`${valuePath} IN (${placeholders.join(', ')})`);
      }

      if (fieldValue.$nin !== undefined) {
        if (!Array.isArray(fieldValue.$nin) || fieldValue.$nin.length === 0) {
          throw new Error(`$nin operator for "${fieldKey}" requires a non-empty array`);
        }
        if (fieldValue.$nin.length > MAX_IN_LIST_SIZE) {
          throw new Error(
            `$nin operator for "${fieldKey}" supports at most ${MAX_IN_LIST_SIZE} values ` +
              `(got ${fieldValue.$nin.length}). Split the query or narrow the filter.`,
          );
        }
        const placeholders = fieldValue.$nin.map((v: unknown) => {
          const valueKey = `:val${valueCounter++}`;
          expressionAttributeValues[valueKey] = v;
          return valueKey;
        });
        filterExpressions.push(`NOT (${valuePath} IN (${placeholders.join(', ')}))`);
      }
    } else {
      // Direct equality comparison
      const valueKey = `:val${valueCounter++}`;
      expressionAttributeValues[valueKey] = fieldValue;
      filterExpressions.push(`${valuePath} = ${valueKey}`);
    }
  }

  const joined = filterExpressions.length > 0 ? filterExpressions.join(' AND ') : '';

  // Byte length — DynamoDB counts expression size in UTF-8 bytes, not JS code units.
  const byteLength = Buffer.byteLength(joined, 'utf8');
  if (byteLength > MAX_FILTER_EXPRESSION_BYTES) {
    throw new Error(
      `Filter expression is ${byteLength} bytes, exceeds DynamoDB's 4 KiB limit ` +
        `(checked against a ${MAX_FILTER_EXPRESSION_BYTES}-byte soft cap). ` +
        `Simplify the filter: fewer fields, shorter names, or drop deep nested paths.`,
    );
  }

  return {
    filterExpression: joined,
  };
}
