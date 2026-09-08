/* 미니맵. 인수 조건 1이 눈에 보이는 곳이다.
 *
 * 프로토타입의 격자를 그대로 쓰되, 다른 플레이어의 점과 적이 나오는 자리가
 * 추가됐다. 다른 플레이어에 대해 클라이언트는 가시성 판정을 하지 않는다 —
 * 서버가 보내준 presence 는 이미 "내가 볼 수 있는 사람" 으로 걸러진 것이라,
 * 여기서 두 번째 판정을 하면 서버와 어긋날 뿐이다.
 *
 * ★ 안개는 걷었다. 지역 안에서는 전부 보인다. 지역 '밖' 의 지도가 아예 오지
 *   않는 것(서버측 안개)은 그대로다 — 그건 관심영역의 상한이지 연출이 아니다.
 *
 * ★ 5단계: 붙어 있는 칸을 누르면 그쪽으로 한 칸 간다 (모바일 조작).
 *   한 칸까지다 — 여러 칸 경로를 클라이언트가 계산하기 시작하면 그것은
 *   클라이언트가 맵을 해석하는 것이고, 벽 판정이 두 군데 살게 된다.
 *   벽인지 아닌지도 여기서 보지 않는다. 눌러 보고 서버가 "단단한 벽이
 *   앞을 막는다" 고 답하는 것이 D패드와 완전히 같은 경로다 (규칙 1). */

import type { Dir, Pos } from "../../shared/ids";
import type { Action, PlayerBrief, RegionView } from "../../shared/protocol";
import { C, win } from "../theme";

const CELL = 16;

export function Minimap(props: {
  region: RegionView;
  /** 화면에 그릴 '예측' 위치. self.pos(확정)와 다를 수 있다. */
  at: Pos;
  others: { player: PlayerBrief; pos: Pos }[];
  act: (a: Action) => void;
}) {
  const { region, at, others, act } = props;

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

  /* ★ 안개를 걷었다. 전에는 밟아 본 칸만 벽/바닥을 구분해 그렸다.
     안개가 사는 이유는 '무엇이 기다리는지 모른다' 는 긴장인데, 이 게임에서
     그 긴장은 방에 들어갔을 때의 묘사와 전투가 만든다. 지도가 감추는 것은
     긴장이 아니라 같은 길을 두 번 걷게 만드는 불편이었다.

     서버가 지역 타일을 전에도 전부 보내고 있었으므로(그게 '한 지역 =
     관심영역' 이라는 서버측 안개다) 이것은 순수한 렌더링 결정이다 —
     프로토콜이 나르는 것은 늘지 않는다. 지역 밖의 지도는 여전히 안 온다.
     self.seen 은 그대로 살아 있다: '탐색한 방 N' 이 그것을 쓴다. */
  const bg = (x: number, y: number): string => (tile(x, y) === "#" ? C.wall : C.floor);

  /** 적이 배치된 칸. '지금 살아 있는가' 가 아니라 '여기서 나온다' 다 —
   *  장소의 성질이라 변하지 않고, 그래서 스냅샷 한 번으로 충분하다. */
  const foes = new Set(region.foes);

  /** 다른 지역으로 나가는 길이 있는 칸. 지도가 없으면 '다음 지역에 어떻게
   *  가는가' 를 알 방법이 벽에 부딪혀 보는 것뿐이다 — 열 칸짜리 지역에서는
   *  그게 놀이지만 마흔 칸짜리에서는 그냥 막막함이다.
   *  어디로 이어지는지는 안 그린다: 가 보면 서버가 답한다 (규칙 1). */
  const gates = new Set(region.gates);

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
            const foe = foes.has(`${x},${y}`);
            const gate = gates.has(`${x},${y}`);
            const dir = dirTo(x, y);
            return (
              <div
                key={`${x}-${y}`}
                title={
                  [
                    ...guests.map((g) => g.name),
                    ...(foe ? ["적이 나오는 자리"] : []),
                    ...(gate ? ["다른 지역으로 나가는 길"] : []),
                  ].join(", ") || undefined
                }
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
                  //
                  // 적이 나오는 칸은 바닥을 붉게 물들인다. 가운데에 그리지 않는
                  // 이유: 거기는 사람의 자리다. 같은 칸에 사람과 적이 겹쳐도
                  // 둘 다 보여야 하고, 그건 정확히 흔한 상황이다.
                  background: here ? C.gold : foe ? C.foe : bg(x, y),
                  outline: guests.length ? `2px solid ${C.other}` : "none",
                  outlineOffset: -2,
                  /* 출구는 안쪽 테두리로 그린다. 바깥 테두리(outline)는 사람이
                     쓰고 있고, 배경은 적이 쓴다 — 셋이 한 칸에 겹쳐도 각각
                     보여야 한다. 초록은 미니맵에서 여기서만 쓴다. */
                  boxShadow: gate ? `inset 0 0 0 2px ${C.green}` : "none",
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
