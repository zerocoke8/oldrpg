/* 부팅 시더. 트랜잭션 하나. LLM 도 await 도 없다.
 *
 * engine/map.ts 가 원본이고 rooms 표는 그 투영이다. 코드에 없는 rooms 행은
 * '건드리지 않는다' — DELETE 하지 않으므로 CASCADE 가 생성된 텍스트를 지우는
 * 일이 없고, 도달 불가능한 방은 그냥 도달 불가능할 뿐이다.
 *
 * room_text 는 여기서 건드리지 않는다 (첫 입장 때 lazy 기록). */

import {
  MAX_SENSITIVE,
  declHashOf,
  type GameMap,
  type RegionDef,
} from "../engine/map";
import { DELTA, OPPOSITE } from "../../shared/ids";
import type { Balance } from "../engine/enemies";
import type { Db } from "./open";
import type { Queries } from "./queries";

/** 인증이 없으므로 유령 행이 쌓인다. 부팅 때 한 번 청소한다. */
const STALE_PLAYER_MS = 30 * 24 * 60 * 60 * 1000;

/** 코드가 소유한 세계 데이터의 정합성. 부팅에서 한 번, 트랜잭션 밖에서 본다.
 *
 *  ★ 여기 있는 것들은 전부 '주석이 약속했지만 아무도 검사하지 않던' 것이다.
 *    enemies.ts 는 "맵의 'E' 타일과 짝이 맞아야 한다 (부팅 때 검증한다)" 고
 *    적혀 있었는데 그 검증이 없었고, map.ts 의 allRooms 는 씨앗이 없는 칸을
 *    "특징 없는 돌 통로" 로 조용히 메우고 있었다 — 새 방을 뚫고 씨앗을
 *    빠뜨리면 아무 소리 없이 무명의 방이 하나 생긴다.
 *    부팅에서 죽는 편이 조용히 틀린 세계로 도는 것보다 낫다. */
export function assertWorldData(map: GameMap, balance: Balance): void {
  for (const r of map.regions()) assertRegion(map, r, balance);
  assertDoors(map);

  // ⑦ 적이 켜는 플래그는 선언돼 있어야 한다 (파일을 넘나드는 참조라 zod 가 못 본다).
  for (const [id, e] of Object.entries(balance.enemies)) {
    if (e.slainFlag !== null && !map.hasFlag(e.slainFlag)) {
      throw new Error(`enemies.json: ${id} 가 선언되지 않은 플래그 ${e.slainFlag} 를 켠다.`);
    }
  }

  /* ⑧ NPC 가 실재하는 방에 서 있는가, 그리고 그 플래그들이 선언돼 있는가. NPC 는 아직 코드에 있고(engine/npcs.ts)
     방도 데이터에 있지만 좌표가 벽일 수 있다. 아무도 안 보면 부팅이
     'FOREIGN KEY constraint failed' 라는 말로 죽는다 — 어느 NPC 가 어느 방을
     못 찾았는지는 그 메시지 어디에도 없다. 주제를 여는 플래그도 여기서 본다
     (플래그 레지스트리는 코드에, NPC 는 데이터에 있어 파일을 넘나든다). */
  const roomIds = new Set(map.rooms().map((r) => r.id));
  for (const n of map.npcs()) {
    if (!roomIds.has(n.roomId)) {
      throw new Error(`NPC ${n.id} 가 ${n.region} 의 걷는 칸이 아닌 ${n.at} 에 서 있다.`);
    }
    for (const t of n.topics) {
      if (t.requires !== null && !map.hasFlag(t.requires)) {
        throw new Error(`NPC ${n.id} 의 주제 ${t.id} 가 선언되지 않은 플래그 ${t.requires} 로 열린다.`);
      }
    }
    for (const f of n.sensitiveFlags) {
      if (!map.hasFlag(f)) {
        throw new Error(`NPC ${n.id} 가 선언되지 않은 플래그 ${f} 를 sensitive 에 적었다.`);
      }
    }
  }

  // ⑨ 스폰은 걸을 수 있는 칸이어야 한다. 아니면 모든 신규 플레이어가 벽 안에서 시작한다.
  if (!map.walkableAt(map.spawn)) {
    const s = map.spawn;
    throw new Error(`스폰 ${s.region} ${s.x},${s.y} 이 벽이다 (content/world/world.json).`);
  }
}

function assertRegion(map: GameMap, r: RegionDef, balance: Balance): void {
  // ① 줄 길이가 같은 것은 server/content/world.ts 가 이미 봤다 (그게 어긋나면
  //    x 범위가 y 마다 달라져 아래의 모든 검사가 무엇을 말하는지 알 수 없다).
  const w = r.tiles[0]?.length ?? 0;
  const h = r.tiles.length;

  // ② 걷는 칸에는 전부 씨앗이 있다 (침묵 폴백 금지).
  const seedless: string[] = [];
  const walkables = new Set<string>();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!map.walkable(r.id, x, y)) continue;
      walkables.add(`${x},${y}`);
      if (!r.seeds[`${x},${y}`]) seedless.push(`${x},${y}`);
    }
  }
  if (seedless.length) {
    throw new Error(
      `지역 ${r.id}: 씨앗이 없는 칸 ${seedless.join(" ")} — seeds 에 추가하거나 벽으로 막을 것. ` +
        `묘사는 (씨앗 + 플래그)의 함수이므로 씨앗 없는 방은 존재할 수 없다.`,
    );
  }
  // 반대 방향도 본다. 벽 자리에 씨앗을 써두면 영영 읽히지 않는다 — 오타의 흔한 모양이다.
  for (const k of Object.keys(r.seeds)) {
    if (!walkables.has(k)) throw new Error(`지역 ${r.id}: 벽인 칸 ${k} 에 씨앗이 있다.`);
  }
  for (const k of Object.keys(r.sensitive)) {
    if (!walkables.has(k)) throw new Error(`지역 ${r.id}: 벽인 칸 ${k} 이 플래그를 선언했다.`);
  }

  // ③ 선언된 플래그가 실제로 존재하는가. 오타 하나가 '영영 안 바뀌는 방' 이 된다.
  for (const [k, decl] of Object.entries(r.sensitive)) {
    for (const f of decl) {
      if (!map.hasFlag(f)) {
        throw new Error(`지역 ${r.id} ${k}: 선언되지 않은 플래그 ${f} 를 sensitive 에 적었다.`);
      }
    }
  }

  // ④ 'E' 타일과 적 '배치' 는 양방향으로 짝이 맞는다.
  const eTiles = new Set<string>();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) if (map.tileAt(r.id, x, y) === "E") eTiles.add(`${x},${y}`);
  }
  for (const k of eTiles) {
    if (!r.enemies[k]) throw new Error(`지역 ${r.id}: 'E' 타일 ${k} 에 적이 배치되지 않았다.`);
  }
  for (const [k, id] of Object.entries(r.enemies)) {
    if (!eTiles.has(k)) throw new Error(`지역 ${r.id}: 적 ${id} 가 'E' 가 아닌 칸 ${k} 에 배치됐다.`);
    // ⑤ 배치된 적이 실제로 정의돼 있는가. '어디에' 와 '무엇인가' 가 갈라져 있으므로
    //    이 참조는 파일을 넘나든다 — zod 가 못 보고 여기서만 잡힌다.
    if (!(id in balance.enemies)) {
      throw new Error(`지역 ${r.id} ${k} 에 배치된 ${id} 가 content/balance/enemies.json 에 없다.`);
    }
  }
}

/** ⑥ 지역 간 문. 오타 하나가 '들어갔다 못 나오는 지역' 이나 '아무 데도 없는 지역'
 *  을 만든다 — 어느 쪽이든 플레이어가 갇히고 나서야 알게 된다. */
function assertDoors(map: GameMap): void {
  for (const r of map.regions()) {
    for (const e of r.exits) {
      const where = `지역 ${r.id} 의 출구 ${e.at} ${e.dir}`;
      const [ax, ay] = e.at.split(",").map(Number);
      if (ax === undefined || ay === undefined || Number.isNaN(ax) || Number.isNaN(ay)) {
        throw new Error(`${where}: at 이 "x,y" 형식이 아니다.`);
      }
      // 출발 칸은 걸을 수 있어야 한다 — 아무도 설 수 없는 칸의 문은 존재하지 않는 문이다.
      if (!map.walkable(r.id, ax, ay)) throw new Error(`${where}: 출발 칸이 벽이다.`);
      // 그 방향은 벽이어야 한다. 걸어갈 수 있는 칸을 가리키면 같은 키 입력에
      // 두 가지 뜻이 생긴다 (한 칸 이동인가 지역 이동인가).
      const d = DELTA[e.dir];
      if (map.walkable(r.id, ax + d.dx, ay + d.dy)) {
        throw new Error(`${where}: 그 방향이 벽이 아니다 — 한 칸 이동과 뜻이 겹친다.`);
      }
      const dst = map.region(e.to.region);
      if (!dst) throw new Error(`${where}: 목적지 지역 ${e.to.region} 이 없다.`);
      if (!map.walkableAt(e.to)) {
        throw new Error(`${where}: 목적지 ${e.to.region} ${e.to.x},${e.to.y} 이 벽이다.`);
      }
      if (e.requires !== null && !map.hasFlag(e.requires)) {
        throw new Error(`${where}: 선언되지 않은 플래그 ${e.requires} 를 requires 로 쓴다.`);
      }
      if (e.oneWay) continue;
      // 왕복이라고 선언했으면 반대편에 짝이 있어야 한다. 없으면 갇힌다.
      const back = dst.exits.find(
        (b) =>
          b.at === `${e.to.x},${e.to.y}` &&
          b.dir === OPPOSITE[e.dir] &&
          b.to.region === r.id &&
          b.to.x === ax &&
          b.to.y === ay,
      );
      if (!back) {
        throw new Error(
          `${where}: 왕복인데 ${e.to.region} ${e.to.x},${e.to.y} 에서 ${OPPOSITE[e.dir]} 로 ` +
            `돌아오는 짝이 없다 — 들어가면 못 나온다.`,
        );
      }
    }
  }
}

export function seed(db: Db, q: Queries, map: GameMap, balance: Balance, now: number): { seededRooms: number; reaped: number } {
  assertWorldData(map, balance);
  let seededRooms = 0;

  const tx = db.transaction(() => {
    // 플래그 레지스트리는 content_hash 단축경로 '밖'에서 무조건 돈다.
    // 안에 두면 새 플래그를 선언해도 시더가 건너뛰어, 그 플래그가 DB 에
    // 존재하지 않는 채 state_hash 가 계산된다 (전부 "null" 로).
    // INSERT OR IGNORE 이므로 멱등하고 사실상 공짜다.
    for (const [key, value] of Object.entries(map.flagDefaults())) {
      q.insertFlagIfAbsent.run(key, value, now);
    }

    const want = map.contentHash();
    const have = q.getMeta.get("content_hash")?.value;
    if (have !== want) {
      for (const r of map.rooms()) {
        if (r.sensitiveFlags.length > MAX_SENSITIVE) {
          // charter 47-48줄: 방 하나가 2^n 개의 상태를 갖는 것을 부팅에서 막는다.
          throw new Error(
            `${r.id} 이 ${r.sensitiveFlags.length}개의 플래그를 선언했다 (상한 ${MAX_SENSITIVE}). ` +
              `방마다 반응할 플래그를 반드시 좁게 선언한다.`,
          );
        }
        const info = q.upsertRoom.run({
          id: r.id,
          region: r.region,
          x: r.x,
          y: r.y,
          tile: r.tile,
          seed: r.seed,
          seed_id: r.seedId,
          sensitive_flags: JSON.stringify(r.sensitiveFlags),
          flags_decl_hash: r.flagsDeclHash,
          now,
        });
        seededRooms += info.changes;
      }
      // NPC 도 같은 방식으로 투영한다 (저작 주체는 코드, 표는 그림자).
      for (const n of map.npcs()) {
        const decl = [...new Set(n.sensitiveFlags)].sort();
        if (decl.length > MAX_SENSITIVE) {
          throw new Error(
            `NPC ${n.id} 이 ${decl.length}개의 플래그를 선언했다 (상한 ${MAX_SENSITIVE}).`,
          );
        }
        q.upsertNpc.run({
          id: n.id,
          room_id: n.roomId,
          name: n.name,
          persona_seed: n.persona,
          sensitive_flags: JSON.stringify(decl),
          flags_decl_hash: declHashOf(decl),
          now,
        });
      }

      q.setMeta.run("content_hash", want, now);
    }
  });
  tx();

  const reaped = q.reapStalePlayers.run(now - STALE_PLAYER_MS).changes;
  return { seededRooms, reaped };
}

export function loadFlags(q: Queries): Map<string, string> {
  return new Map(q.allFlags.all().map((r) => [r.key, r.value]));
}
