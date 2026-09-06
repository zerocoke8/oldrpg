/* 입력 어댑터 2: 화면 버튼 (모바일 터치 포함).
 *
 * 5단계에서 '이동 전용' 이 됐다. 살펴보기·공격·대화는 전부 커맨드 창으로
 * 옮겼다 — 같은 명령이 화면 두 군데에 있으면 어느 쪽이 진짜인지 알 수 없고,
 * 키보드 커서도 두 개가 된다.
 *
 * 키보드와 '같은' Action 을 만들어 같은 경로로 보낸다 —
 * 액션 처리 로직이 입력 방식별로 분기하지 않는다는 것이 charter 79-80줄이다. */

import type { Dir } from "../../shared/ids";
import type { Action } from "../../shared/protocol";
import { C, FONT } from "../theme";

const PAD: { dir: Dir; label: string; aria: string; area: string }[] = [
  { dir: "north", label: "↑", aria: "북쪽으로", area: "1 / 2 / 2 / 3" },
  { dir: "west", label: "←", aria: "서쪽으로", area: "2 / 1 / 3 / 2" },
  { dir: "east", label: "→", aria: "동쪽으로", area: "2 / 3 / 3 / 4" },
  { dir: "south", label: "↓", aria: "남쪽으로", area: "3 / 2 / 4 / 3" },
];

export function Dpad({ act }: { act: (a: Action) => void }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplate: "46px 46px 46px / 46px 46px 46px",
        gap: 4,
        flex: "0 0 auto",
      }}
    >
      {PAD.map((p) => (
        <button
          key={p.dir}
          onClick={() => act({ type: "move", dir: p.dir })}
          aria-label={p.aria}
          style={{
            gridArea: p.area,
            background: C.winHi,
            border: `2px solid ${C.line}`,
            color: C.text,
            fontSize: 18,
            fontFamily: FONT,
            cursor: "pointer",
            touchAction: "manipulation",
          }}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}
