import { describe, expect, it } from 'vitest';
import { canBuild, canQa, gapsText, isTakes, takesChangeWarning, takesGaps } from './takes.ts';

describe('Takes', () => {
  it('reads a missing setting as anything', () => {
    expect(canBuild(undefined) && canQa(undefined)).toBe(true);
    expect([canBuild('build'), canQa('build')]).toEqual([true, false]);
    expect([canBuild('qa'), canQa('qa')]).toEqual([false, true]);
    expect([isTakes('qa'), isTakes('reviewer'), isTakes(undefined)]).toEqual([true, false, false]);
  });

  it("finds a floor's gaps", () => {
    expect(takesGaps([])).toEqual({ noBuild: false, noQa: false });
    expect(takesGaps([{}, { takes: 'qa' }])).toEqual({ noBuild: false, noQa: false });
    expect(takesGaps([{ takes: 'build' }, { takes: 'build' }])).toEqual({ noBuild: false, noQa: true });
    expect(takesGaps([{ takes: 'qa' }])).toEqual({ noBuild: true, noQa: false });
    expect(gapsText({ noBuild: false, noQa: false })).toBe('');
    expect(gapsText({ noBuild: false, noQa: true })).toMatch(/^Nobody on this floor can test/);
  });

  it('warns before a change leaves the floor without testers or builders, and only then', () => {
    const team = [
      { id: 'a', takes: 'build' as const },
      { id: 'b', takes: 'any' as const },
    ];
    expect(takesChangeWarning(team, 'b', 'build')).toMatch(/test/);
    expect(takesChangeWarning(team, 'b', 'qa')).toBe('');
    expect(takesChangeWarning([{ id: 'a', takes: 'qa' as const }, { id: 'b' }], 'b', 'qa')).toMatch(/build/);
    // already without testers: no new warning for another change
    expect(takesChangeWarning([{ id: 'a', takes: 'build' as const }, { id: 'b', takes: 'build' as const }], 'a', 'build')).toBe('');
  });
});
