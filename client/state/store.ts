/* ServerMsg -> UI 상태. 클라이언트의 유일한 리듀서.
 *
 * ★ 프로토콜 불변식 (3) 이 여기서 이행된다:
 *   모르는 `t` 는 console.debug 후 무시한다. throw 도 연결 종료도 하지 않는다.
 *   never 기반 exhaustive switch 를 '쓰지 않는' 것이 의도다 — 2·3단계가
 *   새 메시지를 추가해도 낡은 탭이 그냥 무시하고 계속 돈다.
 *
 * ★ 로그는 배열 인덱스가 아니라 log.id 로 키잉한다.
 *   log.replace 는 1단계 서버가 절대 보내지 않지만, 이 자료구조 결정은
 *   나중에 바꾸려면 로그 렌더러를 통째로 갈아야 한다. 그래서 지금 한다. */

import type { Pos, RoomId } from "../../shared/ids";
import type {
  Limits,
  PlayerBrief,
  RegionView,
  RoomView,
  SelfState,
  ServerMsg,
  TextSource,
  LogKind,
  WorldFlagView,
  CombatView,
  DialogueView,
  ItemStack,
} from "../../shared/protocol";

/** 클라이언트 내부 이벤트. 와이어에는 존재하지 않지만 같은 리듀서를 지난다 —
 *  UI 상태의 출처를 하나로 유지하기 위해서다. `t` 가 `__` 로 시작하므로
 *  서버 메시지와 충돌할 수 없다. */
export type LocalMsg = { t: "__conn"; status: UiState["status"]; notice: string | null };

export interface LogLine {
  id: string;
  kind: LogKind;
  text: string;
  speaker?: PlayerBrief;
  source?: TextSource;
}

export interface UiState {
  status: "connecting" | "live" | "closed";
  notice: string | null; // error{} 는 서사 로그가 아니라 여기로 간다
  self: SelfState | null;
  region: RegionView | null;
  room: RoomView | null;
  /** 미니맵의 다른 플레이어들. presence 계열이 유일한 출처다. */
  others: Map<string, { player: PlayerBrief; pos: Pos }>;
  log: LogLine[];
  limits: Limits | null;
  /** 공개된 월드 플래그. 스냅샷이 전부 주고 world.flag 가 델타로 갱신한다.
   *  label 은 서버가 만든다 — 클라이언트는 key 로 문구를 조립하지 않는다. */
  world: Map<string, WorldFlagView>;
  /** 진행 중인 전투. 실시간이라 이 값이 초당 여러 번 바뀐다. */
  combat: CombatView | null;
  /** 가방. 서버가 통째로 보내므로 델타를 합치지 않는다. */
  items: ItemStack[];
  /** 열려 있는 대화창. 주제 '목록' 일 뿐 대사는 여기 없다 —
   *  대사는 log{kind:"npc"} 가 나른다 (불변식 1: 문장은 log 만 나른다). */
  dialogue: DialogueView | null;
}

export const initialState = (): UiState => ({
  status: "connecting",
  notice: null,
  self: null,
  region: null,
  room: null,
  others: new Map(),
  log: [],
  limits: null,
  world: new Map(),
  combat: null,
  dialogue: null,
  items: [],
});

const MAX_LOG = 300;

/** 그 NPC 가 아직 이 방에 있으면 대화창을 유지한다. 없으면 닫는다. */
const keepDialogue = (d: DialogueView | null, room: RoomView): DialogueView | null =>
  d && room.npcs.some((n) => n.id === d.npc.id) ? d : null;

const pushLog = (log: LogLine[], line: LogLine): LogLine[] => {
  const next = [...log, line];
  return next.length > MAX_LOG ? next.slice(next.length - MAX_LOG) : next;
};

export function reduce(st: UiState, m: ServerMsg | LocalMsg): UiState {
  switch (m.t) {
    case "__conn":
      /* ★ error{} 가 남긴 문장을 덮지 않는다. 서버가 이유를 말하고 소켓을
         닫으면 close 가 곧바로 뒤따라오는데, 그때 "연결이 끊겼다" 로
         갈아치우면 사람은 **왜** 끊겼는지를 영영 못 본다 (계정 거절이 정확히
         그 모양이다: 이유 한 줄 + 즉시 종료). 이미 닫힘으로 표시된 상태의
         문장은 그것이 진짜 이유다. */
      if (st.status === "closed" && st.notice && m.status !== "live") {
        return { ...st, status: m.status };
      }
      return { ...st, status: m.status, notice: m.notice };

    case "welcome":
      return { ...st, status: "live", limits: m.limits, notice: null };

    case "snapshot": {
      // 최초 접속 · 재접속 · resync 가 전부 같은 코드 경로다.
      const others = new Map(st.others);
      others.clear();
      for (const p of m.presence) others.set(p.player.id, p);
      // 접속 전에 일어난 세계의 변화도 여기서 복원된다.
      const world = new Map((m.world ?? []).map((f) => [f.key, f]));
      // 새로고침해도 전투가 이어진다 (세션이 유예로 살아남으므로).
      return {
        ...st,
        self: m.self,
        region: m.region,
        room: m.room,
        others,
        world,
        combat: m.combat ?? null,
        dialogue: keepDialogue(st.dialogue, m.room),
        items: m.self.items ?? [],
      };
    }

    case "ack":
      // 위치는 Reconciler 가 소유한다 (여기서 self.pos 를 건드리면 두 번째
      // 출처가 생겨, 늦게 도착한 패치가 이미 정산된 위치를 되감는다).
      return st;

    case "room.describe": {
      // 방이 바뀌면 대화창은 닫힌다. 서버가 '닫아라' 를 보내지 않는 이유는
      // 그럴 필요가 없기 때문이다 — 방에 그 NPC 가 없다는 구조화 사실에서
      // 순수하게 파생된다. (그래도 권위는 서버다: 닫히지 않은 창으로 물어도
      // world/dialogue.ts 가 같은 방인지 다시 본다.)
      //
      /* ★ 다른 방으로 옮겼으면 **지난 방의 묘사**를 걷어낸다. 다섯 칸을
         걸으면 로그에 묘사가 다섯 개 쌓이고, 지금 서 있는 곳의 문장은 그
         더미의 맨 아래에 묻힌다 — 읽으라고 만든 문장이 읽기 어려워진다.

         걷어내는 것은 'narr' 뿐이다. 말·외침·전투 결과·시스템 문구는 남는다:
         걸었다고 방금 나눈 대화가 사라지면 그건 편의가 아니라 손실이다.

         ★ 'room.describe 가 왔다' 가 아니라 '방 id 가 달라졌다' 로 판정한다.
           이 메시지는 부활할 때도, 적이 돌아와 방의 구조가 바뀔 때도 온다
           (index.ts 의 setOnRoomChanged). 그때는 같은 방이므로 지우지 않는다.

         ★ 지운 줄에 대한 log.replace 가 뒤늦게 와도 안전하다 — 아래 map 이
           id 를 못 찾고 아무 일도 하지 않는다. 승급이 늦게 도착하는 것은
           2단계의 정상 동작이라 이 경우가 실제로 생긴다. */
      const moved = st.room !== null && st.room.roomId !== m.room.roomId;
      return {
        ...st,
        room: m.room,
        dialogue: keepDialogue(st.dialogue, m.room),
        ...(moved ? { log: st.log.filter((l) => l.kind !== "narr") } : {}),
      };
    }

    case "self.patch":
      if (!st.self) return st;
      return {
        ...st,
        self: {
          ...st.self,
          ...(m.hp !== undefined ? { hp: m.hp } : {}),
          ...(m.maxHp !== undefined ? { maxHp: m.maxHp } : {}),
          ...(m.seen !== undefined ? { seen: m.seen } : {}),
          /* 등급과 일지도 self 안이다. 스냅샷이 SelfState 를 통째로 갈아끼우고
             델타가 필드만 덮으므로, 둘 다 같은 자리에 있어야 서로를 지우지
             않는다. (가방·격자는 반대로 self 밖이다 — 아래 참조.) */
          ...(m.rank !== undefined ? { rank: m.rank } : {}),
          ...(m.missions !== undefined ? { missions: m.missions } : {}),
        },
        // 가방은 self 안이 아니라 UiState 최상단에 산다 — SelfState 를 통째로
        // 갈아끼우는 스냅샷 경로와 델타 경로가 서로를 지우지 않게 한다.
        ...(m.items !== undefined ? { items: m.items } : {}),
        // 지역이 바뀌었다. 격자도 self 밖에 산다 (같은 이유).
        ...(m.region !== undefined ? { region: m.region } : {}),
      };

    // presence 계열 — join 은 player.id 기준 '멱등 upsert', leave 는
    // 모르는 id 에 대해 'no-op'. 이 두 성질이 유예와 소켓 교체를 조용하게 만든다.
    case "presence.join": {
      const others = new Map(st.others);
      others.set(m.player.id, { player: m.player, pos: m.pos });
      return { ...st, others };
    }
    case "presence.move": {
      const cur = st.others.get(m.playerId);
      if (!cur) return st; // 모르는 id — no-op
      const others = new Map(st.others);
      others.set(m.playerId, { player: cur.player, pos: m.pos });
      return { ...st, others };
    }
    case "presence.leave": {
      if (!st.others.has(m.playerId)) return st; // no-op
      const others = new Map(st.others);
      others.delete(m.playerId);
      return { ...st, others };
    }

    // room 계열 — 구조화 데이터만. 문장은 뒤따르는 log 가 싣는다.
    case "room.enter": {
      if (!st.room) return st;
      if (st.room.occupants.some((o) => o.id === m.player.id)) return st; // 멱등
      return { ...st, room: { ...st.room, occupants: [...st.room.occupants, m.player] } };
    }
    case "room.leave": {
      if (!st.room) return st;
      return {
        ...st,
        room: { ...st.room, occupants: st.room.occupants.filter((o) => o.id !== m.playerId) },
      };
    }

    case "log":
      return {
        ...st,
        log: pushLog(st.log, {
          id: m.id,
          kind: m.kind,
          text: m.text,
          ...(m.speaker ? { speaker: m.speaker } : {}),
          ...(m.source ? { source: m.source } : {}),
        }),
      };

    case "log.replace":
      // 1단계 서버는 보내지 않는다. 2단계의 provisional -> 확정 교체가 이걸 쓴다.
      return {
        ...st,
        log: st.log.map((l) => (l.id === m.id ? { ...l, text: m.text, source: m.source } : l)),
      };

    case "npc.dialogue":
      // 말을 걸었다 / 주제 목록이 갱신됐다. 대사 문장은 뒤따르는 log 가 싣는다.
      return { ...st, dialogue: m.dialogue };

    case "combat.start":
      return { ...st, combat: m.combat };

    case "combat.update": {
      if (!st.combat) return st; // 모르는 전투의 갱신 — no-op
      return {
        ...st,
        combat: {
          ...st.combat,
          enemy: { ...st.combat.enemy, hp: m.enemyHp },
          ...(m.targetId !== undefined ? { targetId: m.targetId } : {}),
          ...(m.queuedSkill !== undefined ? { queuedSkill: m.queuedSkill } : {}),
          ...(m.queuedItem !== undefined ? { queuedItem: m.queuedItem } : {}),
          ...(m.skills !== undefined ? { skills: m.skills } : {}),
          ...(m.allies !== undefined ? { allies: m.allies } : {}),
          ...(m.winding !== undefined ? { winding: m.winding } : {}),
          ...(m.engaged !== undefined ? { engaged: m.engaged } : {}),
        },
      };
    }

    case "combat.end":
      return { ...st, combat: null };

    case "world.flag": {
      // 구조화 상태만. 이 메시지는 방 묘사를 갈아치우라는 뜻이 '아니다' —
      // 새 묘사는 다음 입장부터다 (CLAUDE.md 63줄). 화면에 뜨는 문장은
      // 뒤따르는 log{kind:"world"} 가 싣는다.
      const world = new Map(st.world);
      world.set(m.flag.key, m.flag);
      return { ...st, world };
    }

    case "ping":
      return st; // pong 은 소켓 계층이 답한다

    case "error":
      // 계약 위반은 서사 로그에 절대 찍지 않는다.
      return { ...st, notice: m.message, status: "closed" };

    default: {
      // 모르는 메시지. 2·3단계의 추가분이 낡은 탭을 깨뜨리지 않게 한다.
      console.debug("[mud] 모르는 메시지 무시", m);
      return st;
    }
  }
}

/** 안개: 밟아 본 방만 보인다. 서버가 seen 을 소유하므로 새로고침에도 남는다. */
export const isSeen = (self: SelfState | null, roomId: RoomId): boolean =>
  Boolean(self?.seen.includes(roomId));
