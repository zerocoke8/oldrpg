/* 입력 어댑터 3의 UI: 자유 텍스트 한 줄.
 *
 * parse() 는 1단계부터 있었고 부르는 곳이 없었다. 여기서 드디어 이어진다.
 * "북", "살펴보기", "말하기 안녕" 이 전부 같은 Action 으로 수렴한다.
 *
 * ★ 이 컴포넌트는 parse() 를 부르지 않는다. 값과 제출만 위로 올린다 —
 *   '모든 입력이 act(Action) 하나로 수렴한다' 는 것이 App 에서 눈에 보여야
 *   하고, 어댑터가 저마다 자기 자리에서 act 를 부르면 그 그림이 흩어진다. */

import { forwardRef } from "react";
import { C, FONT } from "../theme";

export const TextInput = forwardRef<
  HTMLInputElement,
  { value: string; onValue: (v: string) => void; onSubmit: () => void }
>(function TextInput({ value, onValue, onSubmit }, ref) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      style={{ display: "flex", gap: 6 }}
    >
      <input
        ref={ref}
        value={value}
        onChange={(e) => onValue(e.target.value)}
        onKeyDown={(e) => {
          // 입력창 안의 Esc 는 '취소' 다. 커맨드 창을 열지 않는다 —
          // 전역 핸들러는 입력창에 포커스가 있으면 애초에 돌지 않는다.
          if (e.key === "Escape") {
            onValue("");
            e.currentTarget.blur();
          }
        }}
        placeholder="북 · 살펴보기 · 말하기 안녕"
        aria-label="명령 입력"
        style={{
          flex: 1,
          minWidth: 0,
          background: C.ink,
          border: `2px solid ${C.winHi}`,
          color: C.text,
          fontFamily: FONT,
          // 16px 미만이면 iOS 사파리가 입력창에 포커스할 때 화면을 확대한다.
          fontSize: 16,
          padding: "9px 10px",
        }}
      />
      <button
        type="submit"
        style={{
          background: C.winHi,
          border: `2px solid ${C.line}`,
          color: C.text,
          fontFamily: FONT,
          fontSize: 14,
          padding: "0 14px",
          cursor: "pointer",
          touchAction: "manipulation",
        }}
      >
        보내기
      </button>
    </form>
  );
});
