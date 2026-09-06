/* 런타임 검증기는 타입 옆에 산다. 이게 계약이지 구현 세부가 아니기 때문이다.
 *
 * TypeScript 는 컴파일러가 없는 쪽에서 온 바이트에 대해 아무것도 보장하지 않는다.
 * `dir: "__proto__"` 는 `Dir` 로 선언된 자리에 완벽하게 들어앉는다.
 * 그래서 charter 82줄("서버는 클라이언트가 보낸 액션의 유효성을 전부 재검증한다")은
 * 타입이 아니라 아래 스키마들이 이행한다.
 *
 * ★ 2단계 파싱이 핵심이다:
 *   1단계 — 봉투만 느슨하게 파싱해서 `seq` 를 '먼저' 확보한다.
 *   2단계 — 액션 본문을 variant 별로 엄격 검증한다.
 * seq 를 뽑을 수 있는 모든 실패는 ack{ok:false} 로 답해야 하기 때문이다.
 * 한 방에 엄격 파싱하면 본문이 조금 틀린 액션이 error{bad_message} 가 되고,
 * 그러면 그 액션의 pending 엔트리가 클라이언트 큐에 영원히 남아
 * 예측 위치가 한 칸 어긋난 채 연결이 끝날 때까지 복구되지 않는다. */

import { z } from "zod";
import { DIRECTIONS } from "./ids";

/** seq 상한: 2^31. 이걸 넘길 만큼 오래 붙어 있는 연결은 없고,
 *  상한이 없으면 Infinity 를 보내 이후 모든 seq 를 잠글 수 있다. */
export const MAX_SEQ = 2 ** 31;

export const zDir = z.enum(DIRECTIONS);

export const zSeq = z.number().int().positive().lte(MAX_SEQ);

/** 1단계 파싱: 봉투. `action` 은 통과시키되 `type` 이 문자열이라는 것만 본다.
 *  여기서 실패하는 프레임만이 error{bad_message} 자격이 있다. */
export const zEnvelope = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("hello"),
    pv: z.number().int(),
    token: z
      .string()
      .length(64)
      .regex(/^[0-9a-f]+$/)
      .nullable(),
    // 이름은 여기서 클램프하지 않고 sanitizeName 이 자른다. 다만 무한 문자열은 막는다.
    name: z.string().max(256).nullable(),
  }),
  z.object({
    t: z.literal("action"),
    seq: zSeq,
    action: z.object({ type: z.string().max(32) }).passthrough(),
  }),
  z.object({ t: z.literal("pong"), nonce: z.number().int() }),
]);

export type Envelope = z.infer<typeof zEnvelope>;

/** 2단계 파싱: 액션 본문. 길이 상한은 서버가 Limits 에서 주입한다 —
 *  두 곳에 하드코딩하면 서버가 값을 바꾸는 순간 조용히 어긋난다. */
export function makeActionSchemas(limits: { sayMaxLen: number; unparsedMaxLen: number }) {
  return {
    move: z.object({ type: z.literal("move"), dir: zDir }).strict(),
    look: z.object({ type: z.literal("look") }).strict(),
    // 길이 검사를 스키마에 넣지 않는다: 너무 긴 것과 형식이 틀린 것을
    // 구별해서 too_long / bad_args 로 각각 답해야 하기 때문이다.
    say: z.object({ type: z.literal("say"), text: z.string() }).strict(),
    unparsed: z.object({ type: z.literal("unparsed"), raw: z.string() }).strict(),
    resync: z.object({ type: z.literal("resync") }).strict(),
    attack: z.object({ type: z.literal("attack") }).strict(),
    // skillId 는 서버의 SKILLS 테이블에 있는지 핸들러가 다시 확인한다 —
    // 스키마는 '문자열이고 길이가 온당한가' 까지만 본다.
    skill: z.object({ type: z.literal("skill"), skillId: z.string().max(32) }).strict(),
    stop: z.object({ type: z.literal("stop") }).strict(),
    // npcId / topic 이 실제로 존재하고 '지금 열려 있는지' 는 핸들러가 다시 본다 —
    // 스키마는 형태만 본다 (charter 82줄: 서버가 전부 재검증한다).
    talk: z.object({ type: z.literal("talk"), npcId: z.string().max(64) }).strict(),
    ask: z
      .object({ type: z.literal("ask"), npcId: z.string().max(64), topic: z.string().max(64) })
      .strict(),
    // itemId 가 실제로 있는지, 가지고 있는지는 핸들러가 다시 본다.
    use_item: z.object({ type: z.literal("use_item"), itemId: z.string().max(64) }).strict(),
    maxLen: { say: limits.sayMaxLen, unparsed: limits.unparsedMaxLen },
  };
}
