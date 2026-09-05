/* 좌표와 방향의 유일한 정의.
   클라이언트 예측과 서버 판정이 반드시 '같은 코드'를 써야 한다 —
   둘이 조금이라도 어긋나면 유령 스냅백이 생긴다. */

export type PlayerId = string; // uuid v4
export type RegionId = string; // 'b1' — 표시 이름이 아니라 id
export type RoomId = string; // 'b1:3,3'

export type Dir = "north" | "south" | "east" | "west";
export const DIRECTIONS = ["north", "south", "east", "west"] as const;

export interface Pos {
  region: RegionId;
  x: number;
  y: number;
}

/* Object.create(null) 프로토타입: DELTA["__proto__"] 같은 미검증 조회가
   Function 을 돌려주는 대신 undefined 를 돌려준다. 검증기가 먼저 막지만,
   방어는 두 겹일 때만 방어다. */
export const DELTA: Readonly<Record<Dir, { dx: number; dy: number }>> = Object.assign(
  Object.create(null) as Record<Dir, { dx: number; dy: number }>,
  {
    north: { dx: 0, dy: -1 },
    south: { dx: 0, dy: 1 },
    west: { dx: -1, dy: 0 },
    east: { dx: 1, dy: 0 },
  },
);

export const OPPOSITE: Readonly<Record<Dir, Dir>> = Object.assign(
  Object.create(null) as Record<Dir, Dir>,
  { north: "south", south: "north", east: "west", west: "east" } as const,
);

/** 방의 정규 키. room_text PK 절반이자 엔진 맵 키이자 클라이언트 Map 키.
 *  shared/ 에 한 번만 정의해서, 클라이언트가 id 문자열을 파싱하는 일도
 *  서버가 두 번째 포맷을 발명하는 일도 없게 한다. */
export const roomIdOf = (p: Pos): RoomId => `${p.region}:${p.x},${p.y}`;

export const samePos = (a: Pos, b: Pos): boolean =>
  a.region === b.region && a.x === b.x && a.y === b.y;

export const step = (p: Pos, dir: Dir): Pos => {
  const d = DELTA[dir];
  return { region: p.region, x: p.x + d.dx, y: p.y + d.dy };
};
