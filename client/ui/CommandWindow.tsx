/* JRPG 커맨드 창 — 5단계의 중심.
 *
 * 화면의 역할이 셋으로 갈린다:
 *   로그      = 세계의 문장 (log 만이 문장을 나른다 — 불변식 1)
 *   상태창    = 구조화된 지금 (HP, 적, 좌표)
 *   커맨드 창 = 할 수 있는 일 '전부'
 * 같은 명령이 두 군데 생기지 않는 것이 이 분리의 요점이다.
 *
 * 이 컴포넌트는 상태를 갖지 않는다. 무엇을 그릴지는 input/menu.ts 가
 * 상태에서 순수하게 세우고, 커서와 경로는 App 이 쥔다. */

import type { MenuItem } from "../input/menu";
import { C, FONT, win } from "../theme";

export function CommandWindow(props: {
  items: MenuItem[];
  /** 지금까지 내려온 경로의 라벨. 창 제목이 된다. */
  trail: string[];
  cursor: number;
  /** 커맨드 모드일 때만 커서를 그린다. 탐색 모드에서도 클릭은 된다 —
   *  마우스·터치 사용자는 모드를 알 필요가 없다. */
  active: boolean;
  onActivate: (index: number) => void;
  onHover: (index: number) => void;
  onBack: () => void;
  /** 창을 눌러 커맨드 모드로 들어간다 (탐색 모드일 때만 의미가 있다). */
  onOpen: () => void;
}) {
  const { items, trail, cursor, active, onActivate, onHover, onBack, onOpen } = props;

  return (
    <div
      style={{
        ...win,
        flex: 1,
        minWidth: 0,
        padding: "8px 10px",
        // 모드가 눈에 보여야 한다. 안 그러면 화살표가 왜 안 먹는지 알 수 없다.
        borderColor: active ? C.gold : C.line,
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <div
        style={{
          fontSize: 11,
          color: C.dim,
          display: "flex",
          gap: 6,
          alignItems: "center",
          minHeight: 14,
        }}
      >
        {trail.length > 0 && (
          <button
            onClick={onBack}
            aria-label="뒤로"
            style={{
              background: "none",
              border: "none",
              color: C.gold,
              fontFamily: FONT,
              fontSize: 12,
              cursor: "pointer",
              padding: 0,
            }}
          >
            ◀
          </button>
        )}
        <span>{trail.length ? trail.join(" · ") : "커맨드"}</span>
      </div>

      {items.length === 0 ? (
        <span style={{ fontSize: 13, color: C.dim, padding: "6px 2px" }}>…</span>
      ) : (
        items.map((it, i) => {
          const on = active && i === cursor;
          return (
            <button
              key={it.id}
              disabled={it.disabled}
              onClick={() => {
                if (!active) onOpen();
                onActivate(i);
              }}
              onMouseEnter={() => onHover(i)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                width: "100%",
                textAlign: "left",
                background: on ? C.winHi : "transparent",
                border: "none",
                borderLeft: `3px solid ${on ? C.gold : "transparent"}`,
                color: it.disabled ? C.dim : C.text,
                opacity: it.disabled ? 0.55 : 1,
                fontFamily: FONT,
                fontSize: 15,
                padding: "7px 6px",
                cursor: it.disabled ? "default" : "pointer",
                touchAction: "manipulation",
              }}
            >
              <span style={{ width: 12, color: C.gold, fontSize: 12 }}>{on ? "▶" : ""}</span>
              <span style={{ flex: 1 }}>{it.label}</span>
              {it.note && <span style={{ fontSize: 12, color: C.gold }}>{it.note}</span>}
              {it.items && <span style={{ fontSize: 11, color: C.dim }}>▸</span>}
            </button>
          );
        })
      )}

      {/* HUD 크롬 — 조작 안내이지 세계의 문장이 아니다 (Status.tsx 와 같은 예외). */}
      <div style={{ fontSize: 10, color: C.dim, marginTop: 2 }}>
        {active ? "↑↓ 선택 · Enter 확정 · Esc 뒤로" : "Esc 커맨드 · 화살표 이동"}
      </div>
    </div>
  );
}
