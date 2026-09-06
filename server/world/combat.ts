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
import type { CombatView, EnemyView, SkillView } from "../../shared/protocol";
import type { Balance, EnemyDef } from "../engine/enemies";
import {
  pickTarget,
  resolveEnemySwing,
  resolvePlayerSwing,
  rollDrops,
  type Effect,
} from "../engine/combat";
import { makeRng, type Rng } from "../engine/rng";
import { ENEMY_AT, SPAWN } from "../engine/map";
import type { Queries } from "../db/queries";
import { lines } from "../narration/lines";
import type { Emit } from "../net/emit";
import type { Registry, Session } from "../net/session";
import type { EventService } from "./events";
import type { InventoryService } from "./inventory";

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
  queued: { kind: "skill" | "item"; id: string } | null;
  /** skillId -> 쿨다운이 끝나는 시각 (단조 ms). */
  cooldowns: Map<string, number>;
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
  rng: Rng;
  seq: number;
}

export interface CombatService {
  /** 이 방의 적과 교전을 시작한다(멱등). 실패하면 이유 문장을 돌려준다. */
  attack(s: Session): string | null;
  skill(s: Session, skillId: string): string | null;
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
    const coord = roomId.slice(roomId.indexOf(":") + 1);
    // 배치(맵)와 정의(밸런스)가 두 단계로 갈라져 있다. 짝은 부팅에서 검증된다.
    const id = ENEMY_AT[coord];
    const def = id ? balance.enemies[id] : undefined;
    if (!def) return null;
    // 이미 죽은 적은 없는 것과 같다. 죽음의 '소유자' 가 둘로 나뉜다:
    //   보스        — 월드 플래그 (영속. 세계가 바뀐 사건이다)
    //   반복되는 적 — 리스폰 대기 (메모리. 돌아올 때까지만 없다)
    if (def.slainFlag !== null && events.isFlagOn(def.slainFlag)) return null;
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
      readyInMs: Math.max(0, (f.cooldowns.get(sk.id) ?? 0) - t),
    }));
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
    };
  }

  /** 그 방의 전투원들에게. 전투는 방 단위라 room 계열과 수신자가 같다. */
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
      cooldowns: new Map(),
      guardPercent: 0,
      joinedSeq: c.seq++,
    };
    c.fighters.set(s.playerId, f);
    c.threat.set(s.playerId, 0);
    inCombat.set(s.playerId, roomId);

    emit.send(s, { t: "combat.start", combat: viewFor(s.playerId)! });
    emit.log(s, "bad", lines.engage(def.name));
    // 같은 방의 다른 전투원에게도 알린다 (구조화 + 문장)
    pushUpdate(c);
    ensureTimer();
    return null;
  }

  function skill(s: Session, skillId: string): string | null {
    const def = balance.skills[skillId];
    if (!def) return lines.unknownSkill;
    const roomId = inCombat.get(s.playerId);
    const c = roomId ? combats.get(roomId) : undefined;
    const f = c?.fighters.get(s.playerId);
    if (!c || !f) return lines.notInCombat;
    if (s.hp <= 0) return lines.defeated;

    const t = now();
    const ready = f.cooldowns.get(skillId) ?? 0;
    if (ready > t) return lines.skillCooling(def.name, Math.ceil((ready - t) / 1000));

    // 나중 입력이 이긴다 — 큐는 하나뿐이다.
    f.queued = { kind: "skill", id: skillId };
    // 교전을 껐더라도 스킬을 쓰면 다시 붙는다 (스킬만 쓰고 싶을 이유가 없다).
    if (!f.engaged) {
      f.engaged = true;
      f.nextActAt = t + f.swingMs;
    }
    emit.log(s, "sys", lines.skillQueued(def.name));
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
        const res = resolvePlayerSwing(
          f.playerId,
          c.def,
          c.hp,
          s.hp,
          s.maxHp,
          skillId,
          c.rng,
          balance,
        );
        if (skillId && res.skill) f.cooldowns.set(skillId, t + res.skill.cooldownMs);

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
          const res = resolveEnemySwing(c.def, target!, ts.hp, f.guardPercent, c.rng);
          f.guardPercent = 0; // 한 번 쓰면 사라진다
          applyEffects(res.effects, c);
          narrateEnemySwing(c, res.targetId, res.amount, res.guarded);
          if (res.lethal) defeat(c, res.targetId);
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
        if (!mine) {
          if (res.skill.kind === "strike") {
            emit.log(s, "good", lines.allyHit(myName, c.def.name, res.amount));
          }
          continue; // 남의 힐/방어는 로그를 채울 가치가 없다
        }
        if (res.skill.kind === "heal") emit.log(s, "good", lines.skillHeal(res.skill.name, res.amount));
        else if (res.skill.kind === "guard")
          emit.log(s, "good", lines.skillGuard(res.skill.name, res.amount));
        else emit.log(s, "good", lines.skillStrike(res.skill.name, c.def.name, res.amount));
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

  function narrateEnemySwing(c: Combat, targetId: PlayerId, dmg: number, guarded: boolean): void {
    const who = nameOf(targetId);
    toCombat(c, (s) => {
      if (s.playerId === targetId) {
        emit.log(s, guarded ? "good" : "combat", lines.enemyHit(c.def.name, dmg, guarded));
      } else {
        emit.log(s, "combat", lines.enemyHitOther(c.def.name, who, dmg));
      }
    });
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
    inventory.award(rollDrops(c.def, contributions, c.rng));

    if (c.def.respawnMs !== null) downed.set(c.roomId, now() + c.def.respawnMs);
    endCombat(c, "victory");
    /* 적이 사라진 것도 방의 구조화 상태 변화다 — 돌아온 것과 대칭이다.
       이걸 빼면 서 있는 사람의 커맨드 창에 '싸우기' 가 남아 있다가, 누르면
       "여기에는 맞설 것이 없다" 는 답을 듣는다. 여기서도 묘사는 보내지 않는다. */
    emit.toRoom(c.roomId, null, (s) => onRoomChanged?.(s));
  }

  function defeat(c: Combat, playerId: PlayerId): void {
    const s = sessionOf(playerId);
    const who = nameOf(playerId);
    toCombat(c, (o) => {
      if (o.playerId === playerId) emit.log(o, "bad", lines.defeated);
      else emit.log(o, "bad", lines.defeatedOther(who));
    });
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
      const seen = new Set(cur.seen).add(roomIdOf(SPAWN));
      try {
        q.commitMove.run({
          region: SPAWN.region,
          x: SPAWN.x,
          y: SPAWN.y,
          seen: JSON.stringify([...seen]),
          now: clock(),
          id: playerId,
        });
        q.setPlayerHp.run(hp, clock(), playerId);
      } catch (err) {
        console.error("[combat] respawn", err);
        return;
      }
      reg.reposition(cur, { ...SPAWN });
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
