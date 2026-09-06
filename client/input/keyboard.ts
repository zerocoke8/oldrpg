/* 입력 어댑터 1: 키보드.
 *
 * charter 68-80줄: 키보드(화살표/Enter/Esc) · 화면 버튼 · 자유 텍스트는
 * 서버로 가기 전에 동일한 Action 객체로 수렴한다. 이 파일이 하는 일은
 * '키 -> 의도' 뿐이고, 액션 처리 로직은 입력 방식별로 분기하지 않는다.
 *
 * ★ 5단계에 모드가 생겼다 (JRPG 의 필드/커맨드 구분 그대로):
 *     탐색 모드 — 화살표=이동, Enter=살펴보기, Esc=커맨드 창 열기
 *     커맨드 모드 — 화살표=커서, Enter/→=확정, Esc/←=뒤로
 *   같은 키가 모드에 따라 다른 의도가 되는 것은 여기 한 곳에서만 일어난다.
 *   App 은 키 문자열을 알지 못한다. */

import type { Action } from "../../shared/protocol";

export type Mode = "field" | "menu";

export type Intent =
  | { kind: "action"; action: Action }
  /** 커맨드 창 조작. 액션이 아니라 UI 상태다 — 서버로 가지 않는다. */
  | { kind: "menu"; op: "open" | "back" | "up" | "down" | "enter" };

const MOVE: Record<string, Action> = {
  ArrowUp: { type: "move", dir: "north" },
  ArrowDown: { type: "move", dir: "south" },
  ArrowLeft: { type: "move", dir: "west" },
  ArrowRight: { type: "move", dir: "east" },
};

export function intentForKey(key: string, mode: Mode): Intent | null {
  if (mode === "field") {
    const move = MOVE[key];
    if (move) return { kind: "action", action: move };
    if (key === "Enter" || key === " ") return { kind: "action", action: { type: "look" } };
    if (key === "Escape") return { kind: "menu", op: "open" };
    return null;
  }
  switch (key) {
    case "ArrowUp":
      return { kind: "menu", op: "up" };
    case "ArrowDown":
      return { kind: "menu", op: "down" };
    case "ArrowRight":
    case "Enter":
    case " ":
      return { kind: "menu", op: "enter" };
    case "ArrowLeft":
    case "Escape":
      return { kind: "menu", op: "back" };
    default:
      return null;
  }
}

/** 우리가 소비하는 키. 나머지는 브라우저 기본 동작에 맡긴다. */
export const HANDLED_KEYS = [
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Enter",
  " ",
  "Escape",
];
