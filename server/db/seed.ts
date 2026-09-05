/* 부팅 시더. 트랜잭션 하나. LLM 도 await 도 없다.
 *
 * engine/map.ts 가 원본이고 rooms 표는 그 투영이다. 코드에 없는 rooms 행은
 * '건드리지 않는다' — DELETE 하지 않으므로 CASCADE 가 생성된 텍스트를 지우는
 * 일이 없고, 도달 불가능한 방은 그냥 도달 불가능할 뿐이다.
 *
 * room_text 는 여기서 건드리지 않는다 (첫 입장 때 lazy 기록). */

import { allRooms, contentHash, MAX_SENSITIVE, WORLD_FLAG_DEFAULTS } from "../engine/map";
import type { Db } from "./open";
import type { Queries } from "./queries";

/** 인증이 없으므로 유령 행이 쌓인다. 부팅 때 한 번 청소한다. */
const STALE_PLAYER_MS = 30 * 24 * 60 * 60 * 1000;

export function seed(db: Db, q: Queries, now: number): { seededRooms: number; reaped: number } {
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
