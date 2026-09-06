/* 전투 패널. 실시간이라 이게 '지금 무슨 일이 벌어지는지' 를 나르는 주된 창구다 —
   로그는 접히고, HP 바와 쿨다운이 초당 여러 번 갱신된다. */

import type { CombatView } from "../../shared/protocol";
import { C, FONT, win } from "../theme";

const Bar = ({ ratio, color }: { ratio: number; color: string }) => (
  <div style={{ flex: 1, height: 10, background: "#0a0f2a", border: `1px solid ${C.dim}` }}>
    <div
      style={{
        width: `${Math.max(0, Math.min(1, ratio)) * 100}%`,
        height: "100%",
        background: color,
        transition: "width .12s linear", // 0.5초 스윙이라 짧게 — 늦으면 거짓말이 된다
      }}
    />
  </div>
);

export function Combat(props: {
  combat: CombatView;
  selfId: string;
  act: (a: { type: "attack" } | { type: "skill"; skillId: string } | { type: "stop" }) => void;
}) {
  const { combat, selfId, act } = props;
  const { enemy } = combat;
  const targeted = combat.targetId === selfId;

  return (
    <div style={{ ...win, marginBottom: 12, borderColor: C.red }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 13, color: C.red, width: 24 }}>敵</span>
        <Bar ratio={enemy.hp / enemy.maxHp} color={C.red} />
        <span style={{ fontSize: 13, width: 52, textAlign: "right" }}>
          {enemy.hp}/{enemy.maxHp}
        </span>
      </div>
      <div style={{ fontSize: 12, color: C.dim, marginBottom: 8 }}>
        {enemy.name}
        {/* 누가 맞고 있는지 — 어그로 모델에서 이게 안 보이면 왜 맞는지 알 수 없다 */}
        {targeted ? (
          <span style={{ color: C.red }}> · 당신을 노리고 있다</span>
        ) : combat.targetId ? (
          <span style={{ color: C.dim }}> · 다른 사람을 노리고 있다</span>
        ) : null}
        {!combat.engaged && <span style={{ color: C.gold }}> · 물러나 있음</span>}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {combat.skills.map((sk) => {
          const cooling = sk.readyInMs > 0;
          const queued = combat.queuedSkill === sk.id;
          return (
            <button
              key={sk.id}
              onClick={() => act({ type: "skill", skillId: sk.id })}
              disabled={cooling}
              style={{
                background: queued ? C.gold : C.winHi,
                border: `2px solid ${queued ? C.gold : C.line}`,
                color: queued ? C.ink : cooling ? C.dim : C.text,
                padding: "8px 12px",
                fontFamily: FONT,
                fontSize: 13,
                cursor: cooling ? "default" : "pointer",
                opacity: cooling ? 0.5 : 1,
                touchAction: "manipulation",
              }}
            >
              {sk.name}
              {cooling && ` ${Math.ceil(sk.readyInMs / 1000)}`}
            </button>
          );
        })}
        <button
          onClick={() => act(combat.engaged ? { type: "stop" } : { type: "attack" })}
          style={{
            background: C.winHi,
            border: `2px solid ${C.line}`,
            color: combat.engaged ? C.dim : C.text,
            padding: "8px 12px",
            fontFamily: FONT,
            fontSize: 13,
            cursor: "pointer",
            marginLeft: "auto",
            touchAction: "manipulation",
          }}
        >
          {combat.engaged ? "물러나기" : "다시 붙기"}
        </button>
      </div>
    </div>
  );
}
