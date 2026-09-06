/* 임무의 '규칙'. 정의는 데이터가 소유하고(content/world/missions.json),
 * 여기 있는 것은 판정뿐이다 — 순수 함수이고 DB 도 파일도 모른다.
 * engine/guild.ts 와 같은 모양이고 같은 이유로 여기 있다.
 *
 * ★ 왜 임무가 세계 플래그가 아닌가: 플래그는 세계가 한 번 바뀌면 모두에게
 *   바뀐다. "증식체가 죽었다" 는 모두에게 참이지만 "이 사람이 증식체 처리
 *   임무를 받았고 0/1 이다" 는 그 사람에게만 참이다. 그래서 등급과 같은
 *   부류이고, 다만 한 사람에게 여럿이라 표다 (마이그레이션 005).
 *
 * ★ 목표는 지금 'slay' 하나뿐이다. 종류를 늘리면 데이터가 스크립트 언어가
 *   된다 (CLAUDE.md 의 "규칙은 데이터로 표현할 수 없다"). 늘려야 할 때가
 *   오면 그때 판정 함수가 늘지, 데이터에 조건식이 생기지 않는다. */

/** 임무 하나의 정의. content/world/missions.json 의 값이다. */
export interface MissionDef {
  readonly id: string;
  /** 누가 게시하는가. 이 NPC 에게만 받고 이 NPC 에게만 낸다. */
  readonly npcId: string;
  readonly name: string;
  /** 게시판에 적힌 한 줄. 플레이어가 읽는 문장이므로 데이터다 — 코드에 박아
   *  두면 세계관을 갈아끼울 때 그 문장만 옛 세계에 남는다. */
  readonly brief: string;
  /** 이 등급 이상이어야 받을 수 있다. 0 이면 아무나. */
  readonly minRank: number;
  /** 이 플래그가 켜져야 게시된다. null 이면 언제나. */
  readonly requires: string | null;
  readonly goal: MissionGoal;
  /** 보수. 아이템만 준다 — 승급은 여전히 접수원에게 따로 신청한다.
   *  두 계통을 직교로 두면 사다리(ranks.json)가 임무 목록에 종속되지 않는다. */
  readonly reward: readonly { readonly itemId: string; readonly qty: number }[];
}

export interface MissionGoal {
  readonly kind: "slay";
  readonly enemyId: string;
  readonly count: number;
}

/** 그 사람의 임무 하나. DB 행에서 온다. */
export interface MissionState {
  readonly missionId: string;
  readonly progress: number;
  readonly done: boolean;
}

/** 게시되는가 — 세계가 그 임무를 내걸었는가. 자격(minRank)은 여기서 보지
 *  않는다: 등급이 모자라도 '무엇을 하면 되는지' 는 보여야 한다. 문의
 *  minRank 와 같은 판단이다 (자격은 감출 이유가 없다). */
export function isPosted(m: MissionDef, isFlagOn: (key: string) => boolean): boolean {
  return m.requires === null || isFlagOn(m.requires);
}

/** 이 목표를 이제 영영 못 잡는가.
 *
 *  ★ 왜 필요한가: 세계를 바꾸는 적(slainFlag 가 있고 respawnMs 가 없는 적)은
 *    서버 수명 동안 딱 한 번뿐이다. 그런데 게시는 그 사실을 안 봤다 — 첫
 *    플레이어가 잡고 나면 접수원은 **이미 죽어 없는 보스의 임무를 영원히
 *    계속 게시**했고, 받은 사람의 일지에는 영영 0/1 이 박혔다.
 *    임무 5개 중 2개가 그런 임무였다.
 *
 *  ★ 판정 자체는 world/combat.ts 의 enemyIn 과 같은 규칙이다: 보스는 플래그로
 *    사라지고 반복되는 적은 타이머로 돌아온다. 여기서는 '영영' 만 본다 —
 *    리스폰 대기 중인 적은 곧 돌아오므로 임무는 여전히 유효하다. */
export function goalGone(
  m: MissionDef,
  enemy: { slainFlag: string | null; respawnMs: number | null } | undefined,
  isFlagOn: (key: string) => boolean,
): boolean {
  if (m.goal.kind !== "slay" || !enemy) return false;
  if (enemy.respawnMs !== null) return false;
  return enemy.slainFlag !== null && isFlagOn(enemy.slainFlag);
}

export type AcceptResult =
  | { ok: true }
  | { ok: false; reason: "unposted" }
  /** 목표가 세계에서 영영 사라졌다. */
  | { ok: false; reason: "gone" }
  | { ok: false; reason: "rank"; need: number }
  | { ok: false; reason: "taken" }
  | { ok: false; reason: "done" };

/** 받을 수 있는가. **아무것도 바꾸지 않는다.** */
export function resolveAccept(
  m: MissionDef,
  rank: number,
  have: MissionState | null,
  isFlagOn: (key: string) => boolean,
  /** 목표가 영영 사라졌는가 (goalGone). 호출자가 밸런스를 보고 넘긴다 —
   *  engine 은 적의 정의를 들고 있지 않다. */
  gone = false,
): AcceptResult {
  /* ★ 게시를 자격보다 먼저 본다. 아직 안 걸린 임무 앞에서 "등급이 모자라다"
     고 답하면 그 임무의 존재를 자백하는 셈이다 — 문의 requires/minRank 순서와
     같은 판단이다. */
  if (!isPosted(m, isFlagOn)) return { ok: false, reason: "unposted" };
  /* 게시 바로 다음이다. 자격보다 먼저 보는 이유는 unposted 와 같다 — 못 끝낼
     일에 "등급이 모자란다" 고 답하면 등급을 올리러 가게 만든다. */
  if (gone) return { ok: false, reason: "gone" };
  if (m.minRank > rank) return { ok: false, reason: "rank", need: m.minRank };
  /* 끝낸 것을 먼저 본다. 둘 다 참인 행("받았고 끝냈다")에서 '진행 중' 이라고
     답하면 이미 낸 임무를 다시 진행하는 것처럼 보인다. */
  if (have?.done) return { ok: false, reason: "done" };
  if (have) return { ok: false, reason: "taken" };
  return { ok: true };
}

/** 이 적을 쓰러뜨린 것이 그 임무의 진행인가. 진행이면 얼마나 오르는가.
 *
 *  ★ 0 을 돌려주는 것과 '진행 중이 아니다' 를 구별하지 않는다 — 호출자는
 *    어차피 0 이면 UPDATE 를 돌리지 않는다. */
export function slayCredit(m: MissionDef, st: MissionState, enemyId: string): number {
  if (st.done) return 0;
  if (m.goal.kind !== "slay" || m.goal.enemyId !== enemyId) return 0;
  if (st.progress >= m.goal.count) return 0;
  return 1;
}

/** 목표를 채웠는가. 상한을 넘긴 행(데이터의 count 가 줄어든 경우)도 참이다. */
export function isComplete(m: MissionDef, st: MissionState): boolean {
  return st.progress >= m.goal.count;
}

export type TurnInResult =
  | { ok: true; reward: readonly { readonly itemId: string; readonly qty: number }[] }
  | { ok: false; reason: "not_taken" }
  | { ok: false; reason: "done" }
  | { ok: false; reason: "short"; have: number; need: number };

/** 제출 판정. **아무것도 바꾸지 않는다** — 무엇을 줘야 하는지를 돌려줄 뿐이고
 *  지급과 기록은 호출자(world/missions.ts)의 일이다. */
export function resolveTurnIn(m: MissionDef, st: MissionState | null): TurnInResult {
  if (!st) return { ok: false, reason: "not_taken" };
  if (st.done) return { ok: false, reason: "done" };
  if (!isComplete(m, st)) {
    return { ok: false, reason: "short", have: st.progress, need: m.goal.count };
  }
  return { ok: true, reward: m.reward };
}
