import type { AgentCli, CliView } from './types.ts';

// Which model an agent's session asks for. The office's default model belongs to its default coding agent, and each
// worker can name their own; a model only goes to an agent that understands it (no Claude model for Codex).

/** Claude Code's model names and aliases. */
export const isClaudeModel = (model: string) => /^(claude|opus|sonnet|haiku|fable|default|best|opusplan)\b/i.test(model.trim());

/**
 * The model for a worker on `cli`: their own if it suits that agent, else the office default when `cli` is the
 * default agent, else `claudeDefault` for Claude Code, or '' to let any other agent use its own default.
 */
export function effectiveModel(own: string, cli: AgentCli, office: { defaultCli: AgentCli; defaultModel: string }, claudeDefault: string): string {
  const suits = (m: string) => m.trim() !== '' && (cli === 'claude') === isClaudeModel(m);
  if (suits(own)) return own.trim();
  if (cli === office.defaultCli && suits(office.defaultModel)) return office.defaultModel.trim();
  return cli === 'claude' ? claudeDefault : '';
}

/** Claude Code models offered as suggestions in the office's model fields. */
export const CLAUDE_MODELS = ['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5', 'claude-haiku-4-5'];

/** Codex's own, for a machine whose Codex couldn't be asked (it validates `--model` itself, so it lists nothing). */
export const CODEX_MODELS = ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.5'];

/**
 * Model suggestions for a coding agent: what that CLI says it can run when it can be asked (OpenCode lists every model
 * of the providers it is signed in to, DeepSeek's included), else the office's own list. Any other name can still be
 * typed — this is a datalist, not a whitelist. A CLI that answers with dozens of models is put in a useful order: the
 * office's own model and its provider first (that is what most agents here run), the rest alphabetically.
 */
export function modelSuggestions(cli: AgentCli, clis: readonly CliView[] = [], officeModel = ''): string[] {
  const asked = clis.find((c) => c.id === cli)?.models ?? [];
  if (asked.length) return [...asked].sort((a, b) => rank(a, officeModel) - rank(b, officeModel) || a.localeCompare(b));
  if (cli === 'claude') return CLAUDE_MODELS;
  if (cli === 'codex') return CODEX_MODELS;
  return CLAUDE_MODELS.map((m) => `anthropic/${m}`);
}

/** 0 for the office's own model, 1 for its provider, 2 for the rest: the order the suggestions come in. */
function rank(model: string, officeModel: string): number {
  if (officeModel && model === officeModel) return 0;
  const provider = officeModel.split('/')[0];
  return provider && model.startsWith(`${provider}/`) ? 1 : 2;
}
