/* 전투 상태 띠. 실시간이라 이게 '지금 무슨 일이 벌어지는지' 를 나르는 창구다 —
 * 로그는 접히고, HP 바와 표적이 초당 여러 번 갱신된다.
 *
 * ★ 5단계에서 버튼이 전부 빠졌다. 공격·스킬·물러나기는 커맨드 창으로 갔다.
 *   여기 남은 것은 '상태' 뿐이다 (Status.tsx 와 같은 역할, 다른 대상).
 *   명령과 상태를 섞지 않는 것이 5단계 화면 분리의 요점이다. */

import type { CombatView } from "../../shared/protocol";
import { C, win } from "../theme";

export function Combat({ combat, selfId }: { combat: CombatView; selfId: string }) {
  const { enemy } = combat;
  const targeted = combat.targetId === selfId;
  const ratio = Math.max(0, Math.min(1, enemy.hp / enemy.maxHp));

  return (
    /* 예고 중에는 테두리가 바뀐다. 로그 한 줄만으로는 0.9초 안에 눈에 들어오지
       않고, 그 창이 곧 '방어 태세를 쓸 것인가' 를 결정하는 시간이다. */
    <div style={{ ...win, padding: "8px 10px", borderColor: combat.winding ? C.gold : C.red }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 13, color: C.red, width: 24 }}>敵</span>
        <div style={{ flex: 1, height: 10, background: C.trough, border: `1px solid ${C.dim}` }}>
          <div
            style={{
              width: `${ratio * 100}%`,
              height: "100%",
              background: C.red,
              transition: "width .12s linear", // 0.5초 스윙이라 짧게 — 늦으면 거짓말이 된다
            }}
          />
        </div>
        <span style={{ fontSize: 13, width: 52, textAlign: "right" }}>
          {enemy.hp}/{enemy.maxHp}
        </span>
      </div>
      <div style={{ fontSize: 12, color: C.dim, marginTop: 6 }}>
        {enemy.name}
        {/* 누가 맞고 있는지 — 어그로 모델에서 이게 안 보이면 왜 맞는지 알 수 없다 */}
        {targeted ? (
          <span style={{ color: C.red }}> · 당신을 노리고 있다</span>
        ) : combat.targetId ? (
          <span style={{ color: C.dim }}> · 다른 사람을 노리고 있다</span>
        ) : null}
        {combat.winding && <span style={{ color: C.gold }}> · 큰 것이 온다</span>}
        {!combat.engaged && <span style={{ color: C.gold }}> · 물러나 있음</span>}
        {combat.queuedSkill && <span style={{ color: C.gold }}> · 다음 호흡에 기술</span>}
        {combat.queuedItem && <span style={{ color: C.gold }}> · 다음 호흡에 아이템</span>}
      </div>
    </div>
  );
}
