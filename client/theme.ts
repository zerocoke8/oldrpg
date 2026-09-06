/* 프로토타입의 색상표를 그대로 승계한다. LogKind 와 1:1로 맞춰 두어
   4단계에 good/bad 가 실제로 쓰이기 시작해도 이 테이블을 고칠 일이 없다. */
import type { LogKind } from "../shared/protocol";

export const C = {
  ink: "#0b1020",
  win: "#16204a",
  winHi: "#26346f",
  line: "#e6e9f5",
  text: "#eef1fa",
  dim: "#8f9ec4",
  gold: "#e3b23c",
  red: "#c2483f",
  green: "#5fa85f",
  other: "#7fd0e8",
} as const;

export const FONT =
  "'Pretendard', -apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', 'Malgun Gothic', system-ui, sans-serif";

/* 모르는 kind 는 narr 로 격하한다 (프로토콜 불변식 3).
   never 기반 exhaustive switch 를 쓰지 않는 이유가 이것이다 —
   서버가 새 kind 를 보내면 조용히 읽히는 편이 낫지 크래시하면 안 된다. */
const LOG_COLOR: Record<string, string> = {
  narr: C.text,
  sys: C.dim,
  presence: C.gold,
  world: "#b98cd6",
  combat: "#9fb0d8",
  say: C.other,
  good: C.green,
  bad: C.red,
};
export const logColor = (k: LogKind | string): string => LOG_COLOR[k] ?? C.text;

export const win = {
  background: C.win,
  border: `2px solid ${C.line}`,
  boxShadow: `inset 0 0 0 2px ${C.win}, inset 0 0 0 3px rgba(230,233,245,.35)`,
  padding: "10px 12px",
} as const;
