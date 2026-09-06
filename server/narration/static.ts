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

import type {
  NpcLineRenderer,
  NpcLineRequest,
  RoomTextRenderer,
  RoomTextRequest,
  RoomTextResult,
} from "../../shared/narration";
import { createHash } from "node:crypto";
import type { Mood, Tails } from "./prompts";

/** 씨앗으로 꼬리를 고른다. 방마다 고정이고 같은 방은 언제나 같은 문장이다 —
 *  폴백도 room_text 에 기록되므로 굴릴 때마다 달라지면 캐시가 거짓말이 된다. */
const pickBySeed = (seed: string, pool: readonly string[]): string => {
  const h = createHash("sha256").update(seed, "utf8").digest();
  return pool[h.readUInt32BE(0) % pool.length]!;
};

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

export function makeStaticRenderer(moods: ReadonlyMap<string, Mood>, tails: Tails): RoomTextRenderer {
  return async (req: RoomTextRequest): Promise<RoomTextResult> => {
    const mood = moodTextFor(req, moods, (m) => m.fallback);
    return {
      text: `${req.seed}. ${mood || pickBySeed(req.seed, tails.room)}`,
      source: "fallback",
      model: null,
      promptVersion: null,
    };
  };
}

/** NPC 대사의 결정론 폴백. 방과 같은 역할이다 — 키가 없을 때의 렌더러이자,
 *  LLM 실패 시의 폴백이자, 규칙 4 를 위해 '즉시' 보여줄 문장.
 *  씨앗을 그대로 한 문장으로 세운다. */
export function makeStaticNpcRenderer(moods: ReadonlyMap<string, Mood>, tails: Tails): NpcLineRenderer {
  return async (req: NpcLineRequest): Promise<RoomTextResult> => {
    const mood = req.flags
      .filter(([, v]) => v === true)
      .map(([k]) => moods.get(k)?.fallback)
      .filter((x): x is string => Boolean(x))
      .join(" ");
    return {
      text: `${req.seed}. ${mood || pickBySeed(req.seed, tails.npc)}`,
      source: "fallback",
      model: null,
      promptVersion: null,
    };
  };
}
