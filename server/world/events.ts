/* 이벤트 -> 재렌더링. CLAUDE.md 의 다섯 단계를 그 순서 그대로 구현한다.
 *
 *   1. 엔진이 플래그를 켠다 (예: guardian_slain = true)
 *   2. 미리 써둔 문장을 '즉시' 브로드캐스트한다
 *   3. 그 플래그를 sensitive_flags 에 선언한 방만 큐에 넣는다
 *   4. 워커가 하나씩 재생성해 DB 에 기록한다
 *   5. 새 텍스트는 '다음 입장부터' 적용한다
 *
 * ★ 5번이 이 파일에서 가장 중요한 제약이다. charter 63줄:
 *   "지금 그 방에 서 있는 플레이어의 화면을 갈아치우지 않는다."
 *   그래서 3단계는 log.replace 를 '절대' 보내지 않는다. log.replace 는
 *   2단계의 provisional -> 확정 전용이다. 여기서는 near/far 이벤트 문장만
 *   보내고, 새 묘사는 플레이어가 다시 들어오거나 직접 살펴볼 때 나타난다.
 *
 * ★ 2번의 '미리 써둔 문장' 은 규칙 4의 이행이다. 플래그를 켠 순간 사람을
 *   재생성 앞에 세워두지 않는다 — 문장은 파일에서 읽은 결정론적 텍스트이고,
 *   재생성은 4번의 백그라운드 큐가 한다.
 *
 * 이 파일과 upgrade.ts, index.ts 만이 engine + db + narration + net 을 함께 안다. */

import type { RoomId } from "../../shared/ids";
import { roomIdOf } from "../../shared/ids";
import type { JsonScalar } from "../../shared/json";
import type { WorldFlagView } from "../../shared/protocol";
import { isBroadcastFlag, WORLD_FLAGS, type GameMap } from "../engine/map";
import type { World } from "../engine/world";
import type { Queries } from "../db/queries";
import type { Mood } from "../narration/prompts";
import type { Emit } from "../net/emit";
import type { Registry } from "../net/session";
import type { RoomTextService } from "./roomText";
import type { NpcTextService } from "./npcText";
import type { UpgradeService } from "./upgrade";

export interface SetFlagResult {
  /** 값이 실제로 바뀌었는가. 같은 값으로 다시 켜면 false 이고 아무 일도 안 한다. */
  changed: boolean;
  /** 재생성 큐에 들어간 방 수 (3·4번). */
  queued: number;
  /** 재생성 큐에 들어간 NPC 대사 수 — charter 59줄의 "방·NPC" 다. */
  queuedNpcLines: number;
  /** near 문장을 받은 세션 수, far 문장을 받은 세션 수. */
  near: number;
  far: number;
}

export interface EventService {
  /** 엔진이 세계를 바꾼다. 4단계 전투가 부를 진입점이 바로 이것이다.
   *  value 는 JSON 스칼라 — 불리언에서 카운터로 바뀌어도 시그니처가 그대로다. */
  setFlag(key: string, value: JsonScalar): SetFlagResult;
  /** 공개된 플래그들의 현재 값. 스냅샷이 싣는다. */
  publicFlags(): WorldFlagView[];
  /** 그 플래그가 켜져 있는가. 전투가 '이 적은 이미 죽었나' 를 물을 때 쓴다 —
   *  적의 사망은 별도 표가 아니라 월드 플래그가 소유한다. */
  isFlagOn(key: string): boolean;
}

export function makeEvents(
  world: World,
  /** NPC 배치의 출처 (어느 NPC 가 이 플래그에 반응하는가). */
  map: GameMap,
  q: Queries,
  reg: Registry,
  emit: Emit,
  moods: ReadonlyMap<string, Mood>,
  roomText: RoomTextService,
  npcText: NpcTextService,
  upgrades: UpgradeService,
  clock: () => number,
): EventService {
  function viewOf(key: string): WorldFlagView {
    const value = world.flagValue(key);
    const mood = moods.get(key);
    // 켜져 있을 때만 라벨을 준다 — 꺼진 상태에 표시할 것이 없다.
    return { key, value, label: value === true ? (mood?.label ?? null) : null };
  }

  function publicFlags(): WorldFlagView[] {
    return Object.keys(WORLD_FLAGS)
      .filter(isBroadcastFlag)
      .map(viewOf)
      .filter((f) => f.value !== null);
  }

  function setFlag(key: string, value: JsonScalar): SetFlagResult {
    if (!(key in WORLD_FLAGS)) throw new Error(`선언되지 않은 플래그: ${key}`);

    const next = JSON.stringify(value); // 정규화는 여기 한 곳 (db/queries 의 setFlag 와 짝)
    const prev = world.getFlag(key);
    if (prev === next) return { changed: false, queued: 0, queuedNpcLines: 0, near: 0, far: 0 };

    // ── 1. 엔진이 플래그를 켠다 ──────────────────────────────────────
    //    DB 커밋이 먼저, 메모리 갱신이 나중. 이동 경로와 같은 규칙이다 —
    //    반대 순서면 둘이 어긋났을 때 보상할 경로가 없다.
    q.setFlag.run(key, next, clock());
    world.applyFlag(key, next);

    // ── 2. 미리 써둔 문장을 '즉시' 브로드캐스트 ──────────────────────
    //    파일에서 읽은 결정론적 텍스트다. 아무도 재생성을 기다리지 않는다.
    const mood = moods.get(key);
    // 그 플래그를 '선언한' 방들 — 3번의 영향 범위와 같은 집합이다.
    const affected = new Set(world.roomsSensitiveTo(key));
    let near = 0;
    let far = 0;
    if (mood?.near || mood?.far) {
      for (const s of reg.all()) {
        const inAffected = affected.has(roomIdOf(s.pos));
        const text = inAffected ? mood.near : mood.far;
        if (!text) continue;
        emit.log(s, "world", text);
        if (inAffected) near++;
        else far++;
      }
    }

    // 구조화 상태는 따로 간다 (프로토콜 불변식 1). 공개 플래그만.
    if (isBroadcastFlag(key)) {
      const view = viewOf(key);
      for (const s of reg.all()) emit.send(s, { t: "world.flag", flag: view });
    }

    // ── 3·4. 영향받는 방만 큐에 넣는다 ───────────────────────────────
    //    플래그가 바뀌면 그 방들의 state_hash 가 바뀌므로 전부 캐시 미스다.
    //    지금 미리 만들어 두면 다음 입장이 '확정본 즉시' 가 된다.
    let queued = 0;
    for (const roomId of affected) {
      if (pregenerate(roomId)) queued++;
    }
    /* NPC 도 같은 규칙이다 (charter 59줄: "그 플래그를 sensitive_flags 에
       선언한 방·NPC만 큐에 넣는다"). 지금 열려 있는 주제만 미리 만든다 —
       아직 잠긴 주제는 열리는 순간이 곧 그 주제의 첫 방문이다. */
    let queuedNpcLines = 0;
    for (const npc of map.npcsSensitiveTo(key)) {
      for (const topic of world.openTopics(npc.id)) {
        if (pregenerateNpc(npc.id, topic.id)) queuedNpcLines++;
      }
    }

    // ── 5. 새 텍스트는 '다음 입장부터'. 여기서 하는 일은 없다. ────────
    //    log.replace 를 보내지 않는 것이 곧 5번의 이행이다.

    return { changed: true, queued, queuedNpcLines, near, far };
  }

  /** 그 방의 '지금 상태' 텍스트를 미리 만들어 둔다.
   *
   *  charter 50줄의 순서를 그대로 탄다: 조회 -> 없으면 생성 -> DB 기록.
   *  roomText.get() 이 폴백 행을 만들고(규칙 3: 씨앗에서 '다시 렌더링'),
   *  그 '다음에' upgrades 가 그 위에 LLM 확정본을 얹는다.
   *
   *  ★ 순서가 중요하다. 폴백 행이 생기기 전에 승급을 큐에 넣으면 워커가
   *    없는 행을 승급하려다 헛돈다. 그래서 반드시 체이닝한다.
   *
   *  승급을 지켜보는 세션은 없다 — 아무도 그 문장을 아직 화면에 갖고 있지
   *  않기 때문이다. 목적은 '다음 입장이 확정본 즉시가 되게' 하는 것뿐이다. */
  function pregenerate(roomId: RoomId): boolean {
    const stateHash = world.stateHash(roomId);
    const existing = q.getRoomText.get(roomId, stateHash);
    if (existing && existing.source !== "fallback") return false; // 이미 확정본

    if (existing) return upgrades.enqueue({ kind: "room", roomId, stateHash });

    void roomText
      .get(roomId)
      .then(() => upgrades.enqueue({ kind: "room", roomId, stateHash }))
      .catch((err: unknown) => {
        // 실패해도 이벤트 처리를 막지 않는다 — 그 방은 다음 입장 때
        // 평범한 캐시 미스로 처리된다.
        console.error(`[events] pregenerate ${roomId}`, err);
      });
    return true;
  }

  /** 방의 사전 생성과 같은 절차. 폴백 행이 먼저 생기고 그 '다음에' 승급을
   *  건다 — 순서를 어기면 워커가 없는 행을 승급하려다 헛돈다. */
  function pregenerateNpc(npcId: string, topic: string): boolean {
    const stateHash = world.npcStateHash(npcId, topic);
    const existing = q.getNpcLine.get(npcId, topic, stateHash);
    if (existing && existing.source !== "fallback") return false;
    if (existing) return upgrades.enqueue({ kind: "npc", npcId, topic, stateHash });

    void npcText
      .get(npcId, topic)
      .then(() => upgrades.enqueue({ kind: "npc", npcId, topic, stateHash }))
      .catch((err: unknown) => {
        console.error(`[events] pregenerate npc ${npcId}/${topic}`, err);
      });
    return true;
  }

  return { setFlag, publicFlags, isFlagOn: (key) => world.flagValue(key) === true };
}
