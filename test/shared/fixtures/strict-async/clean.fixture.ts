/** Run only by the strict-async environment's end-to-end test, never by the unit tier. */
it('does nothing wrong', () => {
  expect(true).toBe(true);
});
