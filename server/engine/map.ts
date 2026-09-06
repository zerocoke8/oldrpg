/* 세계의 '구조' 를 다루는 순수 코드. 구조 자체(타일·씨앗·출구)는 여기 없다 —
   content/world/ 에 있고 server/content/world.ts 가 읽어 검증해 주입한다.
   engine/ 은 파일을 읽지 않는다 (밸런스·난수·시계·렌더러와 똑같은 방식).

   # 벽 / . 통로 / S 시작 / T 보물 / E 적

   저작 주체는 '그 JSON' 이고 DB의 rooms 표는 그 투영이다. 이동 판정은 절대
   DB에서 읽지 않는다 — 핫패스는 makeMap 이 만든 메모리 구조다.

   ★ 지역이 여럿이다. 한 지역이 관심영역(interest)의 단위이기도 하다:
     canSee 가 지역 동일성이므로 지역 하나가 곧 "서로가 보이는 범위" 다.
     그래서 지역을 50방쯤으로 유지하면 반경 판정이나 창(window) 미니맵 없이도
     팬아웃과 스냅샷 크기가 잡힌다. 1000방을 한 지역에 넣으면 그 셋이 전부
     한꺼번에 무너진다.

   ★ 그리고 지역이 서버측 안개의 단위다. 스냅샷은 '지금 있는 지역'의 타일만
     싣는다 — 다른 지역의 지도는 클라이언트에 아예 가지 않는다.

   ★ 무엇이 여기 남고 무엇이 JSON 으로 갔는가
     간 것 : 타일·씨앗·sensitive·적 배치·출구·이름 — 저작의 대상이다.
     남은 것: 해시 공식, 플래그 레지스트리, 상한, 타일 문자의 뜻 — 규칙이다. */

import { createHash } from "node:crypto";
import type { Dir, Pos, RegionId, RoomId } from "../../shared/ids";
import { roomIdOf } from "../../shared/ids";
import type { NpcDef, NpcPlacement } from "./npcs";

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
  /** `"x,y"` -> 씨앗. 걷는 칸에는 전부 있어야 한다 (부팅에서 검증).
   *  씨앗은 불변이다 (규칙 3). 고치면 state_hash 가 바뀌어 평범한 캐시 미스가 되고,
   *  되돌리면 옛 텍스트가 그대로 복구된다 — seed_id 가 내용 파생이기 때문이다. */
  readonly seeds: Readonly<Record<string, string>>;
  /** `"x,y"` -> 그 방이 반응할 플래그. 좁게 선언한다 (2^n 폭발 방지). */
  readonly sensitive: Readonly<Record<string, readonly string[]>>;
  /** `"x,y"` -> 적 id. '무엇인가' 는 content/balance/enemies.json 이 소유한다 —
   *  여기 있는 것은 '어디에 있는가' 뿐이고, 같은 적을 여러 방에 둘 수 있다. */
  readonly enemies: Readonly<Record<string, string>>;
  /** id -> 그 지역에 서 있는 NPC. 키가 곧 id 다 (전역 유일, 부팅에서 검증).
   *  적과 같은 자리에 있는 이유도 같다 — '어디에 있는가' 는 맵의 일이다. */
  readonly npcs: Readonly<Record<string, NpcPlacement>>;
  readonly exits: readonly ExitDef[];
}

/** server/content/world.ts 가 읽어 검증한 뒤 넘겨주는 것. */
export interface MapData {
  readonly regions: readonly RegionDef[];
  readonly spawn: Pos;
  /** 존재하는 모든 월드 플래그. 세계마다 다르므로 지역·씨앗과 같은 데이터다. */
  readonly flags: Readonly<Record<string, WorldFlagDef>>;
}

export const MAX_SENSITIVE = 4;

/** 플래그 하나의 선언. content/world/world.json 의 `flags` 에 있다.
 *
 *  ★ broadcast 가 왜 데이터인가: 플래그마다 스포일러인지 아닌지가 다르고,
 *    그건 세계관의 결정이다 (secret_door_found 는 감추고 boss_slain 은 공개).
 *    코드에 두면 세계를 갈아끼울 때 옛 세계의 플래그가 남는다. */
export interface WorldFlagDef {
  /** JSON 스칼라의 정규 표기. world_flags.value 에 이 문자열이 그대로 들어간다. */
  readonly default: string;
  /** 클라이언트에 값을 공개할 것인가.
   *  플래그는 쉽게 스포일러가 된다(secret_door_found 같은 것). 공개는 옵트인이고,
   *  꺼진 것은 snapshot.world 와 world.flag 에 아예 나가지 않는다. */
  readonly broadcast: boolean;
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

/** 클라이언트에 보낼 '지금 있는 지역' 하나. */
export interface RegionSlice {
  id: RegionId;
  name: string;
  width: number;
  height: number;
  tiles: string[];
}

const sha = (s: string, n: number): string =>
  createHash("sha256").update(s, "utf8").digest("hex").slice(0, n);

/** 해시 preimage 의 필드 구분자. 본문에 나올 수 없는 문자여야 한다 —
 *  구분자 없이 이어 붙이면 ["ab","c"] 와 ["a","bc"] 가 같은 preimage 가 된다.
 *
 *  ★ 이 상수를 도입하면서 content_hash 값이 한 번 바뀐다. 옛 코드는 구분자를
 *    자리마다 다르게 쓰고 있었다(어떤 곳은 빈 문자열). 값이 바뀌면 시더가
 *    단축경로를 한 번 건너뛰고 rooms/npcs 를 다시 upsert 할 뿐이다 —
 *    UPSERT 라 멱등하고, room_text 는 state_hash 로 키가 잡히므로
 *    생성된 텍스트는 한 줄도 건드려지지 않는다. */
const SEP = "\u0001";

/** 씨앗의 '신원'. 카운터가 아니라 내용 파생인 것이 중요하다:
 *  씨앗을 A -> B -> A 로 되돌리면 원래 state_hash 로 돌아와 옛 텍스트가
 *  그대로 복구된다. 플래그 되돌림과 동작이 일치한다 (charter 51줄). */
export const seedIdOf = (seed: string): string => sha(seed, 8);

/** 선언된 플래그 '이름'들의 지문. state_hash 의 구성요소이지 장식이 아니다.
 *  선언을 추가·삭제·재정렬하면 이 값이 바뀌어, 옛 행이 '다른 상태'로
 *  오독되는 대신 그냥 깨끗한 미스가 된다. */
export const declHashOf = (sortedNames: readonly string[]): string => sha(sortedNames.join("\n"), 8);

export interface GameMap {
  readonly spawn: Pos;
  region(id: RegionId): RegionDef | undefined;
  regions(): RegionDef[];
  tileAt(region: RegionId, x: number, y: number): string;
  walkable(region: RegionId, x: number, y: number): boolean;
  walkableAt(p: Pos): boolean;
  exitAt(from: Pos, dir: Dir): ExitDef | undefined;
  rooms(): RoomDef[];
  /** 모든 지역의 NPC. 지역·방이 붙은 모습이다. */
  npcs(): NpcDef[];
  npc(id: string): NpcDef | undefined;
  npcsInRoom(roomId: RoomId): NpcDef[];
  /** 그 플래그를 선언한 NPC 들. 3단계의 영향 범위가 "방·NPC" 인 근거. */
  npcsSensitiveTo(flag: string): NpcDef[];
  /** 이 세계에 선언된 플래그인가. 아닌 것을 켜려 하면 그건 오타다. */
  hasFlag(key: string): boolean;
  /** 클라이언트에 값을 공개할 플래그인가. 공개는 옵트인이다 (스포일러 방지). */
  isBroadcastFlag(key: string): boolean;
  /** 시더가 쓰는 key -> default 문자열. */
  flagDefaults(): Readonly<Record<string, string>>;
  /** 선언된 플래그 이름 전부. */
  flagKeys(): string[];
  contentHash(): string;
  view(id: RegionId): RegionSlice;
}

/** 주입된 지역들로 만든 '읽기 전용 맵'. 부팅에서 한 번 만들고 그 뒤로는
 *  순수 조회다 — 이동의 핫패스가 여기를 때린다.
 *
 *  자유 함수가 아니라 객체인 이유: 지역 데이터가 이제 바깥에서 온다.
 *  모듈 전역에 두고 setRegions() 로 밀어넣으면 '아직 안 채워진 맵' 이라는
 *  상태가 생기고, 테스트가 서로의 세계를 덮어쓴다. */
export function makeMap(data: MapData): GameMap {
  const byId = new Map<RegionId, RegionDef>(data.regions.map((r) => [r.id, r]));

  const tileAt = (region: RegionId, x: number, y: number): string => {
    const r = byId.get(region);
    if (!r) return "#";
    const row = r.tiles[y];
    if (row === undefined || x < 0 || x >= row.length) return "#";
    return row[x]!;
  };
  const walkable = (region: RegionId, x: number, y: number): boolean =>
    tileAt(region, x, y) !== "#";

  /** 걷기 가능한 칸만 — 모든 지역을 통틀어. 벽('#')은 방이 아니다: 씨앗도 묘사도
   *  없는 칸에 행을 주면 이후 모든 질의가 영원히 벽을 제외하는 것을 기억해야 한다. */
  const rooms = (): RoomDef[] => {
    const out: RoomDef[] = [];
    for (const r of data.regions) {
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
          if (!seed) {
            throw new Error(`씨앗이 없는 칸 ${r.id} ${k} — assertWorldData 가 먼저 잡았어야 한다.`);
          }
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
  };

  /* 배치에 지역·방을 붙여 한 번만 만든다. 코드가 보는 것은 언제나 이쪽이고,
     "b1:3,1" 같은 문자열을 사람이 손으로 적는 자리는 이제 없다. */
  const npcList: NpcDef[] = data.regions.flatMap((r) =>
    Object.entries(r.npcs).map(([id, n]) => ({
      ...n,
      id,
      region: r.id,
      roomId: `${r.id}:${n.at}`,
    })),
  );
  const npcById = new Map<string, NpcDef>(npcList.map((n) => [n.id, n]));

  return {
    spawn: data.spawn,
    region: (id) => byId.get(id),
    regions: () => [...data.regions],
    tileAt,
    walkable,
    walkableAt: (p) => walkable(p.region, p.x, p.y),

    /** 그 칸 그 방향에 선언된 '지역 밖으로 나가는 문'. 없으면 undefined.
     *  이동은 이걸 먼저 본다 — 출구는 벽 자리에만 있으므로 한 칸 이동과 겹치지 않는다. */
    exitAt: (from, dir) =>
      byId.get(from.region)?.exits.find((e) => e.at === `${from.x},${from.y}` && e.dir === dir),

    rooms,
    npcs: () => [...npcList],
    npc: (id) => npcById.get(id),
    npcsInRoom: (roomId) => npcList.filter((n) => n.roomId === roomId),
    npcsSensitiveTo: (flag) => npcList.filter((n) => n.sensitiveFlags.includes(flag)),

    hasFlag: (key) => key in data.flags,
    isBroadcastFlag: (key) => data.flags[key]?.broadcast === true,
    flagDefaults: () =>
      Object.fromEntries(Object.entries(data.flags).map(([k, v]) => [k, v.default])),
    flagKeys: () => Object.keys(data.flags),

    /** "코드 맵과 DB rooms 가 같은 세대인가"를 한 번에 판정한다.
     *  플래그 레지스트리도 preimage 에 넣는다 — 안 그러면 새 플래그를 선언해도
     *  content_hash 가 그대로라 시더가 단축경로를 타 버린다. */
    contentHash(): string {
      const rows = rooms()
        .map((r) => [r.id, r.tile, r.seed, r.sensitiveFlags.join(",")].join(SEP))
        .sort();
      const flags = Object.keys(data.flags).sort().join(",");
      /* NPC 도 같은 해시에 들어간다. 빠뜨리면 시더의 단축경로가 살아 있는 채로
         persona 나 방을 고쳐도 npcs 표가 옛 값을 유지한다 — "표는 코드의 그림자"
         라는 성질이 조용히 깨진다. (대사 캐시는 별개다: 그쪽은 seed_id 가
         persona+topic.seed 파생이라 알아서 미스가 난다 — npcSeedId 참조.) */
      const npcs = npcList
        .map((n) =>
          [
            n.id,
            n.roomId,
            n.name,
            n.persona,
            [...n.sensitiveFlags].sort().join(","),
            ...n.topics.flatMap((t) => [t.id, t.label ?? "", t.seed, t.requires ?? ""]),
          ].join(SEP),
        )
        .sort();
      /* 적 배치도 맵의 일부다. 빠뜨리면 배치를 옮겨도 content_hash 가 그대로라
         시더가 단축경로를 탄다. (적의 '수치' 는 여기 없다 — 그건 밸런스라
         캐시와 무관하고, 바꿔도 방을 다시 만들 이유가 없다.) */
      const placed = data.regions
        .flatMap((r) => Object.entries(r.enemies).map(([k, id]) => [r.id, k, id].join(SEP)))
        .sort();
      /* 지역 간 출구도 구조다. 문이 옮겨지거나 잠금 조건이 바뀌면 세대가 달라진다. */
      const doors = data.regions
        .flatMap((r) =>
          r.exits.map((e) =>
            [r.id, e.at, e.dir, e.to.region, e.to.x, e.to.y, e.requires ?? "", e.oneWay].join(SEP),
          ),
        )
        .sort();
      return sha([...rows, flags, ...npcs, ...placed, ...doors].join(SEP), 16);
    },

    /** 클라이언트에 보낼 '지금 있는 지역' 하나. 다른 지역의 지도는 나가지 않는다 —
     *  이것이 서버측 안개의 실체다. 지역이 스무 개가 되어도 스냅샷은 한 지역이다. */
    view(id: RegionId): RegionSlice {
      const r = byId.get(id) ?? byId.get(data.spawn.region)!;
      return {
        id: r.id,
        name: r.name,
        width: Math.max(...r.tiles.map((t) => t.length)),
        height: r.tiles.length,
        tiles: [...r.tiles],
      };
    },
  };
}
