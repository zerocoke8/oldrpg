/* 던전 구조 — 엔진이 소유하는 "진실". LLM은 여기에 손대지 않는다.
   # 벽 / . 통로 / S 시작 / T 보물 / E 적

   저작 주체는 '이 파일'이고 DB의 rooms 표는 그 투영이다. 이동 판정은 절대
   DB에서 읽지 않는다 — 핫패스는 이 메모리 구조다. */

import { createHash } from "node:crypto";
import type { Pos, RegionId, RoomId } from "../../shared/ids";
import { roomIdOf } from "../../shared/ids";
import { NPCS } from "./npcs";

export const REGION: RegionId = "b1";
export const REGION_NAME = "지하 1층";

export const MAP = [
  "#######",
  "#..TE.#",
  "#.###E#",
  "#..S..#",
  "#.###.#",
  "#..E..#",
  "#######",
] as const;

export const W = 7;
export const H = 7;

export const SPAWN: Pos = { region: REGION, x: 3, y: 3 };

/** 각 칸의 "씨앗". 엔진이 정하고, 2단계부터 LLM이 이걸 문장으로 부풀린다.
 *  씨앗은 불변이다 (규칙 3). 고치면 state_hash 가 바뀌어 평범한 캐시 미스가 되고,
 *  되돌리면 옛 텍스트가 그대로 복구된다 — seed_id 가 내용 파생이기 때문이다. */
export const SEEDS: Readonly<Record<string, string>> = {
  "1,1": "무너진 서고의 서쪽 끝. 쓰러진 책장이 길을 반쯤 막고 있다",
  "2,1": "곰팡이 핀 책 더미 사이의 좁은 통로",
  "3,1": "낮은 제단 위에 낡은 상자가 놓여 있다",
  "4,1": "벽에 그을린 손자국이 줄지어 나 있다",
  "5,1": "갈라진 동쪽 벽에서 찬 바람이 새어든다",
  "1,2": "이끼로 미끄러운 계단참",
  "5,2": "녹슨 쇠창살이 반쯤 열린 채 굳어 있다",
  "1,3": "물이 발목까지 고인 서쪽 회랑",
  "2,3": "천장에서 물방울이 규칙적으로 떨어진다",
  /* ★ 스폰이다 — 모든 플레이어의 '첫 문장' 이 여기서 나온다.
     원래는 "네 방향으로 통로가 뻗은 석조 교차로" 였는데 맵과 어긋났다:
     (3,2)와 (3,4)가 벽이라 실제 출구는 동·서 둘뿐이다. 새 플레이어가 읽는
     첫 문장이 옆의 미니맵과 다르고, 위로 한 번 누르면 "단단한 벽이 앞을
     막는다" 가 온다. 씨앗은 불변이지만(규칙 3) 이것은 튜닝이 아니라
     엔진 데이터의 버그였다 — 고치면 seedId 가 바뀌어 이 방만 깨끗한
     캐시 미스가 된다 (영향 3행 미만). */
  "3,3": "한때 네 갈래였을 석조 교차로. 남북 통로는 무너진 돌더미에 막혀 동서로만 길이 트여 있다",
  "4,3": "부서진 갑옷 조각이 바닥에 흩어져 있다",
  "5,3": "동쪽 벽에 알아볼 수 없는 문자가 새겨져 있다",
  "1,4": "좁고 가파른 내리막",
  "5,4": "벽 틈에서 희미한 붉은 빛이 스며나온다",
  "1,5": "천장이 낮아 몸을 숙여야 하는 굴",
  "2,5": "바닥에 마른 핏자국이 길게 이어진다",
  "3,5": "기둥이 늘어선 넓은 홀. 어둠 속에서 무언가 움직인다",
  "4,5": "부서진 기둥들이 늘어선 폐허",
  "5,5": "막다른 곳. 벽에 봉인된 문이 있다",
};

/** 이벤트에 반응하는 방과, 반응할 플래그를 명시적으로 선언한다.
 *  이걸 좁혀두지 않으면 방 하나가 가질 수 있는 상태가 2^n 으로 늘어난다
 *  (charter 47-48줄). seed.ts 가 부팅 때 길이 <= MAX_SENSITIVE 를 assert 한다. */
export const SENSITIVE: Readonly<Record<string, readonly string[]>> = {
  "1,4": ["guardian_slain"],
  "5,4": ["guardian_slain"],
  "1,5": ["guardian_slain"],
  "2,5": ["guardian_slain"],
  "3,5": ["guardian_slain"],
  "4,5": ["guardian_slain"],
  "5,5": ["guardian_slain"],
};

export const MAX_SENSITIVE = 4;

export interface WorldFlagDef {
  /** JSON 스칼라의 정규 표기. world_flags.value 에 이 문자열이 그대로 들어간다. */
  readonly default: string;
  /** 클라이언트에 값을 공개할 것인가.
   *  플래그는 쉽게 스포일러가 된다(secret_door_found 같은 것). 공개는 옵트인이고,
   *  꺼진 것은 snapshot.world 와 world.flag 에 아예 나가지 않는다. */
  readonly broadcast: boolean;
}

/** 존재하는 모든 월드 플래그. 값을 바꾸는 것은 3단계의 이벤트 경로이고,
 *  '무엇이 그 값을 바꾸는가' 는 4단계(전투)에서 채워진다. */
export const WORLD_FLAGS: Readonly<Record<string, WorldFlagDef>> = {
  guardian_slain: { default: "false", broadcast: true },
};

/** 시더가 쓰는 key -> default 사영. */
export const WORLD_FLAG_DEFAULTS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(WORLD_FLAGS).map(([k, v]) => [k, v.default]),
);

export const isBroadcastFlag = (key: string): boolean => WORLD_FLAGS[key]?.broadcast === true;

export const tileAt = (x: number, y: number): string => {
  if (x < 0 || y < 0 || x >= W || y >= H) return "#";
  return MAP[y]![x]!;
};

export const walkable = (x: number, y: number): boolean => tileAt(x, y) !== "#";

export const walkableAt = (p: Pos): boolean => p.region === REGION && walkable(p.x, p.y);

export interface RoomDef {
  id: RoomId;
  region: RegionId;
  x: number;
  y: number;
  tile: string;
  seed: string;
  seedId: string;
  sensitiveFlags: string[]; // 정렬 + 중복 제거됨
  flagsDeclHash: string;
}

const sha = (s: string, n: number): string =>
  createHash("sha256").update(s, "utf8").digest("hex").slice(0, n);

/** 씨앗의 '신원'. 카운터가 아니라 내용 파생인 것이 중요하다:
 *  씨앗을 A -> B -> A 로 되돌리면 원래 state_hash 로 돌아와 옛 텍스트가
 *  그대로 복구된다. 플래그 되돌림과 동작이 일치한다 (charter 51줄). */
export const seedIdOf = (seed: string): string => sha(seed, 8);

/** 선언된 플래그 '이름'들의 지문. state_hash 의 구성요소이지 장식이 아니다.
 *  선언을 추가·삭제·재정렬하면 이 값이 바뀌어, 옛 행이 '다른 상태'로
 *  오독되는 대신 그냥 깨끗한 미스가 된다.
 *  (프로토타입의 위치 기반 비트문자열은 재정렬하면 의미가 뒤바뀐다.) */
export const declHashOf = (sortedNames: readonly string[]): string => sha(sortedNames.join("\n"), 8);

/** 걷기 가능한 칸만. 벽('#')은 방이 아니다 — 씨앗도 묘사도 없는 칸에 행을 주면
 *  이후 모든 질의가 영원히 벽을 제외하는 것을 기억해야 한다. 7x7에서 19칸. */
export function allRooms(): RoomDef[] {
  const out: RoomDef[] = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!walkable(x, y)) continue;
      const k = `${x},${y}`;
      /* 침묵 폴백을 두지 않는다. 예전에는 `SEEDS[k] ?? "특징 없는 돌 통로"` 였는데,
         새 칸을 뚫고 씨앗을 빠뜨리면 아무 소리 없이 무명의 방이 하나 생겼다.
         씨앗 없는 칸은 db/seed.ts 의 assertWorldData 가 부팅에서 잡는다 —
         여기까지 왔다면 그건 프로그래밍 오류다. */
      const seed = SEEDS[k];
      if (!seed) throw new Error(`씨앗이 없는 칸 ${k} — assertWorldData 가 먼저 잡았어야 한다.`);
      const decl = [...new Set(SENSITIVE[k] ?? [])].sort();
      out.push({
        id: roomIdOf({ region: REGION, x, y }),
        region: REGION,
        x,
        y,
        tile: tileAt(x, y),
        seed,
        seedId: seedIdOf(seed),
        sensitiveFlags: decl,
        flagsDeclHash: declHashOf(decl),
      });
    }
  }
  return out;
}

/** "코드 맵과 DB rooms 가 같은 세대인가"를 한 번에 판정한다.
 *  플래그 레지스트리도 preimage 에 넣는다 — 안 그러면 새 플래그를 선언해도
 *  content_hash 가 그대로라 시더가 단축경로를 타 버린다. */
export function contentHash(): string {
  const rows = allRooms()
    .map((r) => [r.id, r.tile, r.seed, r.sensitiveFlags.join(",")].join(""))
    .sort();
  const flags = Object.keys(WORLD_FLAG_DEFAULTS).sort().join(",");
  /* NPC 도 같은 해시에 들어간다. 빠뜨리면 시더의 단축경로가 살아 있는 채로
     persona 나 방을 고쳐도 npcs 표가 옛 값을 유지한다 — "표는 코드의 그림자"
     라는 성질이 조용히 깨진다. (대사 캐시는 별개다: 그쪽은 seed_id 가 내용
     파생이라 알아서 미스가 난다.) */
  const npcs = NPCS.map((n) =>
    [
      n.id,
      n.roomId,
      n.name,
      n.persona,
      [...n.sensitiveFlags].sort().join(","),
      ...n.topics.flatMap((t) => [t.id, t.label ?? "", t.seed, t.requires ?? ""]),
    ].join("\u0001"),
  ).sort();
  return sha([...rows, flags, ...npcs].join(""), 16);
}

export const regionView = () => ({
  id: REGION,
  name: REGION_NAME,
  width: W,
  height: H,
  tiles: [...MAP],
});
