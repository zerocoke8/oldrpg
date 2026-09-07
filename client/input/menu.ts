/* 입력 어댑터 4: JRPG 커맨드 창.
 *
 * charter 79-80줄: "새 입력 방식을 추가할 때는 이 객체를 만드는 어댑터만
 * 추가한다. 액션 처리 로직을 입력 방식별로 분기하지 않는다."
 * 이 파일이 그 문장의 네 번째 증거다 — 키보드·D패드·자유 텍스트와 똑같은
 * Action 을 만들고, 그 뒤로는 커맨드 창이라는 개념이 존재하지 않는다.
 *
 * ★ 메뉴는 '상태의 순수 함수' 다. 저장된 트리가 없고 매 렌더 다시 세운다.
 *   그래서 적이 죽거나 NPC 의 방을 벗어나면 그 가지가 저절로 사라진다 —
 *   "닫아라" 를 서버가 보내지 않아도 구조화 사실에서 파생된다.
 *   (4b 의 대화창이 닫히는 규칙과 같은 것이고, 권위는 여전히 서버다:
 *    사라지지 않은 가지를 눌러도 서버가 다시 판정한다.)
 *
 * ★ 여기에는 세계의 문장이 없다. 라벨은 UI 크롬(살펴보기/싸우기)이거나
 *   서버가 보낸 이름·라벨(제단지기, 봉인된 문에 대해)이다. */

import type { Action } from "../../shared/protocol";
import type { UiState } from "../state/store";

export interface MenuItem {
  /** 경로 세그먼트. 상태가 바뀌어도 같은 항목이면 같아야 한다 (커서 유지). */
  id: string;
  label: string;
  /** 고르면 서버로 갈 액션. */
  action?: Action;
  /** 고르면 들어갈 하위 메뉴. action 과 함께 있을 수 있다 —
   *  "제단지기" 는 말을 걸면서(action) 주제 목록으로 들어간다(items). */
  items?: MenuItem[];
  /** 고르면 자유 입력창으로 포커스를 옮기고 이 접두사를 채운다. */
  focus?: string;
  /** 쿨다운 중인 스킬 등. 커서가 건너뛴다. */
  disabled?: boolean;
  /** 라벨 옆의 작은 표시 (남은 초, "예약"). */
  note?: string;
  /** 항목이 없을 때 대신 보여줄 한 줄. */
  empty?: string;
}

/** 최상위 커맨드. 지금 할 수 있는 것만 올라온다. */
export function rootItems(st: UiState): MenuItem[] {
  const items: MenuItem[] = [{ id: "look", label: "살펴보기", action: { type: "look" } }];

  /* 싸우기 — 교전 중이거나, 방에 적이 서 있을 때.
     hasEnemy 는 room.describe 가 실어 준 구조화 사실이다. */
  const combat = st.combat;
  if (combat || st.room?.hasEnemy) {
    const fight: MenuItem[] = [{ id: "attack", label: "공격", action: { type: "attack" } }];
    for (const sk of combat?.skills ?? []) {
      const cooling = sk.readyInMs > 0;
      /* ★ 남에게 걸 수 있는 스킬은 '자기에게' 를 먼저 둔 대상 목록을 편다.
         후보는 서버가 보낸 combat.allies — 같은 전투의 사람들이다. 혼자면
         목록이 자기 하나뿐이라 펴 봐야 의미가 없어서, 그때는 예전처럼
         고르는 즉시 자기에게 건다. 그래야 솔로 플레이가 한 번 더 눌리지
         않는다.
         action 은 두 갈래 모두 같은 모양이다 (charter 79-80줄) — 대상이
         붙는 것뿐이고, 유효성은 어차피 서버가 다시 본다. */
      const allies = sk.target === "ally" ? (combat?.allies ?? []) : [];
      fight.push({
        id: `skill:${sk.id}`,
        label: sk.name,
        ...(allies.length
          ? {
              items: [
                {
                  id: "self",
                  label: "자기에게",
                  action: { type: "skill", skillId: sk.id } as Action,
                },
                ...allies.map((a) => ({
                  id: `at:${a.id}`,
                  label: a.name,
                  action: { type: "skill", skillId: sk.id, targetId: a.id } as Action,
                })),
              ],
            }
          : { action: { type: "skill", skillId: sk.id } as Action }),
        disabled: cooling,
        ...(cooling
          ? { note: `${Math.ceil(sk.readyInMs / 1000)}` }
          : combat?.queuedSkill === sk.id
            ? { note: "예약" }
            : {}),
      });
    }
    if (combat?.engaged) fight.push({ id: "stop", label: "물러나기", action: { type: "stop" } });
    items.push({ id: "fight", label: "싸우기", items: fight });
  }

  /* 대화 — 방에 NPC 가 있을 때. 들어가는 것이 곧 말을 거는 것이다. */
  const npcs = st.room?.npcs ?? [];
  if (npcs.length) {
    items.push({
      id: "talk",
      label: "대화",
      items: npcs.map((n) => ({
        id: `npc:${n.id}`,
        label: n.name,
        action: { type: "talk", npcId: n.id } as Action,
        // 주제는 서버가 보낸 것만. 잠긴 것은 애초에 오지 않는다 (스포일러).
        // 길드 접수원에게는 '승급 신청' 이 하나 더 붙는다 — 자격이 되는지는
        // 서버가 본다. 클라이언트가 미리 걸러 버리면 '무엇이 모자란지' 를
        // 알려 줄 기회가 사라진다.
        items:
          st.dialogue?.npc.id === n.id
            ? [
                ...st.dialogue.topics.map((t) => ({
                  id: `topic:${t.id}`,
                  label: t.label,
                  action: { type: "ask", npcId: n.id, topic: t.id } as Action,
                })),
                /* 임무. 서버가 보낸 것만 — 아직 게시되지 않은 것은 애초에
                   오지 않는다 (잠긴 주제와 같다). 자격이 모자란 것(locked)은
                   오되 비활성이다: 무엇을 하면 되는지는 감출 이유가 없다. */
                ...(st.dialogue.missions ?? []).map((m) => ({
                  id: `mission:${m.id}`,
                  label: m.name,
                  action: (m.state === "complete"
                    ? { type: "turn_in", npcId: n.id, missionId: m.id }
                    : { type: "accept_mission", npcId: n.id, missionId: m.id }) as Action,
                  note:
                    m.state === "complete"
                      ? "제출"
                      : m.state === "taken"
                        ? `${m.progress}/${m.goal}`
                        : m.state === "locked"
                          ? "자격 부족"
                          : m.reward,
                  /* ★ locked 를 비활성으로 두지 않는다. 서버는 "첫 하강은(는)
                     견습 이상에게만 맡긴다" 를 이미 준비해 두는데, 비활성이면
                     커서가 건너뛰고 클릭도 막혀서 그 문장이 발화될 방법이
                     없었다 — 신규 플레이어가 회색 항목 셋을 보고 탭을 닫는
                     지점이 거기다. 자격 판정은 어차피 서버가 다시 한다. */
                  disabled: m.state === "taken",
                })),
                ...(n.guild
                  ? [{
                      id: "promote",
                      /* rank 0 에서 이 버튼의 실제 효과는 '무료 등록' 이다
                         (ranks.json 의 1등급은 requires: []). "승급 신청" 은
                         뭔가 자격을 쌓아야 눌리는 것처럼 들린다. 라벨은
                         클라이언트 크롬이라 불변식 (1)을 어기지 않는다. */
                      label: (st.self?.rank.level ?? 0) === 0 ? "길드에 등록" : "승급 신청",
                      action: { type: "promote", npcId: n.id } as Action,
                    }]
                  : []),
              ]
            : [],
        empty: "…",
      })),
    });
  }

  /* 가방 — 가진 것이 있을 때만. 적·NPC 와 같은 규칙이다: 메뉴는 상태의
     순수 함수이고, 다 쓰면 그 가지가 저절로 사라진다. */
  if (st.items.length) {
    items.push({
      id: "bag",
      label: "가방",
      items: st.items.map((it) => ({
        id: `item:${it.id}`,
        label: it.name,
        action: { type: "use_item", itemId: it.id } as Action,
        ...(it.qty > 1 ? { note: `x${it.qty}` } : {}),
        /* 쓸 수 없는 것(전리품)도 목록에는 둔다 — 가진 것을 숨기지 않는다.
           비활성이라 커서가 건너뛰고, 눌러도 서버가 문장으로 답한다. */
        disabled: !it.usable,
      })),
    });
  }

  /* 건네기 — 이 방에 사람이 있고 내가 가진 것이 있을 때만. 메뉴가 상태의
     순수 함수라 상대가 방을 떠나면 이 가지가 저절로 사라진다.
     사람 -> 물건 순인 이유: 물건 -> 사람이면 가방 가지가 하위 메뉴를 하나 더
     갖게 되어 물약을 마시는 데 키가 하나 더 든다.
     ★ 증표를 회색으로 처리하지 않는다. usable 을 '건넬 수 있는가' 로 다시
       읽으면 클라이언트가 규칙을 갖게 된다 — 가방 가지가 이미 '눌러도 서버가
       문장으로 답한다' 를 택해 두었고, 여기서도 같다. */
  const here = st.room?.occupants ?? [];
  if (here.length && st.items.length) {
    items.push({
      id: "give",
      label: "건네기",
      items: here.map((p) => ({
        id: `to:${p.id}`,
        label: p.name,
        items: st.items.map((it) => ({
          id: `give:${p.id}:${it.id}`,
          label: it.name,
          ...(it.qty > 1 ? { note: `x${it.qty}` } : {}),
          action: { type: "give", targetId: p.id, itemId: it.id } as Action,
        })),
        empty: "…",
      })),
    });
  }

  /* 일지 — 맡은 것이 있을 때만. 가방과 같은 규칙이다. 전부 비활성이다:
     읽는 곳이지 누르는 곳이 아니고, 제출은 게시한 사람 앞에서만 된다. */
  const journal = st.self?.missions ?? [];
  if (journal.length) {
    items.push({
      id: "journal",
      label: "일지",
      /* 항목을 열면 지시문이 나온다. brief 는 서버가 만들어 보낸 문자열을
         그대로 세우는 것이라 클라이언트가 문장을 조립하는 게 아니다 —
         log.text 를 그리는 것과 같다 (불변식 1). 지시문이 없으면 "첫 하강"
         네 글자만으로 어디로 가는지 알 수 없다. */
      items: journal.map((m) => ({
        id: `j:${m.id}`,
        label: m.name,
        note: m.done ? "보고" : `${m.progress}/${m.goal}`,
        items: [
          ...(m.brief ? [{ id: `jb:${m.id}`, label: m.brief, disabled: true }] : []),
          /* 돌려주기. 목표가 영영 사라진 임무(누군가 먼저 보스를 잡았다)를
             들고 있으면 이게 유일한 탈출구다. */
          { id: `jd:${m.id}`, label: "돌려주기", action: { type: "abandon_mission", missionId: m.id } as Action },
        ],
        empty: "…",
      })),
    });
  }

  items.push({ id: "say", label: "말하기", focus: "말하기 " });
  items.push({ id: "yell", label: "외치기", focus: "외치기 " });
  return items;
}

export interface MenuView {
  items: MenuItem[];
  /** 지금까지 내려온 항목들. 창 제목이 된다. */
  trail: MenuItem[];
}

/** 경로를 따라 내려간다. 중간에 사라진 가지가 있으면 null —
 *  호출자는 최상위로 되돌린다 (적이 죽었거나 방을 떠난 경우). */
export function resolve(root: MenuItem[], path: readonly string[]): MenuView | null {
  let items = root;
  const trail: MenuItem[] = [];
  for (const seg of path) {
    const hit = items.find((i) => i.id === seg);
    if (!hit?.items) return null;
    trail.push(hit);
    items = hit.items;
  }
  return { items, trail };
}

/** 커서를 다음 '고를 수 있는' 항목으로. 비활성(쿨다운)은 건너뛴다.
 *  전부 비활성이면 제자리 — 무한 루프가 되지 않게 길이만큼만 돈다. */
export function moveCursor(items: readonly MenuItem[], from: number, delta: number): number {
  if (!items.length) return 0;
  let i = from;
  for (let n = 0; n < items.length; n++) {
    i = (i + delta + items.length) % items.length;
    if (!items[i]?.disabled) return i;
  }
  return from;
}
