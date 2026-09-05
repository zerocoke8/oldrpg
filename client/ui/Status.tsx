/* 상단 상태창. 좌표 · HP · 동행자 수.
   HP 는 1단계에 변하지 않지만 SelfState 가 이미 싣고 있으므로,
   4단계에 전투가 붙어도 프로토콜도 이 컴포넌트도 바뀌지 않는다. */

import type { Pos } from "../../shared/ids";
import type { RegionView, RoomView, SelfState } from "../../shared/protocol";
import { C, win } from "../theme";

export function Status(props: {
  self: SelfState;
  region: RegionView;
  room: RoomView | null;
  at: Pos;
  connected: boolean;
}) {
  const { self, region, room, at, connected } = props;
  const ratio = self.maxHp > 0 ? self.hp / self.maxHp : 0;

  return (
    <div style={{ ...win, flex: 1 }}>
      <div style={{ fontSize: 13, color: C.dim, marginBottom: 6 }}>
        {region.name} · {at.x},{at.y} · <span style={{ color: C.text }}>{self.name}</span>
        {!connected && <span style={{ color: C.red }}> · 연결 끊김</span>}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 13, color: C.dim, width: 24 }}>HP</span>
        <div style={{ flex: 1, height: 10, background: "#0a0f2a", border: `1px solid ${C.dim}` }}>
          <div
            style={{
              width: `${ratio * 100}%`,
              height: "100%",
              background: ratio > 0.3 ? C.green : C.red,
              transition: "width .25s",
            }}
          />
        </div>
        <span style={{ fontSize: 13, width: 46, textAlign: "right" }}>
          {self.hp}/{self.maxHp}
        </span>
      </div>
      {/* ★ HUD 크롬이다. 프로토콜 불변식 (1)의 명시적 예외 —
          '라벨 + 데이터' 이지 서사 문장이 아니다. "○○ 님이 들어왔다" 같은
          문장은 여기서 만들지 않고 서버의 log 로만 온다. 그래서 2단계에
          문구가 바뀌어도 이 컴포넌트는 그대로다. */}
      <div style={{ fontSize: 11, color: C.dim, marginTop: 8, display: "flex", gap: 10 }}>
        <span>
          동행 {room?.occupants.length ?? 0}
          {room?.occupants.length ? (
            <span style={{ color: C.other }}>
              {" "}
              {room.occupants.map((o) => o.name).join(", ")}
            </span>
          ) : null}
        </span>
        <span>탐색한 방 {self.seen.length}</span>
      </div>
    </div>
  );
}
