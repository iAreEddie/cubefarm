// An agent's "Takes" setting (#2): what work the scheduler hands them. Opt-in, not a role: everyone defaults to
// 'any', and a floor where nobody changes it is scheduled exactly as before. Used by the server's hand-out and the
// client's warnings alike.

export type AgentTakes = 'any' | 'build' | 'qa';

export const TAKES: readonly AgentTakes[] = ['any', 'build', 'qa'];

export const TAKES_LABEL: Record<AgentTakes, string> = { any: 'Anything', build: 'Building and fixes', qa: 'QA only' };

export const isTakes = (x: unknown): x is AgentTakes => TAKES.includes(x as AgentTakes);

/** Missing (older state, tests) means 'any'. */
export const canBuild = (takes: AgentTakes | undefined) => takes !== 'qa';
export const canQa = (takes: AgentTakes | undefined) => takes !== 'build';

/** A floor's team that can't do one kind of work: nobody to build issues and fixes, or nobody to test pull requests. */
export interface TakesGaps {
  noBuild: boolean;
  noQa: boolean;
}

/** What a floor's team (its agents, the CEO left out by the caller) can't do. An empty team has no gaps to report. */
export function takesGaps(team: readonly { takes?: AgentTakes }[]): TakesGaps {
  if (!team.length) return { noBuild: false, noQa: false };
  return { noBuild: !team.some((a) => canBuild(a.takes)), noQa: !team.some((a) => canQa(a.takes)) };
}

/** The warning for a floor's gaps ('' when there are none). */
export function gapsText(g: TakesGaps): string {
  if (g.noBuild && g.noQa) return 'Nobody on this floor can build or test.';
  if (g.noBuild) return "Nobody on this floor builds: every agent is on QA only, so issues and fixes wait. Change someone's Takes.";
  if (g.noQa) return "Nobody on this floor can test: every agent is on building and fixes, so pull requests wait for QA. Change someone's Takes.";
  return '';
}

/** The warning for changing one agent's Takes, if it would leave the floor without one kind of work ('' if not). */
export function takesChangeWarning(team: readonly { id: string; takes?: AgentTakes }[], id: string, next: AgentTakes): string {
  const before = takesGaps(team);
  const after = takesGaps(team.map((a) => (a.id === id ? { ...a, takes: next } : a)));
  if (after.noQa && !before.noQa) return 'Nobody on this floor would be left to test pull requests: they would wait for QA.';
  if (after.noBuild && !before.noBuild) return 'Nobody on this floor would be left to build issues and fixes: they would wait.';
  return '';
}
