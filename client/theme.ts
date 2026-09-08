/* 색. 값 하나짜리 상수 테이블이었는데, 사람이 고를 수 있는 팔레트 넷이 되었다.
 *
 * ★ 왜 CSS 변수인가: C 를 import 하는 파일이 아홉이고 전부 인라인 스타일로
 *   쓴다 (win 은 모듈 상수라 `...win` 으로 스프레드된다). React context 로
 *   바꾸면 그 아홉의 서명이 전부 바뀐다. var() 는 상수를 상수인 채로 두고
 *   값만 갈아끼운다 — 코드가 한 글자도 안 바뀐다.
 *
 * ★ 왜 C 를 손으로 적지 않고 BASE 에서 파생시키는가: 정의되지 않은 var() 는
 *   **예외도 콘솔 경고도 없이** 그 선언만 무효화한다 (color 는 상속 검정,
 *   border/outline 은 style:none 이 된다). 오타 하나가 조용한 시각 버그가
 *   된다는 뜻이다. 키에서 파생시키면 그 오타가 컴파일 오류로 돌아온다.
 *
 * ★ 왜 'theme' 이 아니라 'palette' 인가: 이 저장소에서 theme 은 이미 지역의
 *   설정이다 (content/world/briefs/README.md, prompts 의 {{theme}}).
 *   사람이 보는 이름도 세계의 낱말이 아니라 계기판의 말이다 — 세계관을
 *   갈아끼우면 "낡은 양피지" 같은 이름만 옛 세계에 남는다. */

import type { LogKind } from "../shared/protocol";

/** 기본 팔레트의 값 테이블. 토큰 이름의 출처이기도 하다.
 *
 *  ★ 이 값들은 검사가 문자열로 비교한다 (test/browser.ts):
 *      other  rgb(127, 208, 232)  다른 플레이어 테두리
 *      foe    rgb(107, 51, 64)    적이 나오는 자리 배경
 *      green  rgb(95, 168, 95)    나가는 길 안쪽 테두리
 *    기본 팔레트가 이 셋을 바꾸면 그 검사들이 무엇을 지키는지 흐려진다. */
export const BASE = {
  ink: "#0b1020",
  win: "#16204a",
  winHi: "#26346f",
  /** 입력칸 테두리. 기본에서는 winHi 와 같은 값이지만 역할이 다르다 —
   *  밝은 팔레트에서는 '선택된 줄 위의 글자' 와 '껍데기 위의 테두리' 를
   *  한 값으로 동시에 만족시킬 수 없어서 갈라야 했다. */
  edge: "#26346f",
  line: "#e6e9f5",
  text: "#eef1fa",
  dim: "#8f9ec4",
  gold: "#e3b23c",
  /* ★ #c2483f 였다. 창 바탕(#16204a) 위에서 3.20:1 — 전투 피해와 패배 문구가
     읽기 어려웠고, 아무도 잰 적이 없어서 아무도 몰랐다 (test/palette.ts 가
     생기면서 처음 드러났다). 색조는 그대로 두고 명도만 올려 4.61:1 로.
     검사가 문자열로 비교하는 세 값에 red 는 없으므로 바꿔도 안전하다. */
  red: "#d96a5f",
  green: "#5fa85f",
  other: "#7fd0e8",
  npc: "#d7bd8a",
  /** 미니맵. 벽 · 바닥 · 적이 나오는 자리. */
  wall: "#2b3563",
  floor: "#5b6bab",
  foe: "#6b3340",
  /** 게이지의 빈 부분 (HP 막대 안쪽). */
  trough: "#0a0f2a",
  /** 창틀의 광택 한 겹. */
  bevel: "rgba(230,233,245,.35)",
  /** 로그에만 쓰는 셋. 키 이름이 LogKind 와 같아야 한다 — 아래 LOG_COLOR 가
   *  그 이름으로 찾는다. */
  world: "#b98cd6",
  combat: "#9fb0d8",
  yell: "#8ec5a8",
} as const;

type Token = keyof typeof BASE;

/** 코드가 쓰는 것. 값이 아니라 **참조**다.
 *  as const 를 잃는 대신 Readonly 로 대입을 막는다 — C.typo 는 여전히
 *  컴파일 오류이고, 그게 이 파생의 요점이다. */
export const C = Object.fromEntries(
  (Object.keys(BASE) as Token[]).map((k) => [k, `var(--${k})`]),
) as Readonly<Record<Token, string>>;

export type PaletteId = "navy" | "slate" | "sepia" | "light";

/** 커맨드 창에 뜨는 이름. 계기판의 말이지 세계의 낱말이 아니다. */
export const PALETTE_NAMES: Record<PaletteId, string> = {
  navy: "어두운 남색",
  slate: "어두운 회색",
  sepia: "어두운 갈색",
  light: "밝은 색",
};

/** 넷의 값. 본문·로그 열 종의 대비를 WCAG 상대휘도로 계산해서 골랐다
 *  (본문 13:1 이상, 보조색 4.5:1 이상 — 기본 팔레트의 두 자리만 예외이고
 *  그건 값을 못 바꾸기 때문이다). */
export const PALETTES: Record<PaletteId, Record<Token, string>> = {
  /* ★ 리터럴을 다시 적지 않는다. 검사가 보는 세 값이 두 곳에 살면 갈라진다. */
  navy: BASE,
  slate: {
    ink: "#0e1113", win: "#212a2e", winHi: "#374349", edge: "#374349",
    line: "#dfe5e8", text: "#f0f4f6", dim: "#a3b0b6", gold: "#d9b361",
    red: "#e0736a", green: "#74c489", other: "#79cfe0", npc: "#d3c19b",
    wall: "#2f393e", floor: "#59656b", foe: "#552a2b", trough: "#0a0d0f",
    bevel: "rgba(223,229,232,.28)", world: "#c39ad8", combat: "#a8b6bd", yell: "#8fd3b6",
  },
  sepia: {
    ink: "#120d09", win: "#302115", winHi: "#48351f", edge: "#48351f",
    line: "#f2e6d3", text: "#f8efdf", dim: "#c0a887", gold: "#f2c552",
    red: "#e8796a", green: "#90c983", other: "#7ed0dd", npc: "#e6c894",
    wall: "#3d2a19", floor: "#6b5236", foe: "#552420", trough: "#0d0906",
    bevel: "rgba(242,230,211,.26)", world: "#cfa0e0", combat: "#b9a68c", yell: "#93d6ad",
  },
  light: {
    ink: "#e4d9bd", win: "#f3ecd9", winHi: "#dbcca6", edge: "#6f5f40",
    line: "#4f4229", text: "#1f190f", dim: "#57492e", gold: "#6f4a06",
    red: "#9b2a1e", green: "#25602c", other: "#0f5872", npc: "#63441a",
    wall: "#9a8760", floor: "#d3c4a0", foe: "#dc9b8b", trough: "#cdbc94",
    bevel: "rgba(31,25,15,.45)", world: "#5e3795", combat: "#414d60", yell: "#16604a",
  },
};

const KEY = "mud.palette";

/** ★ 슬롯(?as=)을 붙이지 않는다. socket.ts 의 mud.token.<슬롯> 은 '이 탭의
 *  캐릭터' 를 가르는 장치지만, 색은 사람의 것이라 탭마다 다르면 안 된다.
 *  ★ 사생활 보호 창에서는 localStorage 접근 자체가 던진다. 그때는 기본값으로
 *  돌아가고 조용히 계속한다 — 색 때문에 게임이 안 뜨면 안 된다. */
export const loadPalette = (): PaletteId => {
  try {
    const v = localStorage.getItem(KEY);
    return v && v in PALETTES ? (v as PaletteId) : "navy";
  } catch {
    return "navy";
  }
};

export const savePalette = (p: PaletteId): void => {
  try {
    localStorage.setItem(KEY, p);
  } catch {
    /* 저장 못 해도 이번 세션에는 적용된다 */
  }
};

/** DOM 을 만지는 유일한 자리.
 *
 *  ★ main.tsx 가 render() '전에' 한 번 부른다. useEffect 로 미루면 첫 페인트가
 *    변수 없이 나가고, 그 한 프레임 동안 창틀도 글자색도 없다 (실측:
 *    background rgba(0,0,0,0) · border none · color rgb(0,0,0)). 매 로드마다
 *    깜빡이는 셈이라 사람 눈에 띈다. */
export function applyPalette(p: PaletteId): void {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(PALETTES[p])) root.style.setProperty(`--${k}`, v);
  /* html/body 의 배경은 client/index.html 이 var(--ink) 로 칠한다 — 여기서
     다시 박으면 두 곳이 같은 일을 하고 한쪽만 낡는다.
     meta[theme-color] 만은 CSS 가 아니라 var() 를 못 쓴다. 유일한 예외다. */
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", PALETTES[p].ink);
}

export const FONT =
  "'Pretendard', -apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', 'Malgun Gothic', system-ui, sans-serif";

/* 모르는 kind 는 narr 로 격하한다 (프로토콜 불변식 3).
   never 기반 exhaustive switch 를 쓰지 않는 이유가 이것이다 —
   서버가 새 kind 를 보내면 조용히 읽히는 편이 낫지 크래시하면 안 된다. */
const LOG_COLOR: Record<string, string> = {
  narr: C.text,
  sys: C.dim,
  presence: C.gold,
  world: C.world,
  combat: C.combat,
  say: C.other,
  // 방 발화와 눈에 띄게 달라야 한다 — 라벨("(구역)")을 클라이언트가 붙이면
  // 불변식 (1) 위반이라, 이 둘을 가르는 표시는 색뿐이다.
  yell: C.yell,
  npc: C.npc,
  good: C.green,
  bad: C.red,
};
export const logColor = (k: LogKind | string): string => LOG_COLOR[k] ?? C.text;

export const win = {
  background: C.win,
  border: `2px solid ${C.line}`,
  boxShadow: `inset 0 0 0 2px ${C.win}, inset 0 0 0 3px ${C.bevel}`,
  padding: "10px 12px",
} as const;
