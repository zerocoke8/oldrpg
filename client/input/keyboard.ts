/* 입력 어댑터 1: 키보드.
 *
 * charter 68-80줄: 키보드 · 화면 버튼 · 자유 텍스트는 서버로 가기 전에
 * 동일한 Action 객체로 수렴한다. 이 파일이 하는 일은 '키 -> Action' 뿐이고,
 * 액션 처리 로직은 입력 방식별로 분기하지 않는다.
 * 새 입력 방식을 추가할 때는 이런 어댑터만 하나 더 만든다. */

import type { Action } from "../../shared/protocol";

const KEY_TO_ACTION: Record<string, Action> = {
  ArrowUp: { type: "move", dir: "north" },
  ArrowDown: { type: "move", dir: "south" },
  ArrowLeft: { type: "move", dir: "west" },
  ArrowRight: { type: "move", dir: "east" },
  Enter: { type: "look" },
  " ": { type: "look" },
};

export const actionForKey = (key: string): Action | null => KEY_TO_ACTION[key] ?? null;

export const HANDLED_KEYS = Object.keys(KEY_TO_ACTION);
