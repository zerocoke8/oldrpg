/* 미니맵. 인수 조건 1이 눈에 보이는 곳이다.
 *
 * 프로토타입의 격자를 그대로 쓰되, 다른 플레이어의 점이 추가됐다.
 * 다른 플레이어는 '안개와 무관하게' 그린다 — 서버가 보내준 presence 는
 * 이미 "내가 볼 수 있는 사람" 으로 걸러진 것이므로, 클라이언트가 두 번째
 * 가시성 판정을 하면 서버와 어긋날 뿐이다. */

import type { Pos } from "../../shared/ids";
import { roomIdOf } from "../../shared/ids";
import type { PlayerBrief, RegionView, SelfState } from "../../shared/protocol";
import { C, win } from "../theme";
import { isSeen } from "../state/store";

const CELL = 16;

export function Minimap(props: {
  region: RegionView;
  self: SelfState;
  /** 화면에 그릴 '예측' 위치. self.pos(확정)와 다를 수 있다. */
  at: Pos;
  others: { player: PlayerBrief; pos: Pos }[];
}) {
  const { region, self, at, others } = props;

  const othersAt = new Map<string, PlayerBrief[]>();
  for (const o of others) {
    const k = `${o.pos.x},${o.pos.y}`;
    othersAt.set(k, [...(othersAt.get(k) ?? []), o.player]);
  }

  const tile = (x: number, y: number): string => region.tiles[y]?.[x] ?? "#";

  /* 안개 칸도 '보이게' 그린다. 완전 투명으로 두면 격자 자체가 사라져서
     내가 지도의 어디쯤에 있는지 알 수 없다. 벽인지 바닥인지는 여전히
     감추므로 안개의 의미는 그대로다. */
  const bg = (x: number, y: number): string => {
    const seen = isSeen(self, roomIdOf({ region: region.id, x, y }));
    if (!seen) return "#141c3a";
    if (tile(x, y) === "#") return "#2b3563";
    return "#5b6bab";
  };

  return (
    <div style={{ ...win, padding: 8 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${region.width}, ${CELL}px)`,
          gap: 2,
        }}
      >
        {Array.from({ length: region.height }).flatMap((_, y) =>
          Array.from({ length: region.width }).map((__, x) => {
            const here = x === at.x && y === at.y;
            const guests = othersAt.get(`${x},${y}`) ?? [];
            return (
              <div
                key={`${x}-${y}`}
                title={guests.map((g) => g.name).join(", ") || undefined}
                style={{
                  width: CELL,
                  height: CELL,
                  borderRadius: 2,
                  // 내 칸은 배경색, 남은 점(dot). 같은 칸에 겹쳐도 둘 다 보인다 —
                  // 인수 조건이 정확히 그 상황("같은 방")이므로 여기가 중요하다.
                  background: here ? C.gold : bg(x, y),
                  outline: guests.length ? `2px solid ${C.other}` : "none",
                  outlineOffset: -2,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  boxSizing: "border-box",
                }}
              >
                {guests.length > 0 &&
                  (guests.length > 1 ? (
                    <span style={{ fontSize: 9, color: C.other, fontWeight: 700, lineHeight: 1 }}>
                      {guests.length}
                    </span>
                  ) : (
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        background: C.other,
                        boxShadow: `0 0 0 1px ${C.ink}`,
                      }}
                    />
                  ))}
              </div>
            );
          }),
        )}
      </div>
    </div>
  );
}
