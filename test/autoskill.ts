/* 자동전투의 규칙. 클라이언트의 순수 함수 하나가 전부다.
 *
 * 규칙: **교전 중이고 예약 자리가 비어 있으면, combat.skills 를 서버가 준
 * 순서 그대로 훑어 쿨다운이 아닌 첫 번째를 고른다.** 판단이 없다.
 *
 * ★ 왜 이 파일이 브라우저 검사와 따로 있는가: 이 규칙의 갈래는 여섯인데
 *   (교전 아님 · 사람이 예약함 · 전부 쿨다운 · 순서 · 순환 · 대상),
 *   진짜 전투를 만들어야만 확인할 수 있게 두면 그중 대부분은 영영 안 밟힌다.
 *   브라우저 검사는 '스위치가 배선됐는가' 만 본다.
 *
 * ★ 그리고 이 함수가 규칙 1 의 경계다. 여기서 무엇을 고르느냐가 '입력 자동화'
 *   와 '클라이언트가 전투를 판정한다' 를 가른다. 그 경계는 검사로 지켜야 한다. */

import type { CombatView, SkillView } from "../shared/protocol";
import { nextAutoSkill } from "../client/state/prefs";

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

const skill = (id: string, readyInMs: number, target: "self" | "ally" = "self"): SkillView => ({
  id,
  name: id,
  readyInMs,
  target,
});

const combat = (over: Partial<CombatView> = {}): CombatView => ({
  enemy: { id: "e", name: "적", hp: 10, maxHp: 10 } as CombatView["enemy"],
  engaged: true,
  queuedSkill: null,
  queuedItem: null,
  skills: [skill("a", 0), skill("b", 0), skill("c", 0)],
  targetId: null,
  winding: false,
  allies: [],
  ...over,
});

function main(): void {
  section("① 순서 — 서버가 준 순서 그대로, 첫 번째");
  check("★ 셋 다 준비됐으면 맨 위를 쓴다", nextAutoSkill(combat()) === "a");
  check("★ 맨 위가 쿨다운이면 그다음을 쓴다",
    nextAutoSkill(combat({ skills: [skill("a", 900), skill("b", 0), skill("c", 0)] })) === "b");
  check("★ 위 둘이 쿨다운이면 셋째를 쓴다",
    nextAutoSkill(combat({ skills: [skill("a", 900), skill("b", 40), skill("c", 0)] })) === "c");
  /* ★ 정렬하지 않는다. 남은 시간이 짧은 것을 먼저 고르거나, 이름으로 줄을
     세우기 시작하면 그건 '고르는 것' 이고 규칙이 아니다. */
  check("★ 남은 시간으로 줄을 세우지 않는다 (그건 판단이다)",
    nextAutoSkill(combat({ skills: [skill("a", 5), skill("b", 0)] })) === "b" &&
      nextAutoSkill(combat({ skills: [skill("b", 0), skill("a", 5)] })) === "b");

  section("② 순환은 규칙에서 저절로 나온다 (별도 상태가 없다)");
  /* 쓰고 나면 그 스킬이 쿨다운으로 빠지므로 다음번엔 그다음 것이 첫 번째가
     된다. 함수가 '지난번에 무엇을 썼는지' 를 기억할 필요가 없다. */
  const cds = [0, 0, 0];
  const order: string[] = [];
  for (let i = 0; i < 3; i++) {
    const id = nextAutoSkill(
      combat({ skills: [skill("a", cds[0]!), skill("b", cds[1]!), skill("c", cds[2]!)] }),
    );
    order.push(id ?? "-");
    if (id) cds["abc".indexOf(id)] = 1000; // 쓴 것은 쿨다운으로
  }
  check("★ 세 번 부르면 a · b · c 가 차례로 나온다", order.join(",") === "a,b,c", order.join(","));

  section("③ 안 쓰는 자리 — 여기가 이 기능의 안전장치다");
  check("교전 중이 아니면 아무것도 안 한다",
    nextAutoSkill(combat({ engaged: false })) === null);
  check("전투가 없으면 아무것도 안 한다", nextAutoSkill(null) === null);
  check("전부 쿨다운이면 아무것도 안 한다",
    nextAutoSkill(combat({ skills: [skill("a", 100), skill("b", 100)] })) === null);
  check("스킬 목록이 비었으면 아무것도 안 한다",
    nextAutoSkill(combat({ skills: [] })) === null);
  /* ★ 예약 자리는 하나뿐이고 나중 입력이 이긴다. 사람이 고른 것을 자동이
     덮어쓰면 그건 '도와주는 것' 이 아니라 조종을 뺏는 것이다. */
  check("★ 사람이 스킬을 예약해 두었으면 건드리지 않는다",
    nextAutoSkill(combat({ queuedSkill: "b" })) === null);
  check("★ 사람이 아이템을 예약해 두었으면 건드리지 않는다",
    nextAutoSkill(combat({ queuedItem: "potion" })) === null);

  section("④ 대상 — 고르지 않는다");
  /* 이 함수는 skillId 만 돌려준다. 대상은 App 이 targetId 없이 보내므로
     언제나 자기 자신이다 — 남에게 걸 사람을 고르는 것이 바로 배제한 판단이다.
     ★ 그래서 target:"ally" 인 스킬도 다른 취급을 받지 않는다. 특별 취급을
       시작하면 "누구에게" 라는 질문이 따라오고, 그 답이 곧 전술이다. */
  check("★ ally 스킬도 순서에서 특별 취급하지 않는다",
    nextAutoSkill(combat({ skills: [skill("mend", 0, "ally"), skill("hit", 0)] })) === "mend");
  check("★ 돌려주는 것은 id 하나뿐이다 (대상을 실어 보내지 않는다)",
    typeof nextAutoSkill(combat()) === "string");

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${checks - failures}/${checks} 검사 통과`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
