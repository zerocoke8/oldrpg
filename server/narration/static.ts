/* 결정론적 방 묘사 렌더러. LLM 없이 씨앗을 문장으로 만든다.
 *
 * 이건 임시 코드가 아니라 '최종' 코드다. 세 가지 역할을 한다:
 *   1) API 키가 없을 때의 렌더러
 *   2) LLM 호출이 실패했을 때의 폴백 (charter 2단계: "실패 시 폴백 텍스트")
 *   3) ★ 규칙 4의 이행 수단 — 캐시 미스일 때 '즉시' 보여줄 문장.
 *      플레이어는 언제나 이 문장을 먼저 받고, LLM 문장은 준비되면
 *      log.replace 로 조용히 갈아끼워진다.
 *
 * 이 파일은 engine/ 도 db/ 도 import 하지 않는다 (.eslintrc.cjs 가 강제).
 * 얼어붙은 RoomTextRequest 만 받고 텍스트를 '반환'할 뿐 기록하지 않는다. */

import type { RoomTextRenderer, RoomTextRequest, RoomTextResult } from "../../shared/narration";
import type { Mood } from "./prompts";

const TAIL = "발소리가 축축한 벽에 둔하게 부딪힌다.";

/** 그 방이 '선언한' 플래그만 투영되어 들어온다. 전체 월드 플래그를 받는
 *  경로는 존재하지 않는다 (charter 45줄). */
export function moodTextFor(
  req: RoomTextRequest,
  moods: ReadonlyMap<string, Mood>,
  pick: (m: Mood) => string,
): string {
  return req.flags
    .filter(([, v]) => v === true)
    .map(([k]) => moods.get(k))
    .filter((m): m is Mood => Boolean(m))
    .map(pick)
    .filter(Boolean)
    .join(" ");
}

export function makeStaticRenderer(moods: ReadonlyMap<string, Mood>): RoomTextRenderer {
  return async (req: RoomTextRequest): Promise<RoomTextResult> => {
    const mood = moodTextFor(req, moods, (m) => m.fallback);
    return {
      text: `${req.seed}. ${mood || TAIL}`,
      source: "fallback",
      model: null,
      promptVersion: null,
    };
  };
}
