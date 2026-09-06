/* NPC 대사의 조회 -> 없으면 생성 -> DB 기록. world/roomText.ts 의 쌍둥이다.
 *
 * 여기 넘어오는 render 는 '항상' 결정론적 폴백 렌더러다 — 방과 같은 이유로
 * (규칙 4) 플레이어의 요청 경로에는 모델 호출이 존재하지 않는다. LLM 은
 * world/upgrade.ts 의 백그라운드 큐에만 있고, 준비되면 log.replace 로
 * 조용히 교체된다.
 *
 * 대사는 방 묘사보다 규칙 4 의 압박이 약하다(0.5초 전투와 달리 사람이 버튼을
 * 누르고 기다린다). 그래도 같은 구조를 쓰는 이유는 두 가지다:
 *   - "생성은 딱 한 번, 그 뒤로 모두에게 동일" 이 그대로 필요하다 (charter 20줄)
 *   - 구조가 같으면 승급·좌표락·실패 폴백을 한 번 더 만들지 않아도 된다 */

import type { RoomTextResult, NpcLineRenderer } from "../../shared/narration";
import type { World } from "../engine/world";
import { topicOf } from "../engine/npcs";
import { npcSeedId } from "../engine/npcs";
import type { Queries } from "../db/queries";

export interface NpcLine {
  text: string;
  source: RoomTextResult["source"];
  stateHash: string;
}

export interface NpcTextService {
  get(npcId: string, topic: string): Promise<NpcLine>;
}

export function makeNpcTextService(
  world: World,
  q: Queries,
  render: NpcLineRenderer,
  clock: () => number,
): NpcTextService {
  /** (npc, topic, state) 단위 인플라이트 맵. room_text 와 같은 이유 —
   *  같은 NPC 에게 두 명이 동시에 같은 것을 물어도 생성은 한 번이다. */
  const inflight = new Map<string, Promise<NpcLine>>();

  async function load(npcId: string, topicId: string, stateHash: string): Promise<NpcLine> {
    const npc = world.npc(npcId);
    const topic = npc && topicOf(npc, topicId);
    if (!npc || !topic) throw new Error(`unknown npc/topic ${npcId}/${topicId}`);

    // 1. 조회
    const hit = q.getNpcLine.get(npcId, topicId, stateHash);
    if (hit) return { text: hit.text, source: hit.source as RoomTextResult["source"], stateHash };

    // 투영과 직렬화를 await '전에' 붙잡는다 — 렌더러가 도는 동안 플래그가
    // 바뀌면 아래에서 다시 읽은 flags_json 이 이 stateHash 의 preimage 가
    // 아니게 되어 행의 키와 내용이 어긋난다 (방에서 겪은 그 결함).
    const flags = world.npcProjectFlags(npcId);
    const flagsJson = JSON.stringify(Object.fromEntries(flags));

    // 2. 생성 (narration/ 은 DB 를 만질 수 없다 — 결과를 '반환'만 한다)
    const result = await render({
      npcId,
      topic: topicId,
      stateHash,
      npcName: npc.name,
      persona: npc.persona,
      seed: topic.seed,
      seedId: npcSeedId(npc, topic),
      flags,
    });

    // 3. 기록. PK 충돌은 "남이 먼저 썼다" 이므로 무조건 재조회한다.
    q.insertNpcLineIfAbsent.run({
      npc_id: npcId,
      topic: topicId,
      state_hash: stateHash,
      text: result.text,
      source: result.source,
      flags_json: flagsJson,
      model: result.model,
      prompt_version: result.promptVersion,
      now: clock(),
    });
    const settled = q.getNpcLine.get(npcId, topicId, stateHash);
    if (!settled) throw new Error(`npc_lines 기록 직후 재조회 실패: ${npcId}/${topicId}`);
    return { text: settled.text, source: settled.source as RoomTextResult["source"], stateHash };
  }

  return {
    async get(npcId, topic) {
      const stateHash = world.npcStateHash(npcId, topic);
      const key = `${npcId}:${topic}#${stateHash}`;
      const existing = inflight.get(key);
      if (existing) return existing;
      const p = load(npcId, topic, stateHash).finally(() => inflight.delete(key));
      inflight.set(key, p);
      return p;
    },
  };
}
