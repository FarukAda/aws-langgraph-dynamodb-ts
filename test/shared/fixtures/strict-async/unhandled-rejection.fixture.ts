/** Run only by the strict-async environment's end-to-end test, never by the unit tier. */
it('leaves a rejection unhandled', () => {
  void Promise.reject(new Error('fixture rejection'));
});
