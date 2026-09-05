/* 게임에 등장하는 '모든' 한국어 문장이 사는 곳.
 *
 * 왜 engine/ 이 아니라 여기인가: 클라이언트가 문장을 조립하지 않는다는 것이
 * 프로토콜 불변식 (1)이고, 그러면 문장은 서버 어딘가에 있어야 한다.
 * engine/ 에 두면 문구를 고칠 때마다 '진실을 계산하는 코드'를 건드리게 된다.
 * 2단계에 이 문장들 중 일부가 LLM 출력으로 바뀌어도 engine/ 은 그대로다.
 *
 * 이 파일은 순수하다 — 상태를 읽지도 쓰지도 않고 문자열만 만든다. */

import type { Dir } from "../../shared/ids";

/** 방위의 한국어 이름. Dir 는 shared/ 소유이고 그 '표시'만 여기 있다. */
const DIR_KO: Readonly<Record<Dir, string>> = {
  north: "북쪽",
  south: "남쪽",
  east: "동쪽",
  west: "서쪽",
};

export const dirKo = (d: Dir): string => DIR_KO[d];

export const lines = {
  welcome: "화살표로 이동, Enter로 살펴보기. 다른 탭을 열면 두 번째 모험가가 된다.",

  // ── 이동 ──────────────────────────────────────────────────────────────
  blocked: "단단한 벽이 앞을 막는다.",

  // ── presence: 방 단위 서사 피드 ──────────────────────────────────────
  /** 상대가 '내 방으로' 들어왔다. fromDir 이 null 이면 접속으로 나타난 것이다. */
  entered: (name: string, fromDir: Dir | null): string =>
    fromDir
      ? `${name} 님이 ${dirKo(fromDir)}에서 들어왔다.`
      : `${name} 님이 어둠 속에서 나타났다.`,
  /** 상대가 '내 방에서' 나갔다. toDir 이 null 이면 접속이 끊긴 것이다. */
  left: (name: string, toDir: Dir | null): string =>
    toDir ? `${name} 님이 ${dirKo(toDir)}으로 사라졌다.` : `${name} 님이 어둠 속으로 사라졌다.`,
  /** 내가 들어간 방에 이미 서 있던 사람들. Phase A 에서 나간다 —
   *  room.occupants 에서 순수 파생되므로 await 가 필요 없다. */
  roster: (names: readonly string[]): string =>
    `이곳에 ${names.join(", ")} 님이 서 있다.`,

  // ── 자유 텍스트 ───────────────────────────────────────────────────────
  /** charter 의 자유 텍스트 불변식: 1단계는 고정 문장으로 답한다.
   *  미래에 LLM 의도 추출을 붙이더라도 그 결과는 '제안'으로 표시되고
   *  사람이 재제출해야 엔진에 닿는다. */
  unparsed: (raw: string): string => `"${raw}" — 무엇을 하려는지 알 수 없다.`,
  sayEmpty: "할 말이 없다.",
  sayTooLong: "그렇게 긴 말은 숨이 차서 못 한다.",

  // ── 복구 ──────────────────────────────────────────────────────────────
  /** resume 시 저장된 좌표가 벽 안이면(맵이 바뀌었으면) 스폰으로 이송한다. */
  displaced: "길이 무너져 있었다. 정신을 차려 보니 입구다.",
} as const;

/** 기본 이름. id 파생이라 실질 충돌이 없다 — players.name 에 UNIQUE 를 걸지
 *  않은 이유이기도 하다(계정이 없는데 이름 유일성을 약속하면 거짓말이다). */
export const defaultName = (playerId: string): string =>
  `모험가-${playerId.replace(/-/g, "").slice(0, 4)}`;
