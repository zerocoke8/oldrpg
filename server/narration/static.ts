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
import type { Mood, Tails, Tone } from "./prompts";
import { regionOfRoomId } from "./prompts";

/** 씨앗으로 꼬리를 고른다. 방마다 고정이고 같은 방은 언제나 같은 문장이다 —
 *  폴백도 room_text 에 기록되므로 굴릴 때마다 달라지면 캐시가 거짓말이 된다. */
const pickBySeed = (seed: string, pool: readonly string[]): string => {
  const h = createHash("sha256").update(seed, "utf8").digest();
  return pool[h.readUInt32BE(0) % pool.length]!;
};

/** 그 방이 '선언한' 플래그만 투영되어 들어온다. 전체 월드 플래그를 받는
 *  경로는 존재하지 않는다 (charter 45줄). */
export function moodTextFor(
  req: { readonly seed: string; readonly flags: RoomTextRequest["flags"] },
  moods: ReadonlyMap<string, Mood>,
  /** 씨앗을 함께 받는다 — 후보가 여럿인 절(fallback)을 방마다 고르게 하려고.
   *  지시문처럼 후보가 하나인 절은 씨앗을 무시하면 된다. */
  pick: (m: Mood, seed: string) => string,
): string {
  return req.flags
    .filter(([, v]) => v === true)
    .map(([k]) => moods.get(k))
    .filter((m): m is Mood => Boolean(m))
    .map((m) => pick(m, req.seed))
    .filter(Boolean)
    .join(" ");
}

/** 후보가 없으면 빈 문자열. 있으면 씨앗으로 고른 하나. */
export const fromPool = (seed: string, pool: readonly string[]): string =>
  pool.length ? pickBySeed(seed, pool) : "";

export function makeStaticRenderer(
  moods: ReadonlyMap<string, Mood>,
  tails: Tails,
  /** 지역별 꼬리. 없는 지역은 전역 꼬리로 떨어진다 — 톤은 덧칠이지
   *  필수가 아니다 (그래서 픽스처 세계와 막 만든 지역이 톤 없이도 돈다). */
  tones: ReadonlyMap<string, Tone> = new Map(),
): RoomTextRenderer {
  return async (req: RoomTextRequest): Promise<RoomTextResult> => {
    const mood = moodTextFor(req, moods, (m, seed) => fromPool(seed, m.fallback));
    /* 지역은 이미 roomId 안에 있다 ("d6town:4,7"). 그래서 이 파일이 지역을
       아는 데 계약(RoomTextRequest)을 한 글자도 바꿀 필요가 없다. */
    const pool = tones.get(regionOfRoomId(req.roomId))?.room;
    const tail = pickBySeed(req.seed, pool?.length ? pool : tails.room);
    return {
      text: `${req.seed}. ${mood || tail}`,
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
    /* ★ 방과 '다른' 절을 읽는다. 같은 문장을 쓰면 인물이 자기 대사 자리에서
       세계를 서술한다 — 인도자에게 인사했는데 사람이 아니라 나레이션이
       돌아왔다. npc_fallback 이 비면 아무것도 안 붙고 꼬리만 남는다. */
    const mood = moodTextFor(req, moods, (m, seed) => fromPool(seed, m.npcFallback));
    return {
      text: `${req.seed}. ${mood || pickBySeed(req.seed, tails.npc)}`,
      source: "fallback",
      model: null,
      promptVersion: null,
    };
  };
}
