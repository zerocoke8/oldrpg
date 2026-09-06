/* 2단계 이음매의 '최종형' 서명. 1단계에 이 형태로 쓰고, 2단계에 한 글자도 바꾸지 않는다.
 *
 * narration/ 은 이 얼어붙은 레코드만 받는다. engine/ 도 db/ 도 import 하지 않고,
 * 텍스트를 '반환'할 뿐 기록하지 않는다 — 그래서 world_flags 를 UPDATE 할 수 있는
 * 핸들을 애초에 잡지 못한다. 기록은 호출자(server/world/roomText.ts)가 한다.
 * 이 두 방향은 .eslintrc.cjs 의 no-restricted-imports 가 빌드 에러로 강제한다. */

import type { RoomId } from "./ids";
import type { JsonScalar } from "./json";
import type { TextSource } from "./protocol";

export type { JsonScalar };

export interface RoomTextRequest {
  readonly roomId: RoomId;
  readonly stateHash: string; // `${seedId}.${declHash}.${valueDigest}`
  readonly seed: string; // 불변 씨앗
  readonly seedId: string; // sha256(seed)[0:8]
  /** '그 방이 선언한' 플래그만, 정렬된 순서로 투영된 것.
   *  전체 월드 플래그 맵을 넘기지 않는 이유: 좁음이 함수 본문의 관례가 되면,
   *  내일의 한 줄짜리 "캐시 버그 수정"이 전체를 해싱해 charter 45줄의 재앙을 만든다.
   *  narration/ 은 이 배열에서 mood 를 스스로 조립한다 —
   *  FLAG_MOOD 는 narration 의 자산이지 engine 의 자산이 아니다. */
  readonly flags: readonly (readonly [string, JsonScalar])[];
}

export interface RoomTextResult {
  readonly text: string;
  readonly source: TextSource; // 1단계: 항상 'fallback'
  readonly model: string | null; // 1단계: null
  readonly promptVersion: string | null; // 1단계: null
}

/** async 인 이유: 1단계에 await 할 것이 없어도, sync 로 만들면 2단계에 모든
 *  호출부가 바뀐다. 키워드 하나 값이다. */
export type RoomTextRenderer = (req: RoomTextRequest) => Promise<RoomTextResult>;

/* ── NPC 대사 (4b) ─────────────────────────────────────────────────────
   방 묘사와 '같은' 규약이다. 다른 것은 씨앗이 둘이라는 점뿐 —
   persona(그 사람의 목소리)와 seed(그 주제에 대해 아는 것). 둘 다 불변이고
   합쳐서 seedId 가 된다.

   narration/ 은 여기서도 DB 도 engine 도 만지지 않는다. 얼어붙은 레코드를
   받고 텍스트를 반환할 뿐이다. */

export interface NpcLineRequest {
  readonly npcId: string;
  readonly topic: string;
  readonly stateHash: string;
  readonly npcName: string;
  /** 그 사람의 목소리. 모든 주제에 함께 들어간다. */
  readonly persona: string;
  /** 이 주제에 대해 무엇을 아는가. */
  readonly seed: string;
  readonly seedId: string;
  /** 그 NPC 가 '선언한' 플래그만. 방과 같은 이유로 좁게 (charter 45줄). */
  readonly flags: readonly (readonly [string, JsonScalar])[];
}

export type NpcLineRenderer = (req: NpcLineRequest) => Promise<RoomTextResult>;
