/* 입력 어댑터 5: 스와이프 (모바일).
 *
 * D패드와 '같은' Action 을 만든다. 손가락으로 화면을 쓸면 그 방향으로 한 칸.
 * 로그 창처럼 넓은 영역에 붙이는 것을 전제로 한다 — 임계값을 넘겨야
 * 발동하므로 접힌 로그를 펼치는 탭과 부딪히지 않는다. */

import type { Dir } from "../../shared/ids";

/** 이 거리(px)를 넘겨야 스와이프다. 아래는 그냥 탭이다. */
const THRESHOLD = 36;
/** 이 시간(ms)을 넘으면 스와이프가 아니라 스크롤/길게 누르기로 본다. */
const MAX_MS = 700;

export function makeSwipe(onDir: (d: Dir) => void) {
  let x0 = 0;
  let y0 = 0;
  let t0 = 0;
  let tracking = false;

  return {
    onTouchStart: (e: React.TouchEvent) => {
      // 두 손가락은 확대/스크롤이다. 건드리지 않는다.
      if (e.touches.length !== 1) {
        tracking = false;
        return;
      }
      const t = e.touches[0]!;
      x0 = t.clientX;
      y0 = t.clientY;
      t0 = Date.now();
      tracking = true;
    },
    onTouchEnd: (e: React.TouchEvent) => {
      if (!tracking) return;
      tracking = false;
      const t = e.changedTouches[0];
      if (!t || Date.now() - t0 > MAX_MS) return;
      const dx = t.clientX - x0;
      const dy = t.clientY - y0;
      // 지배적인 축 하나만. 대각선은 무시하는 편이 오작동보다 낫다.
      if (Math.abs(dx) < THRESHOLD && Math.abs(dy) < THRESHOLD) return;
      if (Math.abs(dx) > Math.abs(dy)) onDir(dx > 0 ? "east" : "west");
      else onDir(dy > 0 ? "south" : "north");
    },
  };
}
