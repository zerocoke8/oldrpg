/* 부팅 시더. 트랜잭션 하나. LLM 도 await 도 없다.
 *
 * engine/map.ts 가 원본이고 rooms 표는 그 투영이다. 코드에 없는 rooms 행은
 * '건드리지 않는다' — DELETE 하지 않으므로 CASCADE 가 생성된 텍스트를 지우는
 * 일이 없고, 도달 불가능한 방은 그냥 도달 불가능할 뿐이다.
 *
 * room_text 는 여기서 건드리지 않는다 (첫 입장 때 lazy 기록). */

import {
  allRooms,
  contentHash,
  MAX_SENSITIVE,
  SEEDS,
  WORLD_FLAGS,
  WORLD_FLAG_DEFAULTS,
  declHashOf,
  tileAt,
  H,
  W,
  walkable,
} from "../engine/map";
import { ENEMIES } from "../engine/enemies";
import { ITEMS } from "../engine/items";
import { NPCS } from "../engine/npcs";
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
export function assertWorldData(): void {
  // ① 걷는 칸에는 전부 씨앗이 있다 (침묵 폴백 금지).
  const seedless: string[] = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (walkable(x, y) && !SEEDS[`${x},${y}`]) seedless.push(`${x},${y}`);
    }
  }
  if (seedless.length) {
    throw new Error(
      `씨앗이 없는 칸: ${seedless.join(" ")} — SEEDS 에 추가하거나 벽으로 막을 것. ` +
        `묘사는 (씨앗 + 플래그)의 함수이므로 씨앗 없는 방은 존재할 수 없다.`,
    );
  }

  // ② 'E' 타일과 ENEMIES 는 양방향으로 짝이 맞는다.
  const tiles = new Set<string>();
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) if (tileAt(x, y) === "E") tiles.add(`${x},${y}`);
  }
  for (const k of tiles) {
    if (!ENEMIES[k]) throw new Error(`'E' 타일 ${k} 에 적이 선언되지 않았다 (engine/enemies.ts).`);
  }
  for (const k of Object.keys(ENEMIES)) {
    if (!tiles.has(k)) throw new Error(`적 ${ENEMIES[k]!.id} 가 'E' 가 아닌 칸 ${k} 에 있다 (engine/map.ts).`);
  }

  // ③ 세계를 바꾸는 적은 돌아오지 않는다. 그 플래그는 선언돼 있어야 한다.
  for (const [k, e] of Object.entries(ENEMIES)) {
    if (e.slainFlag !== null && e.respawnMs !== null) {
      throw new Error(
        `${e.id}(${k}) 가 플래그를 켜면서 리스폰한다. 세계가 바뀐 사건은 되돌릴 수 없으므로 ` +
          `'보스(slainFlag)' 와 '반복되는 적(respawnMs)' 중 하나여야 한다.`,
      );
    }
    if (e.slainFlag !== null && !(e.slainFlag in WORLD_FLAGS)) {
      throw new Error(`${e.id}(${k}) 가 선언되지 않은 플래그 ${e.slainFlag} 를 켠다.`);
    }
    // ④ 드랍은 선언된 아이템만. 오타 하나가 '영영 나오지 않는 전리품' 이 된다.
    for (const d of e.drops) {
      if (!(d.itemId in ITEMS)) {
        throw new Error(`${e.id}(${k}) 가 선언되지 않은 아이템 ${d.itemId} 를 떨어뜨린다.`);
      }
      if (d.qty < 1 || d.chance <= 0 || d.chance > 1) {
        throw new Error(`${e.id}(${k}) 의 드랍 ${d.itemId} 가 이상하다 (qty ${d.qty}, chance ${d.chance}).`);
      }
    }
  }

  // ⑤ 아이템 정의 자체의 정합성.
  for (const [id, it] of Object.entries(ITEMS)) {
    if (it.id !== id) throw new Error(`ITEMS 의 키 ${id} 와 id ${it.id} 가 다르다.`);
    if ((it.kind === "potion") !== (it.heal !== null)) {
      throw new Error(`${id}: potion 은 heal 이 있어야 하고 그 밖에는 없어야 한다.`);
    }
  }
}

export function seed(db: Db, q: Queries, now: number): { seededRooms: number; reaped: number } {
  assertWorldData();
  let seededRooms = 0;

  const tx = db.transaction(() => {
    // 플래그 레지스트리는 content_hash 단축경로 '밖'에서 무조건 돈다.
    // 안에 두면 새 플래그를 선언해도 시더가 건너뛰어, 그 플래그가 DB 에
    // 존재하지 않는 채 state_hash 가 계산된다 (전부 "null" 로).
    // INSERT OR IGNORE 이므로 멱등하고 사실상 공짜다.
    for (const [key, value] of Object.entries(WORLD_FLAG_DEFAULTS)) {
      q.insertFlagIfAbsent.run(key, value, now);
    }

    const want = contentHash();
    const have = q.getMeta.get("content_hash")?.value;
    if (have !== want) {
      for (const r of allRooms()) {
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
      for (const n of NPCS) {
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
