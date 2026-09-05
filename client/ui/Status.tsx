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
      <div style={{ fontSize: 11, color: C.dim, marginTop: 8 }}>
        {room?.occupants.length
          ? `이 방에 ${room.occupants.map((o) => o.name).join(", ")}`
          : "이 방에는 당신뿐이다"}
        {" · "}
        <span style={{ color: C.dim }}>탐색한 방 {self.seen.length}</span>
      </div>
    </div>
  );
}
