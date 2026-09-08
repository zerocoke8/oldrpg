/* 상단 상태창. 좌표 · HP · 동행자 수.
   HP 는 1단계에 변하지 않지만 SelfState 가 이미 싣고 있으므로,
   4단계에 전투가 붙어도 프로토콜도 이 컴포넌트도 바뀌지 않는다. */

import type { Pos } from "../../shared/ids";
import type { RegionView, RoomView, SelfState, WorldFlagView } from "../../shared/protocol";
import { C, FONT, win } from "../theme";

export function Status(props: {
  self: SelfState;
  region: RegionView;
  room: RoomView | null;
  at: Pos;
  connected: boolean;
  world: WorldFlagView[];
  /** 설정 창을 연다. 접근성 이름은 커맨드 창에 있던 것과 글자 그대로 같다 —
   *  옮긴 것이지 새로 만든 것이 아니기 때문이다. */
  onSettings(): void;
}) {
  const { self, region, room, at, connected, world, onSettings } = props;
  // label 이 있는 것만 — 문구는 서버가 만든다. 클라이언트는 key 로
  // 문장을 조립하지 않는다 (프로토콜 불변식 1).
  const marks = world.filter((f) => f.label);
  const ratio = self.maxHp > 0 ? self.hp / self.maxHp : 0;

  return (
    <div style={{ ...win, flex: 1 }}>
      <div style={{ fontSize: 13, color: C.dim, marginBottom: 6, display: "flex", alignItems: "baseline", gap: 4 }}>
        <span style={{ flex: 1, minWidth: 0 }}>
        {region.name} · {at.x},{at.y} · <span style={{ color: C.text }}>{self.name}</span>
        {/* 등급의 '이름' 은 서버가 붙여 보낸다 — 클라이언트가 숫자로 문구를
            조립하지 않는다 (프로토콜 불변식 1). */}
        {self.rank.name && <span style={{ color: C.gold }}> · {self.rank.name}</span>}
        {/* 계정 이름도 서버가 준 원형 그대로다. 없으면 익명이라는 뜻이고,
            그것을 문장으로 말하지 않는다 — 표시가 없는 것이 그 사실이다. */}
        {/* ★ 넘칠 때는 이름 쪽만 줄어든다 — 아래 '동행' 줄이 쓰는 그 규칙이다.
            안 줄이면 긴 계정 이름에서 머리줄이 두 줄이 되고, 그만큼 아래가 밀린다. */}
        {self.account && (
          <span
            style={{
              color: C.other,
              display: "inline-block",
              maxWidth: 140,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              verticalAlign: "bottom",
            }}
          >
            {" "}· @{self.account}
          </span>
        )}
        {!connected && <span style={{ color: C.red }}> · 연결 끊김</span>}
        </span>
        {/* ★ 커맨드 창에서 **옮겨 온** 것이지 복제가 아니다. 복제하면 같은
            명령이 두 군데에 살고(Dpad.tsx 의 규약), 접근성 이름이 같은 버튼이
            둘이 되어 검사의 exact 로케이터가 통째로 죽는다.
            ★ 여기 두는 이유: 커맨드 창은 '세계에서 할 수 있는 일' 이고 설정은
              살림이다. 밖으로 나가는 것이 그 경계를 흐리는 것이 아니라 또렷하게
              한다. 상태창은 이미 계기판이라 같은 층위다.
            ★ 탭 순서에 남긴다(tabIndex 를 주지 않는다). 미니맵 칸과 D패드가
              -1 인 것은 키보드에 화살표라는 제대로 된 길이 이미 있어서인데,
              설정에는 그런 길이 없다. */}
        <button
          type="button"
          onClick={onSettings}
          aria-label={self.account ? "설정 · 계정" : "설정 · 로그인"}
          style={{
            background: "none",
            border: "none",
            color: C.dim,
            fontFamily: FONT,
            fontSize: 15,
            lineHeight: 1,
            padding: "0 2px",
            cursor: "pointer",
            flex: "0 0 auto",
          }}
        >
          ⚙
        </button>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 13, color: C.dim, width: 24 }}>HP</span>
        <div style={{ flex: 1, height: 10, background: C.trough, border: `1px solid ${C.dim}` }}>
          <div
            style={{
              width: `${ratio * 100}%`,
              height: "100%",
              background: ratio > 0.3 ? C.green : C.red,
              transition: "width .25s",
            }}
          />
        </div>
        <span style={{ fontSize: 13, width: 46, textAlign: "right" }}>
          {self.hp}/{self.maxHp}
        </span>
      </div>
      {/* ★ HUD 크롬이다. 프로토콜 불변식 (1)의 명시적 예외 —
          '라벨 + 데이터' 이지 서사 문장이 아니다. "○○ 님이 들어왔다" 같은
          문장은 여기서 만들지 않고 서버의 log 로만 온다. 그래서 2단계에
          문구가 바뀌어도 이 컴포넌트는 그대로다. */}
      {/* 좁은 화면에서 줄바꿈이 이름 한가운데를 자르지 않게 한다 (5단계).
          각 항목은 통째로 넘어가고, 넘칠 때는 이름 쪽만 줄어든다. */}
      <div
        style={{
          fontSize: 11,
          color: C.dim,
          marginTop: 8,
          display: "flex",
          flexWrap: "wrap",
          columnGap: 10,
          rowGap: 3,
        }}
      >
        <span style={{ minWidth: 0 }}>
          동행 {room?.occupants.length ?? 0}
          {room?.occupants.length ? (
            <span style={{ color: C.other }}> {room.occupants.map((o) => o.name).join(", ")}</span>
          ) : null}
        </span>
        <span style={{ whiteSpace: "nowrap" }}>탐색한 방 {self.seen.length}</span>
        {marks.map((f) => (
          <span key={f.key} style={{ color: C.gold, whiteSpace: "nowrap" }}>
            {f.label}
          </span>
        ))}
      </div>
    </div>
  );
}
