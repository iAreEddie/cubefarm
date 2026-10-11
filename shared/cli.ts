import type { AgentCli, AgentRole, SwarmSettings } from './types.ts';

// Which coding agent someone runs, for the server and the client both. Everyone, the CEO included, runs their own pick
// in the terminal runtime; the Agent SDK runs Claude Code and nothing else.

/** The Agent SDK runs Claude Code. */
export const SDK_CLI: AgentCli = 'claude';

/**
 * The CEO's `cli` from before it could be chosen: the office hardcoded Claude Code and ignored what was stored, so a
 * stored 'claude' is what the old office wrote, never a choice. It counts as unset, and is corrected when the office
 * starts (Swarm.ensureCeo), so the CEO follows the office default like everyone else.
 */
export const LEGACY_CEO_CLI: AgentCli = 'claude';

/** Someone's own pick, with a value stored by an office that ignored it counted as no pick. */
export function chosenCli(role: AgentRole, cli: AgentCli | '' | undefined): AgentCli | '' {
  if (role !== 'ceo') return cli ?? '';
  return cli === LEGACY_CEO_CLI ? '' : (cli ?? '');
}

/** The coding agent someone runs: their own pick, else the office default. */
export function resolveCli(a: { role: AgentRole; cli: AgentCli | '' }, s: Pick<SwarmSettings, 'runtime' | 'defaultCli'>): AgentCli {
  if (s.runtime !== 'terminal') return SDK_CLI; // the Agent SDK is Claude Code for everyone
  return chosenCli(a.role, a.cli) || s.defaultCli;
}
