/**
 * DynamoDB filter expression builder utilities
 */

import { FilterValue } from '../types';

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
    } else {
      // Direct equality comparison
      const valueKey = `:val${valueCounter++}`;
      expressionAttributeValues[valueKey] = fieldValue;
      filterExpressions.push(`${valuePath} = ${valueKey}`);
    }
  }

  return {
    filterExpression: filterExpressions.length > 0 ? filterExpressions.join(' AND ') : '',
  };
}
