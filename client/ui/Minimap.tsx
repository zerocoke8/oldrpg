/* 미니맵. 인수 조건 1이 눈에 보이는 곳이다.
 *
 * 프로토타입의 격자를 그대로 쓰되, 다른 플레이어의 점이 추가됐다.
 * 다른 플레이어는 '안개와 무관하게' 그린다 — 서버가 보내준 presence 는
 * 이미 "내가 볼 수 있는 사람" 으로 걸러진 것이므로, 클라이언트가 두 번째
 * 가시성 판정을 하면 서버와 어긋날 뿐이다.
 *
 * ★ 5단계: 붙어 있는 칸을 누르면 그쪽으로 한 칸 간다 (모바일 조작).
 *   한 칸까지다 — 여러 칸 경로를 클라이언트가 계산하기 시작하면 그것은
 *   클라이언트가 맵을 해석하는 것이고, 벽 판정이 두 군데 살게 된다.
 *   벽인지 아닌지도 여기서 보지 않는다. 눌러 보고 서버가 "단단한 벽이
 *   앞을 막는다" 고 답하는 것이 D패드와 완전히 같은 경로다 (규칙 1). */

import type { Dir, Pos } from "../../shared/ids";
import { roomIdOf } from "../../shared/ids";
import type { Action, PlayerBrief, RegionView, SelfState } from "../../shared/protocol";
import { C, win } from "../theme";
import { isSeen } from "../state/store";

const CELL = 16;

export function Minimap(props: {
  region: RegionView;
  self: SelfState;
  /** 화면에 그릴 '예측' 위치. self.pos(확정)와 다를 수 있다. */
  at: Pos;
  others: { player: PlayerBrief; pos: Pos }[];
  act: (a: Action) => void;
}) {
  const { region, self, at, others, act } = props;

  const othersAt = new Map<string, PlayerBrief[]>();
  for (const o of others) {
    const k = `${o.pos.x},${o.pos.y}`;
    othersAt.set(k, [...(othersAt.get(k) ?? []), o.player]);
  }

  const tile = (x: number, y: number): string => region.tiles[y]?.[x] ?? "#";

  /* 격자와 예측 위치가 같은 지역인가. 문을 지나는 순간 ack(새 좌표)와
     self.patch(새 격자)가 서로 다른 메시지로 오므로, 한 프레임 동안 옛
     격자 위에 새 지역의 좌표가 얹힐 수 있다. 그 프레임에는 점을 그리지
     않는다 — 벽 안에 박힌 점을 보여주는 것보다 잠깐 없는 편이 낫다. */
  const sameRegion = at.region === region.id;

  /** 그 칸이 지금 위치의 상하좌우인가. 맞으면 그 방향을 돌려준다. */
  const dirTo = (x: number, y: number): Dir | null => {
    if (!sameRegion) return null;
    const dx = x - at.x;
    const dy = y - at.y;
    if (dx === 0 && dy === -1) return "north";
    if (dx === 0 && dy === 1) return "south";
    if (dx === 1 && dy === 0) return "east";
    if (dx === -1 && dy === 0) return "west";
    return null;
  };

  /* 안개 칸도 '보이게' 그린다. 완전 투명으로 두면 격자 자체가 사라져서
     내가 지도의 어디쯤에 있는지 알 수 없다. 벽인지 바닥인지는 여전히
     감추므로 안개의 의미는 그대로다.

     ★ 적이 배치되지 않은 지역(region.hostile === false)에서는 안개를 걷는다.
       안개가 사는 이유는 '무엇이 기다리는지 모른다' 는 긴장인데, 전투가
       일어날 수 없는 곳에는 그 긴장이 없다 — 남는 것은 마을에서 길을 두 번
       걷게 만드는 불편뿐이다. 서버가 지역 타일을 어차피 전부 보내므로
       (그게 '한 지역 = 관심영역' 이라는 서버측 안개다) 이건 순수한 렌더링
       결정이고, 프로토콜이 나르는 것은 늘지 않는다. */
  const bg = (x: number, y: number): string => {
    const seen = !region.hostile || isSeen(self, roomIdOf({ region: region.id, x, y }));
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
            const here = sameRegion && x === at.x && y === at.y;
            const guests = othersAt.get(`${x},${y}`) ?? [];
            const dir = dirTo(x, y);
            return (
              <div
                key={`${x}-${y}`}
                title={guests.map((g) => g.name).join(", ") || undefined}
                {...(dir
                  ? {
                      role: "button",
                      // 탭 순서에는 넣지 않는다 — 키보드에는 화살표와
                      // 커맨드 창이라는 제대로 된 길이 이미 있다.
                      tabIndex: -1,
                      onClick: () => act({ type: "move", dir }),
                    }
                  : {})}
                style={{
                  width: CELL,
                  height: CELL,
                  borderRadius: 2,
                  // 내 칸은 배경색, 남은 점(dot). 같은 칸에 겹쳐도 둘 다 보인다 —
                  // 인수 조건이 정확히 그 상황("같은 방")이므로 여기가 중요하다.
                  background: here ? C.gold : bg(x, y),
                  outline: guests.length ? `2px solid ${C.other}` : "none",
                  outlineOffset: -2,
                  cursor: dir ? "pointer" : "default",
                  touchAction: "manipulation",
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
