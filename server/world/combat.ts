/* 실시간 전투. engine(판정) + db(HP) + narration(문장) + net(방출) 을
 * 조합하는 곳이다. events.ts, upgrade.ts, index.ts 와 함께 조합 지점 중 하나.
 *
 * ★ 실시간의 뼈대
 *   - 게으른 100ms 루프. 전투가 하나도 없으면 타이머 자체가 없다.
 *   - 전투원마다 nextActAt 을 갖는다. 기본 공격 500ms, 적 700ms.
 *     틱을 500ms 로 두지 않는 이유: 간격이 '루프의 성질' 이 아니라
 *     '전투원의 데이터' 여야 무기 속도·가속·시전시간이 숫자 하나로 들어온다.
 *   - 시각은 '단조' 시계다. Date.now() 는 역행할 수 있고, 그러면 모든
 *     전투원이 영원히 대기하거나 한꺼번에 몰아친다 (토큰 버킷에서 겪은 그 버그).
 *
 * ★ 어그로: 누적 피해가 가장 큰 사람을 노린다 (engine/combat.ts 의 pickTarget).
 *
 * ★ 스킬: 예약해 두면 다음 스윙에 기본 공격을 '대신해' 발동한다 (최대 0.5초).
 *   즉시 발동이 아니라 다음 틱인 이유는 스킬 연타로 스윙 리듬을 깨지 못하게.
 *
 * ★ 규칙 4: 전투 문장은 전부 결정론적이다 (narration/lines.ts).
 *   0.5초 간격에 모델을 기다릴 수 없다.
 *
 * ★ 영속화: 전투는 '살아 있는 세션에만 있는 사실' 이라 표를 만들지 않는다.
 *   플레이어 HP 만 players 에 write-through 한다 (이동 경로와 같은 규칙:
 *   DB 커밋이 먼저, 메모리 갱신이 나중). 적의 '사망' 은 world_flags 로 가고,
 *   그 순간 3단계의 재렌더링 파이프라인이 통째로 돈다. */

import type { PlayerId, RoomId } from "../../shared/ids";
import { roomIdOf } from "../../shared/ids";
import type { CombatView, EnemyView, PlayerBrief, SkillView } from "../../shared/protocol";
import type { Balance, EnemyDef } from "../engine/enemies";
import {
  pickTarget,
  resolveEnemySwing,
  resolvePlayerSwing,
  rollDrops,
  sharers,
  windsUp,
  type Effect,
} from "../engine/combat";
import { makeRng, type Rng } from "../engine/rng";
import type { GameMap } from "../engine/map";
import type { Queries } from "../db/queries";
import { lines } from "../narration/lines";
import type { Emit } from "../net/emit";
import type { Registry, Session } from "../net/session";
import type { EventService } from "./events";
import type { InventoryService } from "./inventory";
import type { MissionService } from "./missions";

export const TICK_MS = 100;
export const RESPAWN_MS = 5000;

/** 전투에 참여 중인 한 사람. */
interface Fighter {
  playerId: PlayerId;
  /** 자동 공격이 켜져 있는가. stop 하면 꺼지지만 적은 계속 때린다. */
  engaged: boolean;
  /** 다음 스윙 시각 (단조 ms). */
  nextActAt: number;
  swingMs: number;
  /** 다음 스윙에 기본 공격을 '대신할' 것. 자리는 하나다 —
   *  스킬이든 아이템이든 나중 입력이 앞의 것을 덮어쓴다.
   *  와이어에는 queuedSkill / queuedItem 둘로 나뉘어 나가지만, 둘 다 채워지는
   *  일은 없다 (한 자리에서 파생되기 때문이다). */
  queued: { kind: "skill" | "item"; id: string; targetId?: PlayerId } | null;
  /** skillId -> 쿨다운이 끝나는 시각 (단조 ms). */
  /** 스킬 쿨다운은 Fighter 가 아니라 플레이어에 산다 (아래 cooldownsOf).
   *  여기 두면 전투에서 빠지는 것만으로 전부 리셋된다. */
  /** 다음 피격에 적용될 경감(%). 한 번 쓰면 0 으로 돌아간다. */
  guardPercent: number;
  /** 교전 순서. pickTarget 의 동점 처리에 쓰인다. */
  joinedSeq: number;
}

/** 방 하나의 전투. 적이 하나이므로 방 = 전투다. */
interface Combat {
  roomId: RoomId;
  def: EnemyDef;
  hp: number;
  nextActAt: number;
  fighters: Map<PlayerId, Fighter>;
  /** 누적 피해 = 위협. 적은 이게 가장 큰 사람을 노린다. */
  threat: Map<PlayerId, number>;
  targetId: PlayerId | null;
  /** 예고 뒤로 평범하게 몇 번 때렸는가. 예고가 나가면 0 으로 돌아간다. */
  swingsSinceWindup: number;
  /** 몸을 젖혀 두었다 — 다음 스윙이 큰 것이다. */
  charged: boolean;
  rng: Rng;
  seq: number;
}

export interface CombatService {
  /** 이 방의 적과 교전을 시작한다(멱등). 실패하면 이유 문장을 돌려준다. */
  attack(s: Session): string | null;
  /** targetId 는 치유·방어를 남에게 걸 때만 쓴다. 같은 전투인지, 그 스킬이
   *  남에게 걸 수 있는지는 이 함수가 다시 본다 — 클라이언트를 믿지 않는다. */
  skill(s: Session, skillId: string, targetId?: PlayerId): string | null;
  stop(s: Session): string | null;
  /** 아이템을 쓴다. 전투 중이면 다음 스윙에 예약된다. */
  useItem(s: Session, itemId: string): string | null;
  /** 이동·접속종료 등으로 전투에서 빠진다. */
  leave(playerId: PlayerId, reason: "left" | "gone"): void;
  /** 스냅샷용. 전투 중이 아니면 null. */
  viewFor(playerId: PlayerId): CombatView | null;
  /** 그 방에 살아 있는 적이 있는가 (방 묘사/입장 안내용). */
  enemyIn(roomId: RoomId): EnemyDef | null;
  stop_(): void;
  activeCount(): number;
}

export interface CombatOptions {
  /** 단조 시계. 테스트가 시간을 손으로 돌릴 수 있게 주입한다. */
  now?: () => number;
  /** 시드 생성기. 주입하면 전투가 완전히 재현된다. */
  seedFor?: (roomId: RoomId) => number;
  tickMs?: number;
  respawnMs?: number;
  /** 테스트가 틱을 손으로 돌릴 때 자동 루프를 끈다. */
  manualTick?: boolean;
}

export function makeCombat(
  q: Queries,
  reg: Registry,
  emit: Emit,
  events: EventService,
  inventory: InventoryService,
  missions: MissionService,
  /** 적 배치와 부활 지점의 출처. 수치와 같은 주입이다 — engine 은 파일을 읽지 않는다. */
  map: GameMap,
  /** 수치는 데이터가 소유한다 (content/balance/). 시계·시드와 같은 주입이다. */
  balance: Balance,
  clock: () => number,
  opts: CombatOptions = {},
): CombatService {
  const now = opts.now ?? (() => Number(process.hrtime.bigint() / 1_000_000n));
  const tickMs = opts.tickMs ?? TICK_MS;
  const respawnMs = opts.respawnMs ?? balance.player.respawnMs;
  let seedCounter = 1;
  const seedFor = opts.seedFor ?? (() => seedCounter++ * 2654435761);

  const combats = new Map<RoomId, Combat>();
  /** playerId -> roomId. 한 사람은 한 전투에만 있다. */
  const inCombat = new Map<PlayerId, RoomId>();
  /** 쓰러진 '반복되는 적' -> 돌아올 시각(단조 시계).
   *
   *  ★ 메모리다. 표를 만들지 않는 이유는 전투 중 HP 와 같다 — 재시작하면
   *    전부 살아 있고 그것이 정직하다. 영속화하면 크래시마다 청소해야 할
   *    거짓 행이 생긴다. 보스의 사망만 영속(월드 플래그)이고, 그건 세계가
   *    바뀐 사건이라 살아남아야 한다.
   *  ★ setTimeout 이 아니라 틱이 소유한다. 주입된 시계 위에서 돌아야
   *    테스트가 손으로 시간을 밀 수 있고, 타이머 하나에 상태를 걸었다가
   *    그것을 잃는 실패 모드(부활 결함)를 되풀이하지 않는다. */
  const downed = new Map<RoomId, number>();
  let timer: NodeJS.Timeout | null = null;

  /* ── 헬퍼 ─────────────────────────────────────────────────────────── */

  const sessionOf = (id: PlayerId): Session | undefined => reg.get(id);
  const nameOf = (id: PlayerId): string => sessionOf(id)?.brief.name ?? "누군가";

  function enemyIn(roomId: RoomId): EnemyDef | null {
    const sep = roomId.indexOf(":");
    const coord = roomId.slice(sep + 1);
    // 배치(맵)와 정의(밸런스)가 두 단계로 갈라져 있다. 짝은 부팅에서 검증된다.
    // 배치는 지역마다 따로다 — 같은 좌표가 지역마다 다른 적을 가리킨다.
    const id = map.region(roomId.slice(0, sep))?.enemies[coord];
    const def = id ? balance.enemies[id] : undefined;
    if (!def) return null;
    /* 이미 죽은 적은 없는 것과 같다. 죽음의 '소유자' 가 둘로 나뉜다:
         돌아오지 않는 적 — 월드 플래그 (영속. 세계가 바뀐 사건이다)
         돌아오는 적      — 리스폰 대기 (메모리. 돌아올 때까지만 없다)

       ★ 플래그를 켜는 적이 곧 '돌아오지 않는 적' 은 아니다. 그 둘은 다른
         축이다 — 플래그는 '세계가 바뀌었다' 를, 리스폰은 '그 적이 지금
         있는가' 를 말한다. respawnMs 가 있으면 타이머가 존재를 정하고,
         플래그는 그 사건이 있었다는 기록으로만 남는다.
         (한때 묶여 있었고, 그래서 보스가 서버 수명 동안 한 번뿐이었다.) */
    if (def.respawnMs === null && def.slainFlag !== null && events.isFlagOn(def.slainFlag)) {
      return null;
    }
    if (downed.has(roomId)) return null;
    return def;
  }

  /** 돌아올 때가 됐다. 지금 그 방에 서 있는 사람에게 무엇을 보낼 것인가가
   *  이 절의 유일한 설계 결정이다.
   *
   *  ★ 방 묘사를 다시 그리지 않는다 (charter 63줄: "지금 그 방에 서 있는
   *    플레이어의 화면을 갈아치우지 않는다"). 3단계가 log.replace 를 쓰지
   *    않는 것과 같은 이유다. 나가는 것은 두 가지뿐이다 —
   *      결정론 문장 한 줄 (narration/lines.ts. 모델을 기다리지 않는다)
   *      구조화 상태 갱신 (hasEnemy. 커맨드 창의 '싸우기' 가 다시 선다) */
  function respawnEnemy(roomId: RoomId): void {
    downed.delete(roomId);
    const def = enemyIn(roomId);
    if (!def) return; // 그 사이 보스 플래그가 켜졌다거나 — 조용히 넘어간다
    emit.toRoom(roomId, null, (s) => {
      emit.log(s, "bad", lines.enemyReturns(def.name));
      onRoomChanged?.(s);
    });
    /* ★ 방 밖에도 알린다. 미니맵은 지역 전체를 그리므로, 옆 방에 서 있는
       사람의 지도도 지금 바뀌었다. onRoomChanged 는 그 방 사람에게만 간다. */
    onFoesChanged?.(roomId);
    maybeStopTimer();
  }

  const enemyView = (c: Combat): EnemyView => ({
    id: c.def.id,
    name: c.def.name,
    hp: c.hp,
    maxHp: c.def.maxHp,
  });

  function skillViews(f: Fighter, t: number): SkillView[] {
    return balance.skillList.map((sk) => ({
      id: sk.id,
      name: sk.name,
      readyInMs: Math.max(0, (cooldownsOf(f.playerId).get(sk.id) ?? 0) - t),
      target: sk.target,
    }));
  }

  /** 나를 뺀 같은 전투의 사람들. 치유·방어의 대상 후보. */
  function alliesOf(c: Combat, playerId: PlayerId): PlayerBrief[] {
    const out: PlayerBrief[] = [];
    for (const other of c.fighters.keys()) {
      if (other === playerId) continue;
      const s = sessionOf(other);
      if (s) out.push(s.brief);
    }
    return out;
  }

  function viewFor(playerId: PlayerId): CombatView | null {
    const roomId = inCombat.get(playerId);
    if (!roomId) return null;
    const c = combats.get(roomId);
    const f = c?.fighters.get(playerId);
    if (!c || !f) return null;
    return {
      enemy: enemyView(c),
      engaged: f.engaged,
      queuedSkill: f.queued?.kind === "skill" ? f.queued.id : null,
      queuedItem: f.queued?.kind === "item" ? f.queued.id : null,
      skills: skillViews(f, now()),
      targetId: c.targetId,
      winding: c.charged,
      allies: alliesOf(c, playerId),
    };
  }

  /** 그 방의 전투원들에게. 전투는 방 단위라 room 계열과 수신자가 같다. */
  /* ★ 쿨다운은 플레이어에 산다. Fighter 에 두면 전투가 사라질 때 함께 사라지고,
     전투는 마지막 사람이 방을 나가는 순간 통째로 삭제된다(leave) — 즉 "붙었다
     떨어졌다" 만으로 쿨다운이 리셋됐다.

     그게 무료 무한 회복을 만들었다: 응급 처치는 8초에 12~18(1.88/초)이고 제일
     약한 적은 1.2초에 1~2(1.25/초)다. 가장 약한 적에게 붙어 회복만 돌리면
     순 +0.63/초로 체력이 무한히 찬다. 전투 밖 회복이 없으므로(charter 의
     "회복은 전투 중에만") 그게 이 게임에서 가장 싼 회복 수단이었다.

     세션이 사라져도 이 맵은 남는다 — 재접속으로 쿨다운을 리셋하지 못하게.
     플레이어가 정리되는 곳(reapStalePlayers)에서 함께 지운다. */
  const cooldowns = new Map<PlayerId, Map<string, number>>();
  function cooldownsOf(playerId: PlayerId): Map<string, number> {
    let m = cooldowns.get(playerId);
    if (!m) {
      m = new Map();
      cooldowns.set(playerId, m);
    }
    return m;
  }

  /** 같은 방에 서 있는데 싸우지는 않는 사람들.
   *
   *  ★ 왜 필요한가: 전투 서술이 c.fighters 로 잠겨 있어서, 같은 방의 구경꾼은
   *    적이 죽은 것조차 문장으로 못 들었다. 그러면 남이 싸우는 것을 보고
   *    합류할 계기가 화면에 아예 없다 — 이 게임에서 둘이 함께하는 유일한
   *    행위가 '같은 적을 친다' 인데 그 시작을 볼 방법이 없었다.
   *
   *  ★ 스윙마다 보내지 않는다. 구경꾼에게 필요한 것은 '시작' 과 '끝' 뿐이고,
   *    한 대 한 대를 흘리면 방에 둘만 있어도 로그가 두 배가 된다. */
  function toBystanders(c: Combat, fn: (s: Session) => void): void {
    emit.toRoom(c.roomId, null, (s) => {
      if (c.fighters.has(s.playerId)) return;
      fn(s);
    });
  }

  function toCombat(c: Combat, fn: (s: Session, f: Fighter) => void): void {
    for (const f of c.fighters.values()) {
      const s = sessionOf(f.playerId);
      if (s) fn(s, f);
    }
  }

  function pushUpdate(c: Combat): void {
    const t = now();
    toCombat(c, (s, f) => {
      emit.send(s, {
        t: "combat.update",
        enemyHp: c.hp,
        // 항상 싣는다. 누가 맞고 있는지는 어그로 모델에서 화면의 핵심 정보이고,
        // 아낄 만한 바이트도 아니다.
        targetId: c.targetId,
        queuedSkill: f.queued?.kind === "skill" ? f.queued.id : null,
        queuedItem: f.queued?.kind === "item" ? f.queued.id : null,
        skills: skillViews(f, t),
        allies: alliesOf(c, f.playerId),
        winding: c.charged,
        engaged: f.engaged,
      });
    });
  }

  /* ── 효과 적용: 엔진이 낸 것을 여기서만 영속화한다 ────────────────── */

  function applyEffects(effects: readonly Effect[], c: Combat): void {
    for (const e of effects) {
      switch (e.type) {
        case "enemyDamage":
          c.hp = Math.max(0, c.hp - e.amount);
          break;
        case "playerDamage":
        case "playerHeal": {
          const s = sessionOf(e.playerId);
          if (!s) break;
          const delta = e.type === "playerHeal" ? e.amount : -e.amount;
          const next = Math.max(0, Math.min(s.maxHp, s.hp + delta));
          // DB 커밋이 먼저, 메모리 갱신이 나중 — 이동 경로와 같은 규칙.
          try {
            q.setPlayerHp.run(next, clock(), s.playerId);
          } catch (err) {
            console.error("[combat] setPlayerHp", err);
            break;
          }
          s.hp = next;
          emit.send(s, { t: "self.patch", hp: next });
          break;
        }
        case "guard": {
          const f = c.fighters.get(e.playerId);
          if (f) f.guardPercent = e.percent;
          break;
        }
        case "flag":
          // 적의 사망 -> 3단계의 이벤트 파이프라인이 통째로 돈다.
          events.setFlag(e.key, e.value);
          break;
      }
    }
  }

  /* ── 명령 ─────────────────────────────────────────────────────────── */

  function attack(s: Session): string | null {
    const roomId = roomIdOf(s.pos);
    if (s.hp <= 0) return lines.defeated;
    const def = enemyIn(roomId);
    if (!def) return lines.noEnemy;

    const existing = inCombat.get(s.playerId);
    if (existing && existing !== roomId) leave(s.playerId, "left");

    let c = combats.get(roomId);
    if (!c) {
      c = {
        roomId,
        def,
        hp: def.maxHp,
        nextActAt: now() + def.swingMs,
        swingsSinceWindup: 0,
        charged: false,
        fighters: new Map(),
        threat: new Map(),
        targetId: null,
        rng: makeRng(seedFor(roomId)),
        seq: 0,
      };
      combats.set(roomId, c);
    }

    const already = c.fighters.get(s.playerId);
    if (already) {
      if (already.engaged) return lines.alreadyEngaged;
      already.engaged = true; // stop 했다가 다시 붙는 경우
      already.nextActAt = now() + already.swingMs;
      pushUpdate(c);
      return null;
    }

    const f: Fighter = {
      playerId: s.playerId,
      engaged: true,
      nextActAt: now() + balance.player.swingMs,
      swingMs: balance.player.swingMs,
      queued: null,
      guardPercent: 0,
      joinedSeq: c.seq++,
    };
    c.fighters.set(s.playerId, f);
    c.threat.set(s.playerId, 0);
    inCombat.set(s.playerId, roomId);

    emit.send(s, { t: "combat.start", combat: viewFor(s.playerId)! });
    emit.log(s, "bad", lines.engage(def.name));
    /* 구경꾼에게 '누가 붙었다' 를 알린다 — 합류할 계기는 이 한 줄뿐이다.
       먼저 붙은 사람이 있으면 그 사람이 시작한 것이 아니므로 보내지 않는다. */
    if (c.fighters.size === 1) {
      toBystanders(c, (o) => emit.log(o, "bad", lines.engagedBy(nameOf(s.playerId), def.name)));
    }
    // 같은 방의 다른 전투원에게도 알린다 (구조화 + 문장)
    pushUpdate(c);
    ensureTimer();
    return null;
  }

  function skill(s: Session, skillId: string, targetId?: PlayerId): string | null {
    const def = balance.skills[skillId];
    if (!def) return lines.unknownSkill;
    const roomId = inCombat.get(s.playerId);
    const c = roomId ? combats.get(roomId) : undefined;
    const f = c?.fighters.get(s.playerId);
    if (!c || !f) return lines.notInCombat;
    if (s.hp <= 0) return lines.defeated;

    /* ★ 대상은 서버가 다시 본다. 클라이언트가 보낸 id 는 신뢰하지 않는다 —
       같은 전투에 있어야 하고, 그 스킬이 남에게 걸 수 있어야 한다.
       자기 자신을 가리켰으면 대상이 없는 것과 같다. */
    let aim: PlayerId | undefined;
    if (targetId && targetId !== s.playerId) {
      if (def.target !== "ally") return lines.skillSelfOnly(def.name);
      if (!c.fighters.has(targetId)) return lines.skillNoAlly;
      aim = targetId;
    }

    const t = now();
    const ready = cooldownsOf(s.playerId).get(skillId) ?? 0;
    if (ready > t) return lines.skillCooling(def.name, Math.ceil((ready - t) / 1000));

    // 나중 입력이 이긴다 — 큐는 하나뿐이다.
    f.queued = { kind: "skill", id: skillId, ...(aim ? { targetId: aim } : {}) };
    // 교전을 껐더라도 스킬을 쓰면 다시 붙는다 (스킬만 쓰고 싶을 이유가 없다).
    if (!f.engaged) {
      f.engaged = true;
      f.nextActAt = t + f.swingMs;
    }
    emit.log(s, "sys", aim ? lines.skillQueuedAt(def.name, nameOf(aim)) : lines.skillQueued(def.name));
    pushUpdate(c);
    return null;
  }

  /** 아이템을 쓴다. 전투 중이고 교전 중이면 '다음 스윙에', 아니면 즉시.
   *
   *  ★ 예약 '전에' 쓸 수 있는지 먼저 본다. 그러지 않으면 없는 물약을 예약해
   *    두고 0.5초 뒤에야 "가지고 있지 않다" 를 듣는다 — 실시간에서 그건
   *    거짓말에 가깝다. 물론 그 사이에 사정이 바뀌면 발동 시점에 다시
   *    거절되고, 그때는 inventory 가 문장을 낸다. */
  function useItem(s: Session, itemId: string): string | null {
    const refusal = inventory.check(s, itemId);
    if (refusal) return refusal;

    const roomId = inCombat.get(s.playerId);
    const c = roomId ? combats.get(roomId) : undefined;
    const f = c?.fighters.get(s.playerId);
    // 교전 중이 아니면 기다릴 '다음 호흡' 이 없다. 물러나 있는 사람도 마찬가지다.
    if (!c || !f || !f.engaged) return inventory.use(s, itemId);
    if (s.hp <= 0) return lines.defeated;

    f.queued = { kind: "item", id: itemId };
    emit.log(s, "sys", lines.itemQueued(balance.items[itemId]?.name ?? itemId));
    pushUpdate(c);
    return null;
  }

  function stop(s: Session): string | null {
    const roomId = inCombat.get(s.playerId);
    const c = roomId ? combats.get(roomId) : undefined;
    const f = c?.fighters.get(s.playerId);
    if (!c || !f) return lines.notInCombat;
    f.engaged = false;
    f.queued = null;
    emit.log(s, "sys", lines.disengage(c.def.name));
    pushUpdate(c);
    return null;
  }

  /** 전투에서 빠진다. 이동·접속종료·사망이 부른다. */
  function leave(playerId: PlayerId, reason: "left" | "gone" | "defeat"): void {
    const roomId = inCombat.get(playerId);
    if (!roomId) return;
    inCombat.delete(playerId);
    const c = combats.get(roomId);
    if (!c) return;
    c.fighters.delete(playerId);
    c.threat.delete(playerId);
    /* 다 식은 쿨다운은 버린다. 아직 안 식은 것은 남아야 한다 — 그게 이 맵이
       Fighter 밖에 사는 이유다. 그래서 맵은 '지금 쿨다운 중인 사람' 만큼만 
       자란다. */
    const cd = cooldowns.get(playerId);
    if (cd) {
      const t = now();
      for (const [id, at] of cd) if (at <= t) cd.delete(id);
      if (cd.size === 0) cooldowns.delete(playerId);
    }
    const s = sessionOf(playerId);
    if (s) emit.send(s, { t: "combat.end", reason: reason === "defeat" ? "defeat" : reason });
    if (c.fighters.size === 0) {
      combats.delete(roomId);
      maybeStopTimer();
      return;
    }
    /* 대상이 빠졌으면 다시 고른다 — 그리고 '반드시 알린다'.
       조용히 바꾸면 남은 사람은 아무 예고 없이 맞기 시작하고, 어그로 모델에서
       그건 화면에서 이유가 사라지는 것과 같다. */
    if (c.targetId === playerId && retarget(c) && c.targetId) announceThreat(c);
    pushUpdate(c);
  }

  function retarget(c: Combat): boolean {
    const candidates = [...c.fighters.values()]
      .sort((a, b) => a.joinedSeq - b.joinedSeq)
      .map((f) => f.playerId);
    const next = pickTarget(candidates, c.threat);
    if (next === c.targetId) return false;
    c.targetId = next;
    return true;
  }

  function endCombat(c: Combat, reason: "victory" | "gone"): void {
    for (const f of c.fighters.values()) {
      inCombat.delete(f.playerId);
      const s = sessionOf(f.playerId);
      if (s) emit.send(s, { t: "combat.end", reason });
    }
    combats.delete(c.roomId);
    maybeStopTimer();
  }

  /* ── 틱 ───────────────────────────────────────────────────────────── */

  function tick(): void {
    const t = now();
    // 돌아올 때가 된 적부터. 전투가 하나도 없어도 이 루프는 돌아야 하므로
    // maybeStopTimer 가 downed 를 함께 본다.
    for (const [roomId, readyAt] of [...downed]) {
      if (readyAt <= t) respawnEnemy(roomId);
    }
    for (const c of [...combats.values()]) {
      if (c.hp <= 0) continue;

      // 플레이어 스윙 — nextActAt 이 이른 순, 동점이면 교전 순.
      const due = [...c.fighters.values()]
        .filter((f) => f.engaged && f.nextActAt <= t)
        .sort((a, b) => a.nextActAt - b.nextActAt || a.joinedSeq - b.joinedSeq);

      for (const f of due) {
        const s = sessionOf(f.playerId);
        if (!s || s.hp <= 0) continue;
        f.nextActAt = t + f.swingMs;

        const queued = f.queued;
        f.queued = null;
        if (queued?.kind === "item") {
          /* 아이템은 기본 공격을 '대신' 한다 — 스킬과 같은 규칙이다.
             위협(어그로)도 올리지 않는다: 회복 스킬이 그러지 않는 것과 같다. */
          inventory.use(s, queued.id);
          pushUpdate(c);
          continue;
        }
        const skillId = queued?.kind === "skill" ? queued.id : null;
        /* 대상이 예약된 뒤 방을 떠났을 수 있다 — 그 사이에 빠졌으면 자기에게
           건다. 여기서 다시 보는 이유가 그것이다 (예약과 발동 사이에 0.5초가
           있고, 그 사이에 세계가 바뀐다). */
        const aimId = queued?.kind === "skill" ? queued.targetId : undefined;
        const aimSession = aimId && c.fighters.has(aimId) ? sessionOf(aimId) : undefined;
        const res = resolvePlayerSwing(
          f.playerId,
          c.def,
          c.hp,
          s.hp,
          s.maxHp,
          skillId,
          c.rng,
          balance,
          aimSession ? { playerId: aimSession.playerId, hp: aimSession.hp, maxHp: aimSession.maxHp } : undefined,
        );
        if (skillId && res.skill) cooldownsOf(f.playerId).set(skillId, t + res.skill.cooldownMs);

        applyEffects(res.effects, c);
        if (res.skill?.kind !== "heal" && res.skill?.kind !== "guard") {
          c.threat.set(f.playerId, (c.threat.get(f.playerId) ?? 0) + res.amount);
        }
        narrateSwing(c, f, res, skillId);

        if (res.lethal) {
          victory(c, f.playerId);
          break;
        }
      }

      if (c.hp <= 0) continue;

      // 적 스윙
      if (c.nextActAt <= t) {
        c.nextActAt = t + c.def.swingMs;
        const changed = retarget(c);
        if (changed && c.targetId) announceThreat(c);
        const target = c.targetId;
        const ts = target ? sessionOf(target) : undefined;
        if (ts && ts.hp > 0) {
          const f = c.fighters.get(target!)!;
          /* ★ 예고는 한 박자를 통째로 쓴다 — 그 스윙에는 피해가 없다.
             '예고와 동시에 때린다' 로 두면 반응할 시간이 0 이고, 예고는
             일격 뒤에 붙는 설명문이 된다. 한 박자를 내주는 대신 배수로
             돌려받는다 (windup.mult). */
          if (!c.charged && windsUp(c.def, c.swingsSinceWindup)) {
            c.charged = true;
            c.swingsSinceWindup = 0;
            narrateWindup(c);
          } else {
            const heavy = c.charged;
            const res = resolveEnemySwing(c.def, target!, ts.hp, f.guardPercent, c.rng, heavy);
            c.charged = false;
            if (!heavy) c.swingsSinceWindup++;
            f.guardPercent = 0; // 한 번 쓰면 사라진다
            applyEffects(res.effects, c);
            narrateEnemySwing(c, res.targetId, res.amount, res.guarded, res.heavy);
            if (res.lethal) defeat(c, res.targetId);
          }
        }
      }

      pushUpdate(c);
    }
    maybeStopTimer();
  }

  /* ── 서술 ─────────────────────────────────────────────────────────── */

  function narrateSwing(
    c: Combat,
    f: Fighter,
    res: ReturnType<typeof resolvePlayerSwing>,
    skillId: string | null,
  ): void {
    const me = sessionOf(f.playerId);
    const myName = nameOf(f.playerId);
    for (const [, other] of c.fighters) {
      const s = sessionOf(other.playerId);
      if (!s) continue;
      const mine = other.playerId === f.playerId;
      if (res.skill) {
        /* ★ 남에게 건 치유·방어는 받는 사람이 반드시 들어야 한다. 자기 체력이
           왜 올랐는지, 왜 다음 일격을 덜 맞는지 모르면 그건 화면에서 이유가
           사라지는 것이다 (어그로가 옮겨간 순간을 알리는 것과 같은 이유).
           그 밖의 사람에게는 여전히 안 보낸다 — 로그를 채울 가치가 없다. */
        const toMe = res.toPlayerId === other.playerId;
        if (!mine) {
          if (res.skill.kind === "strike") {
            emit.log(s, "good", lines.allyHit(myName, c.def.name, res.amount));
          } else if (toMe && res.skill.kind === "heal") {
            // 0 회복은 받는 쪽에게 아무 일도 아니다 — 거는 쪽만 "이미 아물어
            // 있다" 를 듣는다. 여기서 알리면 "체력이 0 회복되었다" 가 된다.
            if (res.amount > 0) emit.log(s, "good", lines.skillHealedBy(res.skill.name, myName, res.amount));
          } else if (toMe && res.skill.kind === "guard") {
            emit.log(s, "good", lines.skillGuardedBy(res.skill.name, myName, res.amount));
          }
          continue;
        }
        const aimName = res.toPlayerId ? nameOf(res.toPlayerId) : null;
        if (res.skill.kind === "heal") {
          emit.log(s, "good", aimName
            ? lines.skillHealOther(res.skill.name, aimName, res.amount)
            : lines.skillHeal(res.skill.name, res.amount));
        } else if (res.skill.kind === "guard") {
          emit.log(s, "good", aimName
            ? lines.skillGuardOther(res.skill.name, aimName, res.amount)
            : lines.skillGuard(res.skill.name, res.amount));
        } else {
          emit.log(s, "good", lines.skillStrike(res.skill.name, c.def.name, res.amount));
        }
        continue;
      }
      // 평범한 타격 — 연속되면 클라이언트가 접는다. 치명타는 good 이라 접히지 않는다.
      if (mine) {
        if (res.crit) emit.log(s, "good", lines.crit(c.def.name, res.amount));
        else emit.log(s, "combat", lines.hit(c.def.name, res.amount));
      } else {
        emit.log(s, "combat", lines.allyHit(myName, c.def.name, res.amount));
      }
    }
    void me;
    void skillId;
  }

  function narrateEnemySwing(
    c: Combat,
    targetId: PlayerId,
    dmg: number,
    guarded: boolean,
    heavy: boolean,
  ): void {
    const who = nameOf(targetId);
    toCombat(c, (s) => {
      /* 큰 일격은 kind:"bad" 다 — 접히면 안 된다. 예고를 보고 막았는지
         아닌지가 이 한 줄에 있고, 그것이 접힌 덩어리에 섞이면 예고를 넣은
         이유가 화면에서 사라진다. */
      if (s.playerId === targetId) {
        emit.log(
          s,
          heavy ? (guarded ? "good" : "bad") : guarded ? "good" : "combat",
          heavy ? lines.enemyHeavy(c.def.name, dmg, guarded) : lines.enemyHit(c.def.name, dmg, guarded),
        );
      } else {
        emit.log(
          s,
          heavy ? "bad" : "combat",
          heavy
            ? lines.enemyHeavyOther(c.def.name, who, dmg)
            : lines.enemyHitOther(c.def.name, who, dmg),
        );
      }
    });
  }

  /** 몸을 젖혔다. 이 한 줄이 '언제' 라는 축의 전부다 — 구조화 사실은
   *  combat.update{winding} 이 따로 나른다 (문장과 상태는 언제나 분리한다). */
  function narrateWindup(c: Combat): void {
    toCombat(c, (s) => emit.log(s, "bad", lines.enemyWindup(c.def.name)));
  }

  function announceThreat(c: Combat): void {
    const who = nameOf(c.targetId!);
    toCombat(c, (s) => {
      emit.log(
        s,
        "bad",
        s.playerId === c.targetId ? lines.threatShiftSelf(c.def.name) : lines.threatShift(c.def.name, who),
      );
    });
  }

  /* ── 결말 ─────────────────────────────────────────────────────────── */

  function victory(c: Combat, killerId: PlayerId): void {
    const killer = nameOf(killerId);
    toCombat(c, (s) => {
      emit.send(s, { t: "combat.update", enemyHp: 0 });
      emit.log(
        s,
        "good",
        s.playerId === killerId ? lines.slain(c.def.name) : lines.slainByOther(killer, c.def.name),
      );
    });
    /* 끝난 것도 구경꾼에게 간다. 안 그러면 그 방의 hasEnemy 가 조용히 꺼지고,
       서 있던 사람은 '싸우기' 가 사라진 이유를 모른다. */
    toBystanders(c, (o) => emit.log(o, "good", lines.slainByOther(killer, c.def.name)));
    /* 보스라면 applyEffects 가 이미 flag 를 켰다 (3단계 파이프라인이 돌고 있다).
       반복되는 적이라면 여기서 돌아올 시각을 적는다 — endCombat '전에' 적어야
       maybeStopTimer 가 틱을 끄지 않는다. */
    /* 전리품. 피해를 준 사람 '전원' 이 각자 판정을 받는다 — 막타 경쟁도,
       같이 잡으면 손해도 없다. 순서를 교전 순으로 고정한다: rng 를 쓰므로
       순서가 곧 결과이고, 같은 전투는 같은 전리품을 내야 한다. */
    const contributions = [...c.threat.entries()]
      .filter(([, dmg]) => dmg > 0)
      .sort(
        (a, b) =>
          (c.fighters.get(a[0])?.joinedSeq ?? 0) - (c.fighters.get(b[0])?.joinedSeq ?? 0),
      )
      .map(([playerId, damage]) => ({ playerId, damage }));
    /* ★ 몫을 받는 사람을 '한 번' 고르고 둘 다에 넘긴다. 두 곳에서 따로 거르면
       언젠가 한쪽만 고쳐져 "전리품은 나오는데 임무는 안 오른다" 가 된다.
       문턱은 기여가 없는 사람만 거른다 — 함께 잡은 사람들끼리는 여전히 동등하다. */
    const paid = sharers(c.def, contributions, balance.player.minLootShare);
    inventory.award(rollDrops(c.def, paid, c.rng));
    missions.onSlain(c.def.id, paid.map((x) => x.playerId));

    if (c.def.respawnMs !== null) downed.set(c.roomId, now() + c.def.respawnMs);
    endCombat(c, "victory");
    /* 적이 사라진 것도 방의 구조화 상태 변화다 — 돌아온 것과 대칭이다.
       이걸 빼면 서 있는 사람의 커맨드 창에 '싸우기' 가 남아 있다가, 누르면
       "여기에는 맞설 것이 없다" 는 답을 듣는다. 여기서도 묘사는 보내지 않는다. */
    emit.toRoom(c.roomId, null, (s) => onRoomChanged?.(s));
    // 죽음도 지도의 변화다 — 돌아온 것과 대칭이다 (respawnEnemy 참조).
    onFoesChanged?.(c.roomId);
  }

  function defeat(c: Combat, playerId: PlayerId): void {
    const s = sessionOf(playerId);
    const who = nameOf(playerId);
    toCombat(c, (o) => {
      if (o.playerId === playerId) emit.log(o, "bad", lines.defeated);
      else emit.log(o, "bad", lines.defeatedOther(who));
    });
    toBystanders(c, (o) => emit.log(o, "bad", lines.defeatedOther(who)));
    leave(playerId, "defeat");
    if (!s) return;
    /* 부활: 스폰으로 이송하고 절반의 체력으로 일으킨다.
     * 스키마 변경이 없다 — hp 도 좌표도 이미 칼럼이다.
     *
     * ★ 에폭은 '값' 으로 붙잡는다. cur.connId !== s.connId 로 쓰면 유예 중인
     *   세션을 입양한 경우 cur 과 s 가 '같은 객체' 라서 비교가 언제나 거짓이고,
     *   가드가 통째로 죽는다. 그러면 재개 경로가 이미 일으켜 세운 사람을
     *   이 타이머가 한 번 더 부활시킨다 (문장이 두 번 나간다).
     *   저장소의 다른 지연 연속들(net/handlers.ts 의 Phase B, world/dialogue.ts)이
     *   전부 쓰는 관용구가 바로 이 '값으로 붙잡기' 다. */
    const epoch = s.connId;
    setTimeout(() => {
      const cur = reg.get(playerId);
      if (!cur || cur.connId !== epoch) return;
      const hp = Math.max(1, Math.floor(cur.maxHp / 2));
      const seen = new Set(cur.seen).add(roomIdOf(map.spawn));
      try {
        q.commitMoveSeen.run({
          region: map.spawn.region,
          x: map.spawn.x,
          y: map.spawn.y,
          seen: JSON.stringify([...seen]),
          now: clock(),
          id: playerId,
        });
        q.setPlayerHp.run(hp, clock(), playerId);
      } catch (err) {
        console.error("[combat] respawn", err);
        return;
      }
      reg.reposition(cur, { ...map.spawn });
      cur.seen = seen;
      cur.hp = hp;
      emit.send(cur, { t: "self.patch", hp, seen: [...seen] });
      emit.log(cur, "sys", lines.respawn);
      onRespawn?.(cur);
    }, respawnMs).unref?.();
  }

  /** 부활 후 방 묘사를 다시 보내기 위해 index.ts 가 꽂는다 (순환 회피). */
  let onRespawn: ((s: Session) => void) | null = null;
  /** 방의 '구조화 상태' 만 다시 보낸다 (room.describe). onRespawn 과 달리
   *  방 묘사(log{narr})는 보내지 않는다 — 서 있는 화면을 갈아치우지 않는다. */
  let onRoomChanged: ((s: Session) => void) | null = null;
  /** 그 방의 적이 죽거나 돌아왔다. 방이 아니라 **지역** 에 알려야 하는 변화라
   *  세션이 아니라 roomId 를 준다 — 누구에게 보낼지는 index.ts 가 정한다. */
  let onFoesChanged: ((roomId: RoomId) => void) | null = null;

  /* ── 타이머 ───────────────────────────────────────────────────────── */

  function ensureTimer(): void {
    if (timer || opts.manualTick) return;
    timer = setInterval(tick, tickMs);
    timer.unref?.();
  }
  function maybeStopTimer(): void {
    if (timer && combats.size === 0 && downed.size === 0) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    attack,
    skill,
    stop,
    useItem,
    leave: (playerId, reason) => leave(playerId, reason),
    viewFor,
    enemyIn,
    stop_() {
      if (timer) clearInterval(timer);
      timer = null;
      combats.clear();
      inCombat.clear();
      downed.clear();
    },
    activeCount: () => combats.size,
    // 테스트가 틱을 손으로 돌린다.
    ...(opts.manualTick ? { tick } : {}),
    setOnFoesChanged(fn: (roomId: RoomId) => void) {
      onFoesChanged = fn;
    },
    setOnRespawn(fn: (s: Session) => void) {
      onRespawn = fn;
    },
    setOnRoomChanged(fn: (s: Session) => void) {
      onRoomChanged = fn;
    },
  } as CombatService & {
    tick?: () => void;
    setOnRespawn(fn: (s: Session) => void): void;
    setOnRoomChanged(fn: (s: Session) => void): void;
  };
}
