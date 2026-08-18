export type PersonaState = 'idle' | 'speaking' | 'listening';

export interface VirtualPersonaProps {
  state: PersonaState;
  /** 用户头像 data URL（可选，整图替换默认形象） */
  avatarUrl?: string | null;
}

export default function VirtualPersona({ state, avatarUrl }: VirtualPersonaProps) {
  return (
    <div className={`virtual-persona virtual-persona--${state}`} aria-label="虚拟面试官">
      <img
        className="virtual-persona-img"
        src={avatarUrl ?? '/persona-default.png'}
        alt="虚拟面试官"
      />
      {state === 'speaking' && <span className="virtual-persona-label">正在提问…</span>}
      {state === 'listening' && <span className="virtual-persona-label">思考中…</span>}
      {state === 'idle' && <span className="virtual-persona-label">面试官</span>}
    </div>
  );
}
