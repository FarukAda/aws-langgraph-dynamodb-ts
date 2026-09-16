import { planReferences, planReferencesIn } from './guards/plan-references';

describe('planReferencesIn', () => {
  it('flags a Ruling followed by a number', () => {
    expect(planReferencesIn('// Ruling 13 says otherwise', 'a.ts')).toEqual([
      { file: 'a.ts', line: 1, text: 'Ruling 13' },
    ]);
  });

  it('flags "fix round", case-insensitively, wherever it sits on the line', () => {
    expect(planReferencesIn("it('does x (Fix Round 2)', () => {})", 'a.ts')).toEqual([
      { file: 'a.ts', line: 1, text: 'Fix Round' },
    ]);
  });

  it('flags "task brief" and "brief" used as a noun for a plan document', () => {
    const source = [
      '// which the task brief forbids',
      "// Per the brief's implementer note",
      '// verified against the brief',
    ].join('\n');
    expect(planReferencesIn(source, 'a.ts').map((hit) => hit.line)).toEqual([1, 2, 3]);
  });

  it('does not flag "brief" used as an ordinary adjective', () => {
    expect(planReferencesIn('/** Waits a brief moment. */', 'a.ts')).toEqual([]);
  });

  it('flags a plan task id and a numbered plan task', () => {
    const source = ['// see P2.3 for context', '// Task 9 needs this first'].join('\n');
    expect(planReferencesIn(source, 'a.ts').map((hit) => hit.text)).toEqual(['P2.3', 'Task 9']);
  });

  it('flags a design-decision id only on a comment line', () => {
    const source = ['/** D1 is stricter than truthiness. */', "const x = 'D1';"].join('\n');
    expect(planReferencesIn(source, 'a.ts')).toEqual([{ file: 'a.ts', line: 1, text: 'D1' }]);
  });

  it('does not flag a call passing the string D1 as test data in code', () => {
    expect(planReferencesIn("checkpoint('cp-1', 'D1')", 'a.ts')).toEqual([]);
  });

  it('does not flag `new AbortController()` assigned to a variable named controller', () => {
    expect(planReferencesIn('const controller = new AbortController();', 'a.ts')).toEqual([]);
  });

  it("does not flag this repository's audit finding ids", () => {
    const source = ['// (H-10)', '// DDB-09', '// CORE-22'].join('\n');
    expect(planReferencesIn(source, 'a.ts')).toEqual([]);
  });

  it('reports the 1-based line of a hit past the first line', () => {
    expect(planReferencesIn('const a = 1;\n// fix round 2', 'a.ts')).toEqual([
      { file: 'a.ts', line: 2, text: 'fix round' },
    ]);
  });

  it('flags a numbered plan task written with a hyphen or underscore after capital Task', () => {
    const source = ['// Task-3 fix', '// Task_3 fix'].join('\n');
    expect(planReferencesIn(source, 'a.ts').map((hit) => hit.text)).toEqual(['Task-3', 'Task_3']);
  });

  it('flags lowercase "task" followed by a space then digits', () => {
    expect(planReferencesIn('// task 9 needs this', 'a.ts')).toEqual([
      { file: 'a.ts', line: 1, text: 'task 9' },
    ]);
  });

  it('does not flag lowercase task-N or task_N used as ordinary id data', () => {
    const source = ["const a = 'task-1';", "const b = 'task_1';"].join('\n');
    expect(planReferencesIn(source, 'a.ts')).toEqual([]);
  });

  it('flags Ruling case-insensitively, with an optional plural and no required space', () => {
    const source = ['// ruling 13', '// Ruling13', '// Rulings 13 and 14'].join('\n');
    expect(planReferencesIn(source, 'a.ts').map((hit) => hit.text)).toEqual([
      'ruling 13',
      'Ruling13',
      'Rulings 13',
    ]);
  });

  it('flags "fix round" separated by a hyphen or underscore', () => {
    const source = ['// fix-round 2', '// Fix_Round 2'].join('\n');
    expect(planReferencesIn(source, 'a.ts').map((hit) => hit.text)).toEqual([
      'fix-round',
      'Fix_Round',
    ]);
  });

  it('flags "see brief" and "per brief"', () => {
    const source = ['// see brief for detail', '// per brief, do X'].join('\n');
    expect(planReferencesIn(source, 'a.ts').map((hit) => hit.line)).toEqual([1, 2]);
  });

  it('flags a two-digit plan task id', () => {
    expect(planReferencesIn('// see P2.10', 'a.ts')).toEqual([
      { file: 'a.ts', line: 1, text: 'P2.10' },
    ]);
  });

  it('does not flag legitimate BatchWriteItem retry-round prose', () => {
    const source = [
      '// Round 1: 5 items in, 3 persist (a,b,c), 2 (d,e) come back unprocessed.',
      '// Round 2 (retrying d,e): the call itself throws instead of resolving --',
    ].join('\n');
    expect(planReferencesIn(source, 'a.ts')).toEqual([]);
  });
});

describe('planReferences', () => {
  it('finds no plan-process reference across the real tree', () => {
    expect(planReferences()).toEqual([]);
  });
});
