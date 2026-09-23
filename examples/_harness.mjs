/**
 * The configuration every live example needs, read once. An example that
 * quietly picked a region would create a table somewhere the reader did not
 * choose, so a missing value stops the example and says which one.
 */
export function required(name) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    console.error(`Set ${name} before running this example.`);
    process.exit(1);
  }
  return value;
}

export const REGION = required('AWS_REGION');
