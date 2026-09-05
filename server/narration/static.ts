/* 1단계의 방 묘사 렌더러. LLM 없이 결정론적으로 씨앗을 문장으로 만든다.
 *
 * 프로토타입의 catch 분기(mudprototype.jsx:178)를 그대로 승격시킨 것이고,
 * 2단계에도 API 실패 시의 폴백으로 '그대로' 남는다. 그래서 이건 임시 코드가
 * 아니라 최종 코드다 — 2단계는 이 함수를 지우는 게 아니라 앞에 LLM 을 얹는다.
 *
 * 이 파일은 engine/ 도 db/ 도 import 하지 않는다 (.eslintrc.cjs 가 강제).
 * 얼어붙은 RoomTextRequest 만 받고 텍스트를 '반환'할 뿐 기록하지 않는다. */

import type { RoomTextRenderer, RoomTextRequest, RoomTextResult } from "../../shared/narration";

/** 플래그가 켜졌을 때의 톤. 2단계에는 이 문자열이 프롬프트의 "현재 월드 상태"
 *  절이 되고, 1단계에는 문장 뒤에 붙는 한 문장이 된다.
 *  FLAG_MOOD 가 narration 의 자산인 것이 중요하다 — engine/ 이 소유하면
 *  문구를 고칠 때마다 엔진을 건드리게 된다. */
const FLAG_MOOD: Readonly<Record<string, string>> = {
  guardian_slain: "위협이 사라진 뒤의 느슨한 정적이 감돈다.",
};

const TAIL = "발소리가 축축한 벽에 둔하게 부딪힌다.";

/** 그 방이 '선언한' 플래그만 투영되어 들어온다. 전체 월드 플래그를 받는
 *  경로는 존재하지 않는다 (charter 45줄). */
function moodFor(req: RoomTextRequest): string {
  return req.flags
    .filter(([, v]) => v === true)
    .map(([k]) => FLAG_MOOD[k])
    .filter((s): s is string => Boolean(s))
    .join(" ");
}

export const staticRenderer: RoomTextRenderer = async (
  req: RoomTextRequest,
): Promise<RoomTextResult> => {
  const mood = moodFor(req);
  return {
    text: `${req.seed}. ${mood || TAIL}`,
    source: "fallback",
    model: null,
    promptVersion: null,
  };
};
