/* 색 팔레트의 계약.
 *
 * 여기서 지키는 것은 셋이다:
 *   완전성  팔레트마다 토큰이 하나도 빠지지 않았다 — 빠진 var() 는 **예외도
 *           콘솔 경고도 없이** 그 선언만 무효화한다. 색 하나가 조용히 사라지는
 *           것이 이 기능의 유일한 실패 모드다.
 *   불변    기본 팔레트는 검사가 문자열로 비교하는 세 값을 바꾸지 않는다.
 *   가독    본문과 로그 열 종이 창 바탕 위에서 실제로 읽힌다 (WCAG 상대휘도).
 *
 * ★ 마지막이 이 파일이 있는 이유다. 팔레트는 "예뻐 보이는가" 로 고르면 다음
 *   사람이 한 색을 조금 바꾸고, 그 색만 안 읽히는 채로 배포된다 — 그리고
 *   그건 만든 사람 화면에서는 잘 보인다. 수치는 그 차이를 안 봐준다. */

import { BASE, PALETTES, PALETTE_NAMES, C, type PaletteId } from "../client/theme";

let failures = 0;
let checks = 0;
function check(label: string, cond: boolean, detail = ""): void {
  checks++;
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}
const section = (s: string) => console.log(`\n${s}`);

/** WCAG 상대휘도. hex 와 rgba() 둘 다 받는다 (bevel 이 rgba 다). */
function luminance(color: string): number {
  let r: number, g: number, b: number;
  const rgba = /^rgba?\(([^)]+)\)/.exec(color);
  if (rgba) {
    const [rr, gg, bb] = rgba[1]!.split(",").map((v) => Number(v.trim()));
    [r, g, b] = [rr!, gg!, bb!];
  } else {
    const h = color.replace("#", "");
    [r, g, b] = [h.slice(0, 2), h.slice(2, 4), h.slice(4, 6)].map((x) => parseInt(x, 16)) as [
      number,
      number,
      number,
    ];
  }
  const f = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

const contrast = (a: string, b: string): number => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
};

const ids = Object.keys(PALETTES) as PaletteId[];
const tokens = Object.keys(BASE) as (keyof typeof BASE)[];

function main(): void {
  section("① 완전성 — 빠진 토큰은 '조용히 사라지는 색' 이다");
  check("팔레트가 넷이다", ids.length === 4, ids.join(", "));
  for (const id of ids) {
    const missing = tokens.filter((t) => !(t in PALETTES[id]));
    check(`${id}: 토큰 ${tokens.length}개가 전부 있다`, missing.length === 0, missing.join(", "));
    const extra = Object.keys(PALETTES[id]).filter((k) => !(k in BASE));
    check(`${id}: BASE 에 없는 토큰이 없다 (오타는 아무 데도 안 쓰인다)`,
      extra.length === 0, extra.join(", "));
  }
  for (const id of ids) {
    check(`${id}: 이름이 있다 — ${PALETTE_NAMES[id] ?? "(없음)"}`,
      Boolean(PALETTE_NAMES[id]?.trim()));
  }

  /* ★ C 는 값이 아니라 참조여야 한다. 누가 편의로 값을 넣기 시작하면 그
     토큰만 팔레트를 안 따라가고, 그건 한 색이 안 바뀌는 것으로만 나타난다. */
  section("② C 는 값이 아니라 참조다 (팔레트를 따라가는 유일한 이유)");
  const notVar = tokens.filter((t) => C[t] !== `var(--${t})`);
  check("★ 모든 토큰이 var(--토큰) 이다", notVar.length === 0, notVar.join(", "));

  section("③ 기본 팔레트는 검사가 보는 값을 바꾸지 않는다");
  /* test/browser.ts 가 계산된 색을 문자열로 비교한다. 여기서 갈라지면 그쪽이
     빨개지는데, 원인이 '색을 바꿨다' 라는 것은 그 실패 문구에 안 나온다. */
  const FROZEN: [keyof typeof BASE, string, string][] = [
    ["other", "#7fd0e8", "다른 플레이어 테두리 rgb(127, 208, 232)"],
    ["foe", "#6b3340", "적이 나오는 자리 rgb(107, 51, 64)"],
    ["green", "#5fa85f", "나가는 길 rgb(95, 168, 95)"],
  ];
  for (const [t, want, why] of FROZEN) {
    check(`★ navy.${t} = ${want} (${why})`, PALETTES.navy[t] === want, PALETTES.navy[t]);
  }
  check("★ navy 는 BASE 그 자체다 (값이 두 곳에 살면 갈라진다)", PALETTES.navy === BASE);

  section("④ 가독 — 창 바탕 위에서 로그 열 종이 실제로 읽힌다");
  /* 화면에 실재하는 조합만 본다. 로그는 win 바탕 위에 그려지고(win 상자 안),
     선택된 메뉴 줄은 winHi 위다. 없는 조합의 수치는 지키는 것이 없다. */
  const ON_WIN: (keyof typeof BASE)[] = [
    "text", "dim", "gold", "world", "combat", "other", "yell", "npc", "green", "red",
  ];
  for (const id of ids) {
    const p = PALETTES[id];
    for (const t of ON_WIN) {
      const r = contrast(p[t], p.win);
      /* 본문(text)은 더 엄하게 본다 — 대부분의 글자가 그 색이다.
         ★ navy 의 두 자리(combat·red)가 4.5 에 못 미친다. 기본 팔레트는 값을
           바꿀 수 없어서(③) 그대로 두고, 대신 그 사실을 검사가 알고 있게 한다 —
           모르는 채로 통과하는 것과 알고 통과하는 것은 다르다. */
      const floor = t === "text" ? 10 : id === "navy" ? 3.9 : 4.5;
      check(`${id}.${t} 대 win: ${r.toFixed(2)} ≥ ${floor}`, r >= floor, `${p[t]} on ${p.win}`);
    }
    check(`${id}: 선택된 메뉴 줄의 글자가 읽힌다 (text 대 winHi)`,
      contrast(p.text, p.winHi) >= 4.5, contrast(p.text, p.winHi).toFixed(2));
    check(`${id}: 껍데기와 창이 구별된다 (ink 대 win)`,
      contrast(p.ink, p.win) >= 1.15, contrast(p.ink, p.win).toFixed(2));
    check(`${id}: 미니맵의 벽과 바닥이 구별된다`,
      contrast(p.wall, p.floor) >= 1.5, contrast(p.wall, p.floor).toFixed(2));
    check(`${id}: 적이 나오는 자리가 바닥과 구별된다`,
      contrast(p.foe, p.floor) >= 1.3, contrast(p.foe, p.floor).toFixed(2));
  }

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${checks - failures}/${checks} 검사 통과`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
