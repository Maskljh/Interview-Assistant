import { useEffect, useRef } from 'react';

export type PersonaState = 'idle' | 'speaking' | 'listening';

export interface VirtualPersonaProps {
  state: PersonaState;
  /** 0..1 音量水平，speaking 时驱动嘴型 */
  level?: number;
  /** 用户头像 data URL（可选，替换默认脸） */
  avatarUrl?: string | null;
}

export default function VirtualPersona({ state, level = 0, avatarUrl }: VirtualPersonaProps) {
  const mouthRef = useRef<SVGEllipseElement | null>(null);
  const bodyRef = useRef<SVGGElement | null>(null);

  // speaking 时嘴型随音量缩放（rAF 直改 SVG 属性）
  useEffect(() => {
    if (state !== 'speaking' || !mouthRef.current) return;
    let raf = 0;
    const tick = () => {
      if (mouthRef.current) {
        const scale = 0.2 + Math.min(1, level) * 0.8;
        mouthRef.current.setAttribute('ry', String(3 + scale * 7));
      }
      if (bodyRef.current) {
        const bob = 1 + Math.sin(Date.now() / 120) * 0.01;
        bodyRef.current.setAttribute('transform', `translate(0, ${(1 - bob) * 2})`);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [state, level]);

  return (
    <div className={`virtual-persona virtual-persona--${state}`} aria-label="虚拟面试官">
      <svg viewBox="0 0 160 200" width="140" height="175" role="img">
        {/* 身体 */}
        <g ref={bodyRef}>
          <path
            d="M40 200 C40 150 120 150 120 200 Z"
            fill="#e8e4dc"
            stroke="#171717"
            strokeWidth="2"
          />
          {/* 领口 */}
          <path d="M70 170 L80 190 L90 170 Z" fill="#f5f1e8" stroke="#171717" strokeWidth="1.5" />
        </g>
        {/* 头部 */}
        <g className="virtual-persona-head">
          <circle cx="80" cy="80" r="52" fill="#f5d0b4" stroke="#171717" strokeWidth="2" />
          {/* 头发 */}
          <path d="M28 70 Q30 30 80 26 Q130 30 132 70 L132 55 Q132 30 80 24 Q28 30 28 55 Z" fill="#3a3a3a" />
          {/* 眼睛（眨眼动画 class） */}
          <ellipse className="virtual-persona-eye" cx="62" cy="80" rx="6" ry="7" fill="#171717" />
          <ellipse className="virtual-persona-eye" cx="98" cy="80" rx="6" ry="7" fill="#171717" />
          {/* 嘴（speaking 时由 JS 改 ry） */}
          <ellipse
            ref={mouthRef}
            className="virtual-persona-mouth"
            cx="80"
            cy="104"
            rx="10"
            ry="3"
            fill="#8a4b3a"
          />
        </g>
        {/* 用户头像覆盖脸部（可选） */}
        {avatarUrl && (
          <clipPath id="persona-face-clip">
            <circle cx="80" cy="80" r="42" />
          </clipPath>
        )}
        {avatarUrl && (
          <image
            href={avatarUrl}
            x="38"
            y="38"
            width="84"
            height="84"
            clipPath="url(#persona-face-clip)"
            preserveAspectRatio="xMidYMid slice"
          />
        )}
      </svg>
      {state === 'speaking' && <span className="virtual-persona-label">正在提问…</span>}
      {state === 'listening' && <span className="virtual-persona-label">思考中…</span>}
      {state === 'idle' && <span className="virtual-persona-label">面试官</span>}
    </div>
  );
}
