/* 계정 폼. 커맨드 창에서 '계정' 을 고르면 열린다.
 *
 * ★ 왜 커맨드 창의 자유 입력이 아닌가: 자유 입력줄은 입력이 화면에 그대로
 *   보이고 로그로도 갈 수 있다. 비밀번호는 그러면 안 된다. type="password"
 *   가 필요한 유일한 자리라 컴포넌트가 하나 생겼다.
 *
 * ★ 여기에 세계의 문장이 없다. 라벨은 UI 크롬(Status.tsx 와 같은 예외)이고,
 *   실패 이유는 전부 서버가 error{message} 로 보낸 것을 그대로 세운다 —
 *   "이름이나 비밀번호가 맞지 않습니다" 를 클라이언트가 만들면, 그 순간
 *   클라이언트가 '왜 거절인가' 를 알게 되고 그게 곧 오라클이다.
 *
 * ★ 비밀번호는 이 컴포넌트의 state 에만 산다. 저장하지 않는다 —
 *   localStorage 에 두면 그게 진짜 자격증명이 되고, 기기 토큰을 만든 이유가
 *   사라진다. 성공하면 서버가 기기 토큰을 주고 그 뒤로는 지금까지와 같다. */

import { useState } from "react";
import { C, FONT, win } from "../theme";

export function Account(props: {
  /** 지금 로그인되어 있는 계정 이름. null 이면 익명이다. */
  account: string | null;
  nameMaxLen: number;
  passwordMinLen: number;
  onSubmit(kind: "register" | "login", name: string, password: string): void;
  onClose(): void;
}) {
  const { account, nameMaxLen, passwordMinLen, onSubmit, onClose } = props;
  const [kind, setKind] = useState<"register" | "login">(account ? "login" : "register");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");

  const field = {
    background: "#0a0f2a",
    border: `1px solid ${C.dim}`,
    color: C.text,
    fontFamily: FONT,
    fontSize: 14,
    padding: "6px 8px",
    width: "100%",
    boxSizing: "border-box" as const,
  };
  const tab = (k: "register" | "login") => ({
    background: kind === k ? C.winHi : "transparent",
    border: `1px solid ${kind === k ? C.gold : C.line}`,
    color: kind === k ? C.text : C.dim,
    fontFamily: FONT,
    fontSize: 13,
    padding: "4px 10px",
    cursor: "pointer",
  });

  const ready = name.trim().length > 0 && password.length >= passwordMinLen;

  return (
    <div style={{ ...win, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <button type="button" style={tab("register")} onClick={() => setKind("register")}>
          계정 만들기
        </button>
        <button type="button" style={tab("login")} onClick={() => setKind("login")}>
          로그인
        </button>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={onClose}
          aria-label="닫기"
          style={{
            background: "none",
            border: "none",
            color: C.dim,
            fontFamily: FONT,
            fontSize: 14,
            cursor: "pointer",
          }}
        >
          ✕
        </button>
      </div>

      {/* 지금 하는 일이 무엇인지 한 줄. 라벨이지 서사가 아니다. */}
      <div style={{ fontSize: 11, color: C.dim }}>
        {kind === "register"
          ? "지금 이 캐릭터가 그대로 계정의 것이 된다 (새로 시작하지 않는다)."
          : "다른 기기에서도 같은 캐릭터로 들어온다."}
      </div>

      <label style={{ fontSize: 12, color: C.dim }}>
        이름
        <input
          style={field}
          value={name}
          maxLength={nameMaxLen}
          autoComplete="username"
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label style={{ fontSize: 12, color: C.dim }}>
        비밀번호 ({passwordMinLen}자 이상)
        <input
          style={field}
          type="password"
          value={password}
          autoComplete={kind === "register" ? "new-password" : "current-password"}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && ready) onSubmit(kind, name.trim(), password);
          }}
        />
      </label>

      <button
        type="button"
        disabled={!ready}
        onClick={() => onSubmit(kind, name.trim(), password)}
        style={{
          background: ready ? C.winHi : "transparent",
          border: `2px solid ${ready ? C.gold : C.line}`,
          color: ready ? C.text : C.dim,
          fontFamily: FONT,
          fontSize: 14,
          padding: "6px 0",
          cursor: ready ? "pointer" : "default",
        }}
      >
        {kind === "register" ? "만들기" : "들어가기"}
      </button>

      {/* ★ 지금 계정에 묶여 있다는 사실만 말한다. 이 문장을 계정 이름과 섞어
          만들지 않는다 — 이름은 Status 가 서버가 준 원형 그대로 세운다. */}
      {account && (
        <div style={{ fontSize: 11, color: C.dim }}>
          이미 계정에 묶여 있다. 다른 계정으로 들어가면 이 탭은 그쪽 캐릭터가 된다.
        </div>
      )}
    </div>
  );
}
