/* 입력 어댑터 2: 자유 텍스트.
 *
 * 1단계에는 이걸 부르는 UI 가 없다 (미니맵 + 로그 + D패드만 만들기로 했다).
 * 그래도 지금 두는 이유: 세 번째 어댑터가 존재해야 "모든 입력이 같은 Action
 * 으로 수렴한다" 는 charter 의 구조가 코드로 확인된다. 5단계에 입력창을
 * 붙이면 이 함수를 부르기만 하면 된다.
 *
 * ★ 해석하지 못한 문자열도 '그대로' 서버로 보낸다.
 *   "그건 명령이 아니다" 를 클라이언트가 판정하기 시작하면 그 판정 문장이
 *   클라이언트에 살게 되고, "화면에 문장을 올리는 것은 log 뿐" 이라는
 *   불변식이 깨진다. 그러면 2단계가 클라이언트 배포 없이 끝나지 못한다. */

import type { Action } from "../../shared/protocol";
import { DIRECTIONS, type Dir } from "../../shared/ids";

const ALIASES: Record<string, Dir> = {
  북: "north", 남: "south", 동: "east", 서: "west",
  북쪽: "north", 남쪽: "south", 동쪽: "east", 서쪽: "west",
  n: "north", s: "south", e: "east", w: "west",
};

export function parse(input: string): Action {
  const raw = input.trim();
  const word = raw.toLowerCase();

  const dir: Dir | null =
    ALIASES[word] ?? ((DIRECTIONS as readonly string[]).includes(word) ? (word as Dir) : null);
  if (dir) return { type: "move", dir };

  if (word === "look" || raw === "살펴보기" || raw === "봐") return { type: "look" };

  const say = raw.match(/^(?:말하기|say)\s+(.+)$/i);
  if (say?.[1]) return { type: "say", text: say[1] };

  return { type: "unparsed", raw };
}
