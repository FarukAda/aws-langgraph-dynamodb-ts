try {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-expect-error
  import('jsonpath/include/module.js');
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-expect-error
  import('jsonpath/include/action.js');
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-expect-error
  import('esprima');
// eslint-disable-next-line @typescript-eslint/no-unused-vars
} catch (e) {
  // Ignore if not present
}