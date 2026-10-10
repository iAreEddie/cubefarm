import type { CSSProperties } from 'react';
import { api } from '../api';
import { agentsOnRepo, useStore, type Agent } from '../store';
import { gapsText, TAKES, TAKES_LABEL, takesChangeWarning, takesGaps, type AgentTakes } from '../../../shared/takes';
import { confirmDialog } from './Confirm';

// An agent's "Takes" (shared/takes.ts): the picker, which asks first when a change would leave the floor with nobody
// to build or test, and the floor's warning when it already has. No 3D imports: pocket mode uses these too.

/** What work they take; asks first when the change would leave their floor without builders or testers. */
export function TakesSelect({ agent, id, style }: { agent: Agent; id?: string; style?: CSSProperties }) {
  const pick = async (next: AgentTakes) => {
    const warning = takesChangeWarning(agentsOnRepo(useStore.getState().agents, agent.repoId), agent.id, next);
    if (warning && !(await confirmDialog({ title: `Set ${agent.name} to ${TAKES_LABEL[next]}?`, body: warning, icon: '⚠️', confirm: 'Change anyway', tone: 'warn' }))) return;
    try {
      await api.updateAgent(agent.id, { takes: next });
    } catch {
      // api() already toasted the error
    }
  };
  return (
    <select
      id={id}
      value={agent.takes ?? 'any'}
      title="What work the office hands them: anything (the default), only building issues and fixes, or only QA"
      aria-label={id ? undefined : `What ${agent.name} takes`}
      style={style}
      onChange={(e) => void pick(e.target.value as AgentTakes)}
    >
      {TAKES.map((t) => (
        <option key={t} value={t}>
          {TAKES_LABEL[t]}
        </option>
      ))}
    </select>
  );
}

/** The warning for a floor ('' when its team can build and test). */
export function useTakesWarning(repoId: string) {
  return useStore((s) => gapsText(takesGaps(agentsOnRepo(s.agents, repoId))));
}

/** "Nobody on this floor can test": shown wherever a floor's team is, so its work doesn't wait unseen. */
export function TakesWarning({ repoId, className = 'chip chip-warn' }: { repoId: string; className?: string }) {
  const text = useTakesWarning(repoId);
  if (!text) return null;
  return (
    <div className={className} role="status" style={{ whiteSpace: 'normal' }}>
      ⚠️ {text}
    </div>
  );
}
