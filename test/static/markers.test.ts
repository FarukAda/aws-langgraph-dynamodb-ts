import { markers, markersIn } from './guards/markers';

describe('markersIn', () => {
  it('flags TODO, FIXME, XXX and HACK wherever they sit', () => {
    const source = ['/** TODO later */', 'const a = 1; // FIXME', ' * XXX', ' * HACK: x'].join(
      '\n',
    );
    expect(markersIn(source, 'a.ts').map((hit) => hit.text)).toEqual([
      'TODO',
      'FIXME',
      'XXX',
      'HACK',
    ]);
  });

  it('leaves a marker quoted from another project alone', () => {
    expect(markersIn(' * with the note "TODO: … upstream"', 'a.ts')).toEqual([]);
  });

  it('does not match a marker inside a longer word', () => {
    expect(markersIn('const TODOS = 1; const hacky = 2;', 'a.ts')).toEqual([]);
  });
});

describe('the actual tree', () => {
  /**
   * A marker is a promise nobody is tracking. Fix the thing, or state plainly
   * that it is broken where it is broken (rules 73-74); do not leave a marker.
   */
  it('holds no marker', () => {
    expect(markers()).toEqual([]);
  });
});
