import type { CombatView } from "../../shared/protocol";

/* 브라우저에만 사는 설정. 서버는 이것들을 전혀 모른다.
 *
 * ★ 왜 서버가 아닌가: 색과 자동전투는 '이 사람이 이 브라우저에서 어떻게
 *   보고 싶은가' 이지 세계의 사실이 아니다. 서버로 보내면 계정 표에 열이
 *   늘고, 마이그레이션이 생기고, 그 값이 두 곳에 살게 된다.
 *
 * ★ 접근 자체가 던지는 환경이 있다 (사생활 보호 창, 사이트 데이터 차단).
 *   그때는 기본값으로 돌아가고 조용히 계속한다 — 설정 때문에 게임이 안 뜨는
 *   것이 설정이 안 저장되는 것보다 훨씬 나쁘다. socket.ts 의 토큰 저장이
 *   쓰는 규약과 같다.
 *
 * ★ 슬롯(?as=)을 붙이지 않는다. mud.token.<슬롯> 은 '이 탭의 캐릭터' 를
 *   가르는 장치지만, 이건 사람의 것이라 탭마다 다르면 안 된다. */

const AUTO_SKILL = "mud.autoSkill";

export const loadAutoSkill = (): boolean => {
  try {
    return localStorage.getItem(AUTO_SKILL) === "1";
  } catch {
    return false;
  }
};

export const saveAutoSkill = (on: boolean): void => {
  try {
    localStorage.setItem(AUTO_SKILL, on ? "1" : "0");
  } catch {
    /* 저장 못 해도 이번 세션에는 켜져 있다 */
  }
};

/** 자동전투가 한 번 쏘고 다음까지 쉬는 시간(ms).
 *
 *  ★ 서버의 상한은 actionsPerSec: 20 이다. 여기서 나가는 것은 초당 1.7회라
 *    한 자리 여유가 있고, 사람이 그동안 걷고 때리는 것까지 더해도 넉넉하다.
 *    (프레임 상한을 넘기면 rate_limited 가 아니라 연결이 끊긴다 —
 *     server/net/server.ts 의 fatal(conn, "flooding"). 여유가 필요한 이유다.)
 *  ★ 그리고 스윙이 0.5초다. 그보다 촘촘히 쏘면 같은 스윙의 예약을 덮어쓰기만
 *    하고 아무것도 더 나가지 않는다. */
export const AUTO_SKILL_MS = 600;

/** 자동전투가 지금 무엇을 쓸 것인가. 없으면 null.
 *
 *  ★ 규칙 전부가 이 함수다. 판단이 없다 — combat.skills 를 **서버가 준 순서
 *    그대로** 훑어 쿨다운이 아닌 첫 번째를 고른다. 정렬도 점수도 없다.
 *    "지금은 치유가 맞다" 를 고르기 시작하면 그건 입력 자동화가 아니라
 *    클라이언트가 전투를 판정하는 것이고, 규칙 1 이 걸린다.
 *
 *  ★ 순환은 규칙에서 저절로 따라 나온다: 쓰고 나면 그 스킬이 쿨다운으로
 *    빠지므로 다음번엔 그다음 것이 첫 번째가 된다. 별도 상태가 없다.
 *
 *  ★ 순수 함수인 이유: 이 규칙의 모든 갈래를 브라우저 없이 검사할 수 있어야
 *    한다. 타이머 안에 인라인으로 두면 '쿨다운 중에는 안 쓴다' 를 확인하려고
 *    진짜 전투를 만들어야 한다. */
export function nextAutoSkill(c: CombatView | null): string | null {
  if (!c || !c.engaged) return null; // 교전 중이 아니면 아무것도 안 한다
  /* 예약 자리는 하나뿐이고 나중 입력이 이긴다. 차 있으면 건드리지 않는다 —
     안 그러면 사람이 고른 것을 자동이 덮어쓴다. */
  if (c.queuedSkill || c.queuedItem) return null;
  return c.skills.find((sk) => sk.readyInMs === 0)?.id ?? null;
}
