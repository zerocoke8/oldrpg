/* NPC 와 대화 주제의 '선언'. SEEDS / ENEMIES 와 같은 방식으로 코드가 소유하고,
 * npcs 표는 그 투영이다.
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
import type { RoomId } from "../../shared/ids";

export interface TopicDef {
  readonly id: string;
  /** 대화 메뉴의 라벨. greet 은 null — 버튼이 아니라 말을 걸면 나오는 인사다. */
  readonly label: string | null;
  /** 이 주제에 대해 무엇을 말하는가. 불변. */
  readonly seed: string;
  /** 이 플래그가 켜져야 열리는 주제. null 이면 항상 열려 있다. */
  readonly requires: string | null;
}

export interface NpcDef {
  readonly id: string; // 전역 유일. ':' 를 쓰지 않는다 (승급 큐 키의 구분자).
  readonly roomId: RoomId;
  readonly name: string;
  /** 그 사람의 목소리. 모든 주제의 프롬프트에 함께 들어간다. */
  readonly persona: string;
  /** 이 NPC 가 반응하는 플래그. 방과 같은 이유로 좁게 선언한다
   *  (charter 47-48줄: 2^n 폭발 방지). */
  readonly sensitiveFlags: readonly string[];
  readonly topics: readonly TopicDef[];
}

export const GREET = "greet";

export const NPCS: readonly NpcDef[] = [
  {
    id: "altar_keeper",
    roomId: "b1:3,1", // 낮은 제단이 있는 방
    name: "제단지기",
    persona:
      "무너진 서고의 제단을 지키는 늙은 사제. 눈이 어둡고 말수가 적다. " +
      "짧게 끊어 말하며, 묻지 않은 것은 말하지 않는다",
    sensitiveFlags: ["guardian_slain"],
    topics: [
      {
        id: GREET,
        label: null,
        seed: "낯선 이를 흘깃 보고는 다시 제단으로 시선을 돌린다. 인사라기보다 확인에 가깝다",
        requires: null,
      },
      {
        id: "warden",
        label: "파수꾼에 대해",
        seed: "남쪽 홀을 지키는 그림자 파수꾼. 오래전부터 거기 있었고, 무엇을 지키는지는 말하지 않는다",
        requires: null,
      },
      {
        id: "altar",
        label: "제단에 대해",
        seed: "제단 위의 낡은 상자. 자신이 지키는 것이지만 열어 본 적은 없다",
        requires: null,
      },
      {
        // ★ 파수꾼을 쓰러뜨려야 열린다. 4a -> 3단계 -> 4b 가 여기서 이어진다.
        id: "sealed_door",
        label: "봉인된 문에 대해",
        seed:
          "동쪽 끝의 봉인된 문. 파수꾼이 사라진 지금에야 말할 수 있는 것이고, " +
          "그 너머에 무엇이 있는지는 자신도 모른다",
        requires: "guardian_slain",
      },
    ],
  },
];

export const NPC_BY_ID: Readonly<Record<string, NpcDef>> = Object.fromEntries(
  NPCS.map((n) => [n.id, n]),
);

const sha = (s: string, n: number): string =>
  createHash("sha256").update(s, "utf8").digest("hex").slice(0, n);

/** 그 (NPC, 주제) 씨앗의 신원. persona 와 topic.seed 를 '함께' 해시한다 —
 *  목소리를 고쳐도, 아는 것을 고쳐도 캐시 미스가 되어야 한다.
 *  내용 파생이므로 되돌리면 옛 대사가 그대로 복구된다 (방과 같은 성질). */
export const npcSeedId = (npc: NpcDef, topic: TopicDef): string =>
  sha(`${npc.persona}\n${topic.seed}`, 8);

export const topicOf = (npc: NpcDef, topicId: string): TopicDef | undefined =>
  npc.topics.find((t) => t.id === topicId);

export const npcsInRoom = (roomId: RoomId): NpcDef[] => NPCS.filter((n) => n.roomId === roomId);

/** 그 플래그를 선언한 NPC 들. 3단계의 영향 범위가 "방·NPC" 인 근거
 *  (charter 59줄). */
export const npcsSensitiveTo = (flag: string): NpcDef[] =>
  NPCS.filter((n) => n.sensitiveFlags.includes(flag));
