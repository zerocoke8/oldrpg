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
      fight.push({
        id: `skill:${sk.id}`,
        label: sk.name,
        action: { type: "skill", skillId: sk.id },
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
                ...(n.guild
                  ? [{ id: "promote", label: "승급 신청", action: { type: "promote", npcId: n.id } as Action }]
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

  items.push({ id: "say", label: "말하기", focus: "말하기 " });
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
