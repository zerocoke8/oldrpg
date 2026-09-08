/* 설정. 세계의 동사가 아니라 살림이 모이는 자리다.
 *
 * ★ 왜 이 창이 생겼나: 계정 폼에는 처음부터 '만들기' 와 '로그인' 탭이 둘 다
 *   있었는데, 커맨드 창의 항목 이름이 "계정 만들기" 라서 사람이 로그인을
 *   못 찾았다. 이름 하나가 기능 하나를 통째로 감춘 셈이다. 그리고 색과
 *   자동전투처럼 '세계와 무관한 손잡이' 가 늘어나면서 갈 곳이 필요해졌다.
 *
 * ★ 불변식 (1) 과의 관계: 여기 있는 글자는 전부 **계기판의 말**이다 —
 *   고정 라벨과 데이터뿐이고, 세계가 자기에 대해 하는 말은 한 줄도 없다.
 *   Status.tsx 가 쓰는 그 예외와 같은 자리다. 계정의 실패 문구는 여전히
 *   서버가 만들고 error{message} 로 온다 (App.tsx 의 notice).
 *
 * ★ Account 를 흡수하지 않고 감싼다. "비밀번호는 이 컴포넌트 state 에만
 *   산다" 는 불변식이 그 파일에 국소적으로 걸려 있고, 합치면 그 경계가
 *   이 파일 전체로 넓어진다. */

import { C, FONT, PALETTE_NAMES, win, type PaletteId } from "../theme";
import { Account } from "./Account";

const row: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  flexWrap: "wrap",
  marginBottom: 10,
};

const label: React.CSSProperties = { color: C.dim, fontSize: 12, minWidth: 64 };

export function Settings(props: {
  account: string | null;
  nameMaxLen: number;
  passwordMinLen: number;
  palette: PaletteId;
  onPalette(p: PaletteId): void;
  autoSkill: boolean;
  onAutoSkill(on: boolean): void;
  onClose(): void;
  onSubmit(kind: "register" | "login", name: string, password: string): void;
}) {
  const {
    account, nameMaxLen, passwordMinLen,
    palette, onPalette, autoSkill, onAutoSkill, onClose, onSubmit,
  } = props;

  const chip = (on: boolean): React.CSSProperties => ({
    background: on ? C.winHi : "transparent",
    border: `1px solid ${on ? C.gold : C.line}`,
    color: on ? C.text : C.dim,
    fontFamily: FONT,
    fontSize: 12,
    padding: "4px 9px",
    cursor: "pointer",
    touchAction: "manipulation",
  });

  return (
    <div style={{ ...win, display: "flex", flexDirection: "column", minHeight: 0, overflowY: "auto" }}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
        <strong style={{ flex: 1, fontSize: 14 }}>설정</strong>
        <button
          type="button"
          onClick={onClose}
          aria-label="설정 닫기"
          style={{ ...chip(false), border: "none", fontSize: 16, padding: "0 4px" }}
        >
          ✕
        </button>
      </div>

      <div style={row}>
        <span style={label}>색</span>
        {(Object.keys(PALETTE_NAMES) as PaletteId[]).map((p) => (
          <button
            key={p}
            type="button"
            style={chip(palette === p)}
            aria-pressed={palette === p}
            onClick={() => onPalette(p)}
          >
            {PALETTE_NAMES[p]}
          </button>
        ))}
      </div>

      <div style={row}>
        <span style={label}>자동전투</span>
        <button
          type="button"
          style={chip(autoSkill)}
          aria-pressed={autoSkill}
          onClick={() => onAutoSkill(!autoSkill)}
        >
          {autoSkill ? "켜짐" : "꺼짐"}
        </button>
        {/* ★ 규칙을 그대로 적는다. '알아서 잘 쓴다' 로 적으면 사람이 판단을
            기대하고, 이 기능은 판단을 하지 않는다. */}
        <span style={{ color: C.dim, fontSize: 11, flexBasis: "100%" }}>
          교전 중에 쿨다운이 아닌 스킬을 목록 위에서부터 차례로 하나씩 쓴다.
        </span>
      </div>

      <div style={{ height: 1, background: C.edge, margin: "4px 0 12px" }} />

      <Account
        account={account}
        nameMaxLen={nameMaxLen}
        passwordMinLen={passwordMinLen}
        onClose={onClose}
        onSubmit={onSubmit}
        embedded
      />
    </div>
  );
}
