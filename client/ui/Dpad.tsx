/* 입력 어댑터 3: 화면 버튼 (모바일 터치 포함).
   키보드와 '같은' Action 을 만들어 같은 경로로 보낸다 —
   액션 처리 로직이 입력 방식별로 분기하지 않는다는 것이 charter 79-80줄이다. */

import type { Action } from "../../shared/protocol";
import { C, FONT } from "../theme";

const btn = (label: string, onClick: () => void, extra: React.CSSProperties = {}) => (
  <button
    key={label}
    onClick={onClick}
    style={{
      background: C.winHi,
      border: `2px solid ${C.line}`,
      color: C.text,
      fontSize: 18,
      fontFamily: FONT,
      cursor: "pointer",
      touchAction: "manipulation",
      ...extra,
    }}
  >
    {label}
  </button>
);

export function Dpad({ act, canAttack }: { act: (a: Action) => void; canAttack?: boolean }) {
  return (
    <div style={{ display: "flex", gap: 16, alignItems: "center", justifyContent: "space-between" }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "44px 44px 44px",
          gridTemplateRows: "44px 44px 44px",
          gap: 3,
        }}
      >
        <div />
        {btn("↑", () => act({ type: "move", dir: "north" }))}
        <div />
        {btn("←", () => act({ type: "move", dir: "west" }))}
        <div />
        {btn("→", () => act({ type: "move", dir: "east" }))}
        <div />
        {btn("↓", () => act({ type: "move", dir: "south" }))}
        <div />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {btn("살펴보기", () => act({ type: "look" }), { padding: "12px 18px", fontSize: 14 })}
        {canAttack &&
          btn("공격", () => act({ type: "attack" }), {
            padding: "12px 18px",
            fontSize: 14,
            borderColor: C.red,
            color: C.red,
          })}
      </div>
    </div>
  );
}
