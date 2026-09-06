/* 세계의 구조 — 엔진이 소유하는 "진실". LLM은 여기에 손대지 않는다.
   # 벽 / . 통로 / S 시작 / T 보물 / E 적

   저작 주체는 '이 파일'이고 DB의 rooms 표는 그 투영이다. 이동 판정은 절대
   DB에서 읽지 않는다 — 핫패스는 이 메모리 구조다.

   ★ 지역이 여럿이다. 한 지역이 관심영역(interest)의 단위이기도 하다:
     canSee 가 지역 동일성이므로 지역 하나가 곧 "서로가 보이는 범위" 다.
     그래서 지역을 50방쯤으로 유지하면 반경 판정이나 창(window) 미니맵 없이도
     팬아웃과 스냅샷 크기가 잡힌다. 1000방을 한 지역에 넣으면 그 셋이 전부
     한꺼번에 무너진다.

   ★ 그리고 지역이 서버측 안개의 단위다. 스냅샷은 '지금 있는 지역'의 타일만
     싣는다 — 다른 지역의 지도는 클라이언트에 아예 가지 않는다.

   ★ 이 파일의 모양은 이미 '데이터' 다 (RegionDef 는 순수 데이터 객체다).
     지역이 스무 개가 되면 그대로 JSON 으로 옮기면 된다. 지금 코드에 두는
     이유는 밸런스와 달리 씨앗·구조는 고치면 재생성 비용이 나기 때문이다 —
     리뷰를 거쳐야 한다 (CLAUDE.md 의 "무엇이 코드고 무엇이 데이터인가"). */

import { createHash } from "node:crypto";
import type { Dir, Pos, RegionId, RoomId } from "../../shared/ids";
import { roomIdOf } from "../../shared/ids";
import { NPCS } from "./npcs";

/** 다른 지역으로 나가는 문 하나.
 *
 *  ★ 출구는 '벽 자리' 에만 둔다 (부팅에서 검증한다). 걸어갈 수 있는 칸을
 *    가리키면 같은 키 입력에 두 가지 뜻이 생긴다 — 한 칸 이동인가 지역 이동인가. */
export interface ExitDef {
  /** 이 칸에서 (`"x,y"`) */
  readonly at: string;
  /** 이 방향으로 나가면 */
  readonly dir: Dir;
  /** 여기로 (다른 지역의 칸) */
  readonly to: Pos;
  /** 이 플래그가 켜져야 열린다. null 이면 언제나 열려 있다. */
  readonly requires: string | null;
  /** 편도인가. false 면 반대편에도 짝이 되는 출구가 있어야 한다 (부팅에서 검증).
   *  짝이 없으면 들어갔다가 못 나오는 지역이 생기고, 그건 오타로 만들어진다. */
  readonly oneWay: boolean;
}

export interface RegionDef {
  readonly id: RegionId;
  readonly name: string;
  /** 한 줄이 y, 한 글자가 x. 모든 줄의 길이가 같아야 한다 (부팅에서 검증). */
  readonly tiles: readonly string[];
  /** `"x,y"` -> 씨앗. 걷는 칸에는 전부 있어야 한다 (부팅에서 검증). */
  readonly seeds: Readonly<Record<string, string>>;
  /** `"x,y"` -> 그 방이 반응할 플래그. 좁게 선언한다 (2^n 폭발 방지). */
  readonly sensitive: Readonly<Record<string, readonly string[]>>;
  /** `"x,y"` -> 적 id. '무엇인가' 는 content/balance/enemies.json 이 소유한다 —
   *  여기 있는 것은 '어디에 있는가' 뿐이고, 같은 적을 여러 방에 둘 수 있다. */
  readonly enemies: Readonly<Record<string, string>>;
  readonly exits: readonly ExitDef[];
}

const B1: RegionDef = {
  id: "b1",
  name: "지하 1층",
  tiles: [
    "#######",
    "#..TE.#",
    "#.###E#",
    "#..S..#",
    "#.###.#",
    "#..E..#",
    "#######",
  ],
  /** 각 칸의 "씨앗". 엔진이 정하고, 2단계부터 LLM이 이걸 문장으로 부풀린다.
   *  씨앗은 불변이다 (규칙 3). 고치면 state_hash 가 바뀌어 평범한 캐시 미스가 되고,
   *  되돌리면 옛 텍스트가 그대로 복구된다 — seed_id 가 내용 파생이기 때문이다. */
  seeds: {
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
  },
  /** 이벤트에 반응하는 방과 반응할 플래그를 명시적으로 선언한다.
   *  이걸 좁혀두지 않으면 방 하나가 가질 수 있는 상태가 2^n 으로 늘어난다
   *  (charter 47-48줄). 부팅 때 길이 <= MAX_SENSITIVE 를 assert 한다. */
  sensitive: {
    "1,4": ["guardian_slain"],
    "5,4": ["guardian_slain"],
    "1,5": ["guardian_slain"],
    "2,5": ["guardian_slain"],
    "3,5": ["guardian_slain"],
    "4,5": ["guardian_slain"],
    "5,5": ["guardian_slain"],
  },
  enemies: {
    "3,5": "shadow_warden",
    "4,1": "ashen_pages",
    "5,2": "rusted_watcher",
  },
  exits: [
    /* ★ 봉인된 문. 4a(전투) -> 3단계(플래그) -> 4b(대사) 로 이어지던 고리가
       여기서 한 번 더 이어진다 — 파수꾼을 쓰러뜨려야 문이 열리고, 제단지기의
       'sealed_door' 주제도 그때 열린다. 지역이 '얻는 것' 이 된다. */
    { at: "5,5", dir: "east", to: { region: "b2", x: 1, y: 3 }, requires: "guardian_slain", oneWay: false },
  ],
};

const B2: RegionDef = {
  id: "b2",
  name: "봉인된 서고",
  tiles: [
    "#####",
    "#..E#",
    "#.#.#",
    "#...#",
    "#####",
  ],
  seeds: {
    "1,1": "천장까지 닿는 서가가 무너지지 않은 채 서 있다. 먼지가 손대지 않은 두께로 쌓였다",
    "2,1": "바닥에 백묵으로 그린 원이 반쯤 지워져 있다",
    "3,1": "쇠사슬에 묶인 책상. 사슬은 책상이 아니라 그 위의 것을 묶고 있었다",
    "1,2": "좁은 서가 사이. 어깨가 양쪽에 닿는다",
    "3,2": "벽을 따라 촛농이 굳어 흘러내렸다. 오래전에 꺼진 것이다",
    "1,3": "봉인된 문의 안쪽. 돌아보면 문틀만 남아 있다",
    "2,3": "발밑의 돌이 하나씩 어긋나 있다. 무언가를 파냈던 자리다",
    "3,3": "가장 안쪽. 빈 받침대 하나가 남아 있다",
  },
  sensitive: {},
  enemies: {
    /* 같은 적을 다른 지역에도 둔다 — '정의' 와 '배치' 를 나눈 것이 여기서
       실제로 값을 한다 (content/balance/enemies.json 은 한 줄도 안 바뀐다). */
    "3,1": "rusted_watcher",
  },
  exits: [
    { at: "1,3", dir: "west", to: { region: "b1", x: 5, y: 5 }, requires: null, oneWay: false },
  ],
};

export const REGIONS: Readonly<Record<string, RegionDef>> = { b1: B1, b2: B2 };

export const SPAWN: Pos = { region: "b1", x: 3, y: 3 };

export const regionOf = (id: RegionId): RegionDef | undefined => REGIONS[id];
export const allRegions = (): RegionDef[] => Object.values(REGIONS);

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

export const tileAt = (region: RegionId, x: number, y: number): string => {
  const r = REGIONS[region];
  if (!r) return "#";
  const row = r.tiles[y];
  if (row === undefined || x < 0 || x >= row.length) return "#";
  return row[x]!;
};

export const walkable = (region: RegionId, x: number, y: number): boolean =>
  tileAt(region, x, y) !== "#";

export const walkableAt = (p: Pos): boolean => walkable(p.region, p.x, p.y);

/** 그 칸 그 방향에 선언된 '지역 밖으로 나가는 문'. 없으면 undefined.
 *  이동은 이걸 먼저 본다 — 출구는 벽 자리에만 있으므로 한 칸 이동과 겹치지 않는다. */
export function exitAt(from: Pos, dir: Dir): ExitDef | undefined {
  return REGIONS[from.region]?.exits.find((e) => e.at === `${from.x},${from.y}` && e.dir === dir);
}

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

/** 걷기 가능한 칸만 — 모든 지역을 통틀어. 벽('#')은 방이 아니다: 씨앗도 묘사도
 *  없는 칸에 행을 주면 이후 모든 질의가 영원히 벽을 제외하는 것을 기억해야 한다. */
export function allRooms(): RoomDef[] {
  const out: RoomDef[] = [];
  for (const r of allRegions()) {
    for (let y = 0; y < r.tiles.length; y++) {
      const row = r.tiles[y]!;
      for (let x = 0; x < row.length; x++) {
        if (!walkable(r.id, x, y)) continue;
        const k = `${x},${y}`;
        /* 침묵 폴백을 두지 않는다. 예전에는 `SEEDS[k] ?? "특징 없는 돌 통로"` 였는데,
           새 칸을 뚫고 씨앗을 빠뜨리면 아무 소리 없이 무명의 방이 하나 생겼다.
           씨앗 없는 칸은 db/seed.ts 의 assertWorldData 가 부팅에서 잡는다 —
           여기까지 왔다면 그건 프로그래밍 오류다. */
        const seed = r.seeds[k];
        if (!seed) throw new Error(`씨앗이 없는 칸 ${r.id} ${k} — assertWorldData 가 먼저 잡았어야 한다.`);
        const decl = [...new Set(r.sensitive[k] ?? [])].sort();
        out.push({
          id: roomIdOf({ region: r.id, x, y }),
          region: r.id,
          x,
          y,
          tile: tileAt(r.id, x, y),
          seed,
          seedId: seedIdOf(seed),
          sensitiveFlags: decl,
          flagsDeclHash: declHashOf(decl),
        });
      }
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
  /* 적 배치도 맵의 일부다. 빠뜨리면 배치를 옮겨도 content_hash 가 그대로라
     시더가 단축경로를 탄다. (적의 '수치' 는 여기 없다 — 그건 밸런스라
     캐시와 무관하고, 바꿔도 방을 다시 만들 이유가 없다.) */
  const placed = allRegions()
    .flatMap((r) => Object.entries(r.enemies).map(([k, id]) => `${r.id}\u0001${k}\u0001${id}`))
    .sort();
  /* 지역 간 출구도 구조다. 문이 옮겨지거나 잠금 조건이 바뀌면 세대가 달라진다. */
  const doors = allRegions()
    .flatMap((r) =>
      r.exits.map((e) =>
        [r.id, e.at, e.dir, e.to.region, e.to.x, e.to.y, e.requires ?? "", e.oneWay].join("\u0001"),
      ),
    )
    .sort();
  return sha([...rows, flags, ...npcs, ...placed, ...doors].join(""), 16);
}

/** 클라이언트에 보낼 '지금 있는 지역' 하나. 다른 지역의 지도는 나가지 않는다 —
 *  이것이 서버측 안개의 실체다. 지역이 스무 개가 되어도 스냅샷은 한 지역이다. */
export const regionView = (id: RegionId) => {
  const r = REGIONS[id] ?? REGIONS[SPAWN.region]!;
  return {
    id: r.id,
    name: r.name,
    width: Math.max(...r.tiles.map((t) => t.length)),
    height: r.tiles.length,
    tiles: [...r.tiles],
  };
};
