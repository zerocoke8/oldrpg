/* ★ 2단계 이음매. engine(씨앗·해시·투영) + db(room_text) + narration(렌더러)을
 *   조합하는 '유일한' 곳이다. engine/ 도 narration/ 도 서로를 모른다.
 *
 * charter 50줄: "캐시 조회 -> 없으면 생성 -> DB 기록. 이 순서는 항상 동일하다."
 * 1단계에 부팅 프리시드를 하지 않는 이유가 이것이다 — 프리시드하면 조회만
 * 실행되고 생성·기록이 죽은 코드가 된다. lazy 로 두면 두 브라우저로 걸어
 * 다니는 것만으로 세 단계가 매 첫 방문마다 진짜로 돈다. */

import type { RoomId } from "../../shared/ids";
import type { RoomTextRenderer, RoomTextResult } from "../../shared/narration";
import type { World } from "../engine/world";
import type { Queries } from "../db/queries";

export interface RoomTextService {
  get(roomId: RoomId): Promise<{ text: string; source: RoomTextResult["source"] }>;
}

export function makeRoomTextService(
  world: World,
  q: Queries,
  render: RoomTextRenderer,
  clock: () => number,
): RoomTextService {
  /** 인플라이트 맵. 1단계에는 렌더러가 동기라 사실상 비어 있지만, 2단계에
   *  LLM 이 들어오면 '같은 방에 동시 진입한 두 명'이 API 를 두 번 호출하는
   *  것을 막는다 (charter 21줄).
   *
   *  정확성 보증이 아니라 '비용' 보증이라는 점이 중요하다. 정확성은
   *  PRIMARY KEY + INSERT ... ON CONFLICT DO NOTHING + 재조회가 이미 쥐고
   *  있고, 그건 프로세스를 넘어서도 성립한다. 단일 프로세스로 가기로 했으므로
   *  room_gen_lock 표는 만들지 않는다. */
  const inflight = new Map<string, Promise<{ text: string; source: RoomTextResult["source"] }>>();

  async function load(roomId: RoomId, stateHash: string) {
    const room = world.room(roomId);
    if (!room) throw new Error(`unknown room ${roomId}`);

    // 1. 조회
    const hit = q.getRoomText.get(roomId, stateHash);
    if (hit) return { text: hit.text, source: hit.source as RoomTextResult["source"] };

    // 2. 생성 (narration/ 은 DB 를 만질 수 없다 — 결과를 '반환'만 한다)
    const result = await render({
      roomId,
      stateHash,
      seed: room.seed,
      seedId: room.seedId,
      flags: world.projectFlags(roomId),
    });

    // 3. 기록. PK 충돌은 오류가 아니라 "남이 먼저 썼다" 이므로 무조건 재조회한다.
    //    이 두 줄이 규칙 2("생성은 딱 한 번")의 정확성 부분이다.
    const now = clock();
    q.insertRoomTextIfAbsent.run({
      room_id: roomId,
      state_hash: stateHash,
      text: result.text,
      source: result.source,
      flags_json: world.flagsJson(roomId),
      model: result.model,
      prompt_version: result.promptVersion,
      now,
    });
    const settled = q.getRoomText.get(roomId, stateHash);
    if (!settled) throw new Error(`room_text 기록 직후 재조회 실패: ${roomId} ${stateHash}`);
    return { text: settled.text, source: settled.source as RoomTextResult["source"] };
  }

  return {
    async get(roomId: RoomId) {
      const stateHash = world.stateHash(roomId);
      const key = `${roomId}#${stateHash}`;
      const existing = inflight.get(key);
      if (existing) return existing;

      const p = load(roomId, stateHash).finally(() => inflight.delete(key));
      inflight.set(key, p);
      return p;
    },
  };
}
