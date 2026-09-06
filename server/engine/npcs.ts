/* NPC 와 대화 주제의 '규칙'. 선언 자체(누가 어디 있고 무엇을 아는가)는 여기
 * 없다 — content/world/regions/<id>.json 의 `npcs` 에 있고, server/content/world.ts
 * 가 읽어 검증해 주입한다. 방과 정확히 같은 방식이다.
 *
 * ★ NPC 가 '지역 파일 안에' 사는 이유: NPC 는 방에 서 있고 방은 지역에 있다.
 *   전역 목록으로 두면 roomId 를 "b1:3,1" 같은 문자열로 적게 되고, 그 문자열이
 *   지역과 어긋나도 아무도 모른다 (실제로 부팅이 'FOREIGN KEY constraint failed'
 *   로 죽은 적이 있다). 지역 안에 두면 좌표만 적으면 되고, 그 좌표가 그 지역의
 *   걷는 칸인지는 같은 파일을 보는 검증기가 바로 안다.
 *
 * ★ 규칙 3 이 여기서도 그대로다: 씨앗은 불변이고 대사는 (씨앗 + 플래그)의
 *   함수다. NPC 는 씨앗이 둘로 나뉜다 —
 *     persona  : 그 사람의 목소리 (모든 주제에 함께 들어간다)
 *     topic.seed: 그 주제에 대해 무엇을 아는가
 *   둘 다 불변이고, 둘을 합친 것이 seed_id 가 된다. 하나만 고쳐도 캐시 미스다.
 *
 * ★ 주제는 플래그로 열린다 (requires). 파수꾼을 쓰러뜨리면 '봉인된 문' 주제가
 *   열린다 — 4a(전투) -> 3단계(플래그) -> 4b(대사)가 한 줄로 이어진다. */

import { createHash } from "node:crypto";
import type { RegionId, RoomId } from "../../shared/ids";

export interface TopicDef {
  readonly id: string;
  /** 대화 메뉴의 라벨. greet 은 null — 버튼이 아니라 말을 걸면 나오는 인사다. */
  readonly label: string | null;
  /** 이 주제에 대해 무엇을 말하는가. 불변. */
  readonly seed: string;
  /** 이 플래그가 켜져야 열리는 주제. null 이면 항상 열려 있다. */
  readonly requires: string | null;
}

/** 지역 파일에 적히는 모습. 여기에는 지역도 roomId 도 없다 — 어느 지역인지는
 *  '어느 파일에 있는가' 가 말해 주고, 방은 좌표가 말해 준다. */
export interface NpcPlacement {
  /** `"x,y"`. 그 지역의 걷는 칸이어야 한다 (부팅에서 검증). */
  readonly at: string;
  readonly name: string;
  /** 그 사람의 목소리. 모든 주제의 프롬프트에 함께 들어간다. */
  readonly persona: string;
  /** 이 NPC 가 반응하는 플래그. 방과 같은 이유로 좁게 선언한다
   *  (charter 47-48줄: 2^n 폭발 방지). */
  readonly sensitiveFlags: readonly string[];
  /** 순서가 곧 대화 메뉴의 순서다. 그래서 객체가 아니라 배열이고,
   *  id 가 항목 안에 있다 (지역·적과 달리 키가 id 가 아닌 유일한 곳). */
  readonly topics: readonly TopicDef[];
}

/** makeMap 이 배치에 지역·방을 붙여 만든 것. 코드가 보는 것은 언제나 이쪽이다. */
export interface NpcDef extends NpcPlacement {
  readonly id: string; // 전역 유일. ':' 를 쓰지 않는다 (승급 큐 키의 구분자).
  readonly region: RegionId;
  readonly roomId: RoomId;
}

export const GREET = "greet";

const sha = (s: string, n: number): string =>
  createHash("sha256").update(s, "utf8").digest("hex").slice(0, n);

/** 그 (NPC, 주제) 씨앗의 신원. persona 와 topic.seed 를 '함께' 해시한다 —
 *  목소리를 고쳐도, 아는 것을 고쳐도 캐시 미스가 되어야 한다.
 *  내용 파생이므로 되돌리면 옛 대사가 그대로 복구된다 (방과 같은 성질).
 *
 *  ★ 여기에 id 도 방도 들어가지 않는다. NPC 를 다른 방으로 옮기거나 이름을
 *    바꿔도 이미 만든 대사는 그대로다 — 대사는 '누가 어디 있는가' 가 아니라
 *    '무엇을 어떤 목소리로 아는가' 의 함수이기 때문이다. */
export const npcSeedId = (npc: Pick<NpcDef, "persona">, topic: TopicDef): string =>
  sha(`${npc.persona}\n${topic.seed}`, 8);

export const topicOf = (npc: NpcDef, topicId: string): TopicDef | undefined =>
  npc.topics.find((t) => t.id === topicId);
