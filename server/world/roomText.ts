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

export interface RoomText {
  text: string;
  source: RoomTextResult["source"];
  /** 호출자가 '이 줄' 을 승급 대상으로 등록할 때 쓰는 키.
   *  와이어에는 절대 나가지 않는다 (프로토콜 불변식 2). */
  stateHash: string;
}

export interface RoomTextService {
  get(roomId: RoomId): Promise<RoomText>;
}

/** ★ 여기 넘어오는 render 는 '항상' 결정론적 폴백 렌더러다. LLM 이 아니다.
 *
 *  규칙 4("플레이어를 LLM 앞에 세워두지 않는다")를 코드 구조로 만든 것이다:
 *  플레이어의 요청 경로에는 모델 호출이 아예 존재하지 않으므로, 실수로
 *  기다리게 만들 방법이 없다. LLM 은 world/upgrade.ts 의 백그라운드 큐에만
 *  있고, 결과는 준비되면 log.replace 로 조용히 교체된다. */
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
   *  room_gen_lock 표는 만들지 않는다.
   *
   *  2단계에도 여기 도는 것은 폴백 렌더러라 사실상 즉시 해소된다.
   *  LLM 쪽의 중복 제거는 narration/queue.ts 가 같은 키로 따로 한다. */
  const inflight = new Map<string, Promise<RoomText>>();

  async function load(roomId: RoomId, stateHash: string) {
    const room = world.room(roomId);
    if (!room) throw new Error(`unknown room ${roomId}`);

    // 1. 조회
    const hit = q.getRoomText.get(roomId, stateHash);
    if (hit) return { text: hit.text, source: hit.source as RoomTextResult["source"], stateHash };

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
    return { text: settled.text, source: settled.source as RoomTextResult["source"], stateHash };
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
