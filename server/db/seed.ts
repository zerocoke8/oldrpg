/* 부팅 시더. 트랜잭션 하나. LLM 도 await 도 없다.
 *
 * engine/map.ts 가 원본이고 rooms 표는 그 투영이다. 코드에 없는 rooms 행은
 * '건드리지 않는다' — DELETE 하지 않으므로 CASCADE 가 생성된 텍스트를 지우는
 * 일이 없고, 도달 불가능한 방은 그냥 도달 불가능할 뿐이다.
 *
 * room_text 는 여기서 건드리지 않는다 (첫 입장 때 lazy 기록). */

import {
  MAX_SENSITIVE,
  declHashOf,
  type GameMap,
  type RegionDef,
} from "../engine/map";
import { DELTA, OPPOSITE, type RegionId } from "../../shared/ids";
import type { Balance } from "../engine/enemies";
import type { Db } from "./open";
import type { Queries } from "./queries";

/** 인증이 없으므로 유령 행이 쌓인다. 부팅 때 한 번 청소한다. */
const STALE_PLAYER_MS = 30 * 24 * 60 * 60 * 1000;

/** 코드가 소유한 세계 데이터의 정합성. 부팅에서 한 번, 트랜잭션 밖에서 본다.
 *
 *  ★ 여기 있는 것들은 전부 '주석이 약속했지만 아무도 검사하지 않던' 것이다.
 *    enemies.ts 는 "맵의 'E' 타일과 짝이 맞아야 한다 (부팅 때 검증한다)" 고
 *    적혀 있었는데 그 검증이 없었고, map.ts 의 allRooms 는 씨앗이 없는 칸을
 *    "특징 없는 돌 통로" 로 조용히 메우고 있었다 — 새 방을 뚫고 씨앗을
 *    빠뜨리면 아무 소리 없이 무명의 방이 하나 생긴다.
 *    부팅에서 죽는 편이 조용히 틀린 세계로 도는 것보다 낫다. */
export function assertWorldData(map: GameMap, balance: Balance): void {
  for (const r of map.regions()) assertRegion(map, r, balance);
  assertDoors(map, balance);
  assertMissions(map, balance);
  assertReachable(map, balance);

  // ⑦ 적이 켜는 플래그는 선언돼 있어야 한다 (파일을 넘나드는 참조라 zod 가 못 본다).
  for (const [id, e] of Object.entries(balance.enemies)) {
    if (e.slainFlag !== null && !map.hasFlag(e.slainFlag)) {
      throw new Error(`enemies.json: ${id} 가 선언되지 않은 플래그 ${e.slainFlag} 를 켠다.`);
    }
  }

  /* ⑧ NPC 가 실재하는 방에 서 있는가, 그리고 그 플래그들이 선언돼 있는가. NPC 는 아직 코드에 있고(engine/npcs.ts)
     방도 데이터에 있지만 좌표가 벽일 수 있다. 아무도 안 보면 부팅이
     'FOREIGN KEY constraint failed' 라는 말로 죽는다 — 어느 NPC 가 어느 방을
     못 찾았는지는 그 메시지 어디에도 없다. 주제를 여는 플래그도 여기서 본다
     (플래그 레지스트리는 코드에, NPC 는 데이터에 있어 파일을 넘나든다). */
  const roomIds = new Set(map.rooms().map((r) => r.id));
  for (const n of map.npcs()) {
    if (!roomIds.has(n.roomId)) {
      throw new Error(`NPC ${n.id} 가 ${n.region} 의 걷는 칸이 아닌 ${n.at} 에 서 있다.`);
    }
    for (const t of n.topics) {
      if (t.requires !== null && !map.hasFlag(t.requires)) {
        throw new Error(`NPC ${n.id} 의 주제 ${t.id} 가 선언되지 않은 플래그 ${t.requires} 로 열린다.`);
      }
    }
    for (const f of n.sensitiveFlags) {
      if (!map.hasFlag(f)) {
        throw new Error(`NPC ${n.id} 가 선언되지 않은 플래그 ${f} 를 sensitive 에 적었다.`);
      }
    }
  }

  // ⑨ 스폰은 걸을 수 있는 칸이어야 한다. 아니면 모든 신규 플레이어가 벽 안에서 시작한다.
  if (!map.walkableAt(map.spawn)) {
    const s = map.spawn;
    throw new Error(`스폰 ${s.region} ${s.x},${s.y} 이 벽이다 (content/world/world.json).`);
  }
}

function assertRegion(map: GameMap, r: RegionDef, balance: Balance): void {
  // ① 줄 길이가 같은 것은 server/content/world.ts 가 이미 봤다 (그게 어긋나면
  //    x 범위가 y 마다 달라져 아래의 모든 검사가 무엇을 말하는지 알 수 없다).
  const w = r.tiles[0]?.length ?? 0;
  const h = r.tiles.length;

  // ② 걷는 칸에는 전부 씨앗이 있다 (침묵 폴백 금지).
  const seedless: string[] = [];
  const walkables = new Set<string>();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!map.walkable(r.id, x, y)) continue;
      walkables.add(`${x},${y}`);
      if (!r.seeds[`${x},${y}`]) seedless.push(`${x},${y}`);
    }
  }
  if (seedless.length) {
    throw new Error(
      `지역 ${r.id}: 씨앗이 없는 칸 ${seedless.join(" ")} — seeds 에 추가하거나 벽으로 막을 것. ` +
        `묘사는 (씨앗 + 플래그)의 함수이므로 씨앗 없는 방은 존재할 수 없다.`,
    );
  }
  // 반대 방향도 본다. 벽 자리에 씨앗을 써두면 영영 읽히지 않는다 — 오타의 흔한 모양이다.
  for (const k of Object.keys(r.seeds)) {
    if (!walkables.has(k)) throw new Error(`지역 ${r.id}: 벽인 칸 ${k} 에 씨앗이 있다.`);
  }
  for (const k of Object.keys(r.sensitive)) {
    if (!walkables.has(k)) throw new Error(`지역 ${r.id}: 벽인 칸 ${k} 이 플래그를 선언했다.`);
  }

  // ③ 선언된 플래그가 실제로 존재하는가. 오타 하나가 '영영 안 바뀌는 방' 이 된다.
  for (const [k, decl] of Object.entries(r.sensitive)) {
    for (const f of decl) {
      if (!map.hasFlag(f)) {
        throw new Error(`지역 ${r.id} ${k}: 선언되지 않은 플래그 ${f} 를 sensitive 에 적었다.`);
      }
    }
  }

  // ④ 'E' 타일과 적 '배치' 는 양방향으로 짝이 맞는다.
  const eTiles = new Set<string>();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) if (map.tileAt(r.id, x, y) === "E") eTiles.add(`${x},${y}`);
  }
  for (const k of eTiles) {
    if (!r.enemies[k]) throw new Error(`지역 ${r.id}: 'E' 타일 ${k} 에 적이 배치되지 않았다.`);
  }
  for (const [k, id] of Object.entries(r.enemies)) {
    if (!eTiles.has(k)) throw new Error(`지역 ${r.id}: 적 ${id} 가 'E' 가 아닌 칸 ${k} 에 배치됐다.`);
    // ⑤ 배치된 적이 실제로 정의돼 있는가. '어디에' 와 '무엇인가' 가 갈라져 있으므로
    //    이 참조는 파일을 넘나든다 — zod 가 못 보고 여기서만 잡힌다.
    if (!(id in balance.enemies)) {
      throw new Error(`지역 ${r.id} ${k} 에 배치된 ${id} 가 content/balance/enemies.json 에 없다.`);
    }
  }
}

/** ⑥ 지역 간 문. 오타 하나가 '들어갔다 못 나오는 지역' 이나 '아무 데도 없는 지역'
 *  을 만든다 — 어느 쪽이든 플레이어가 갇히고 나서야 알게 된다. */
function assertDoors(map: GameMap, balance: Balance): void {
  for (const r of map.regions()) {
    for (const e of r.exits) {
      const where = `지역 ${r.id} 의 출구 ${e.at} ${e.dir}`;
      const [ax, ay] = e.at.split(",").map(Number);
      if (ax === undefined || ay === undefined || Number.isNaN(ax) || Number.isNaN(ay)) {
        throw new Error(`${where}: at 이 "x,y" 형식이 아니다.`);
      }
      // 출발 칸은 걸을 수 있어야 한다 — 아무도 설 수 없는 칸의 문은 존재하지 않는 문이다.
      if (!map.walkable(r.id, ax, ay)) throw new Error(`${where}: 출발 칸이 벽이다.`);
      // 그 방향은 벽이어야 한다. 걸어갈 수 있는 칸을 가리키면 같은 키 입력에
      // 두 가지 뜻이 생긴다 (한 칸 이동인가 지역 이동인가).
      const d = DELTA[e.dir];
      if (map.walkable(r.id, ax + d.dx, ay + d.dy)) {
        throw new Error(`${where}: 그 방향이 벽이 아니다 — 한 칸 이동과 뜻이 겹친다.`);
      }
      const dst = map.region(e.to.region);
      if (!dst) throw new Error(`${where}: 목적지 지역 ${e.to.region} 이 없다.`);
      if (!map.walkableAt(e.to)) {
        throw new Error(`${where}: 목적지 ${e.to.region} ${e.to.x},${e.to.y} 이 벽이다.`);
      }
      if (e.requires !== null && !map.hasFlag(e.requires)) {
        throw new Error(`${where}: 선언되지 않은 플래그 ${e.requires} 를 requires 로 쓴다.`);
      }
      /* 사다리에 없는 등급을 요구하면 그 문은 영원히 안 열린다. 파일을 넘나드는
         참조라 zod 가 못 보고, 증상이 '아무 일도 안 일어남' 이라 눈으로도 못 잡는다. */
      const top = balance.ranks[balance.ranks.length - 1]?.level ?? 0;
      if (e.minRank > top) {
        throw new Error(
          `${where}: ${e.minRank}등급을 요구하는데 ranks.json 의 최고 등급은 ${top} 이다 — 영영 안 열린다.`,
        );
      }
      if (e.oneWay) continue;
      // 왕복이라고 선언했으면 반대편에 짝이 있어야 한다. 없으면 갇힌다.
      const back = dst.exits.find(
        (b) =>
          b.at === `${e.to.x},${e.to.y}` &&
          b.dir === OPPOSITE[e.dir] &&
          b.to.region === r.id &&
          b.to.x === ax &&
          b.to.y === ay,
      );
      if (!back) {
        throw new Error(
          `${where}: 왕복인데 ${e.to.region} ${e.to.x},${e.to.y} 에서 ${OPPOSITE[e.dir]} 로 ` +
            `돌아오는 짝이 없다 — 들어가면 못 나온다.`,
        );
      }
    }
  }
}

/* ⑩ 임무. 임무는 세 파일을 한꺼번에 가리킨다 — 게시하는 NPC(지역 파일),
   목표가 되는 적과 보수 아이템(밸런스), 게시 조건 플래그(world.json).
   그래서 어느 한 파일의 zod 도 이걸 볼 수 없다.

   ★ 증상이 전부 '조용함' 이라 눈으로 못 잡는다: 없는 적을 목표로 두면 영영
     0/1 이고, 없는 NPC 가 게시하면 아무 데서도 안 보이고, 길드가 아닌 사람이
     게시하면 말은 걸리는데 목록이 비어 있다. */
function assertMissions(map: GameMap, balance: Balance): void {
  const enemyPlaced = new Set(map.regions().flatMap((r) => Object.values(r.enemies)));
  for (const m of map.missions()) {
    const where = `missions.json 의 ${m.id}`;
    const npc = map.npc(m.npcId);
    if (!npc) throw new Error(`${where}: 게시하는 NPC ${m.npcId} 가 없다.`);
    /* 게시는 길드 업무다. 아니면 그 사람에게 말을 걸어도 목록이 비어 있고,
       왜 안 보이는지가 어디에도 안 적힌다. */
    if (!npc.guild) throw new Error(`${where}: ${m.npcId} 는 길드 업무를 보지 않는다.`);
    if (m.requires !== null && !map.hasFlag(m.requires)) {
      throw new Error(`${where}: 선언되지 않은 플래그 ${m.requires} 로 게시된다.`);
    }
    const top = balance.ranks[balance.ranks.length - 1]?.level ?? 0;
    if (m.minRank > top) {
      throw new Error(`${where}: ${m.minRank}등급을 요구하는데 최고 등급은 ${top} 이다 — 영영 못 받는다.`);
    }
    if (!(m.goal.enemyId in balance.enemies)) {
      throw new Error(`${where}: 목표 ${m.goal.enemyId} 가 enemies.json 에 없다.`);
    }
    /* 정의만 있고 어디에도 배치되지 않은 적을 목표로 두면 영영 0/1 이다. */
    if (!enemyPlaced.has(m.goal.enemyId)) {
      throw new Error(`${where}: 목표 ${m.goal.enemyId} 가 어느 지역에도 배치돼 있지 않다 — 영영 못 끝낸다.`);
    }
    for (const rw of m.reward) {
      if (!(rw.itemId in balance.items)) {
        throw new Error(`${where}: 보수 ${rw.itemId} 가 items.json 에 없다.`);
      }
    }
  }
}

/* ⑪ "갈 수 있는가". 여기까지의 조항은 전부 '한 조각이 스스로 말이 되는가' 를
   본다 — 문이 벽 자리인가, 짝이 있는가, 가리키는 것이 실재하는가. 그런데
   세계는 조각들의 합이 아니라 **스폰에서 뻗어 나가는 그래프**다.

   조각이 전부 멀쩡해도 세계가 틀릴 수 있다:
     · 출구를 안 적은 지역은 통째로 유령이 된다 (짝 검사는 '있는 문' 만 본다)
     · 손으로 격자를 고치다 통로와 끊긴 방이 생긴다
     · 아무도 켜지 않는 플래그로 잠근 문은 영영 안 열린다

   ★ 셋 다 증상이 '조용함' 이다. 지역이 여섯일 때는 걸어 보면 안다. 스물이면
     안 걸리고, 그동안 pregen 은 못 가는 방의 문장에 돈을 낸다.

   ★ 낙관적으로 걷는다: "지금 열려 있는가" 가 아니라 "언젠가 열릴 수 있는가".
     잠긴 문도 그 플래그를 켤 방법이 세계 안에 있으면 지나간 것으로 친다.
     아니면 진행이 있는 세계는 전부 거절당한다. */
function assertReachable(map: GameMap, balance: Balance): void {
  /* 무엇이 켜질 수 있는가. 지금 플래그를 켜는 것은 '배치된 적의 죽음' 뿐이다.
     엔진이 플래그를 켜는 다른 경로가 생기면 여기에 더한다 — 그때 이 목록이
     "세계를 여는 것들" 의 유일한 명세가 된다. */
  const openable = new Set<string>();
  const defaults = map.flagDefaults();
  for (const key of map.flagKeys()) if (defaults[key] === "true") openable.add(key);
  const placed = new Set(map.regions().flatMap((r) => Object.values(r.enemies)));
  for (const id of placed) {
    const f = balance.enemies[id]?.slainFlag;
    if (f) openable.add(f);
  }
  /* ★ '켤 수 있는가' 와 '누군가 쓰기는 하는가' 는 다른 질문이라 집합이 둘이다.
     배치되지 않은 적은 죽을 수 없으니 그 플래그로 잠긴 문은 영영 안 열린다
     (openable 에 안 들어간다). 그런데 enemies.json 에 '정의' 만 있는 적의
     slainFlag 도 world.json 에 선언은 돼 있어야 한다 (조항 ⑦). 그 선언을
     '찌꺼기' 로 몰면, 적을 먼저 정의하고 배치를 나중에 하는 순서가 막힌다.
     실제로 그렇게 짰다가 test/world.ts 의 두 방짜리 주입 세계가 거절당했다. */
  const named = new Set(openable);
  for (const e of Object.values(balance.enemies)) if (e.slainFlag) named.add(e.slainFlag);
  const topRank = balance.ranks[balance.ranks.length - 1]?.level ?? 0;

  /* ── 지역 그래프 ─────────────────────────────────────────────────── */
  const reached = new Set<RegionId>([map.spawn.region]);
  const queue: RegionId[] = [map.spawn.region];
  while (queue.length) {
    const r = map.region(queue.pop()!);
    if (!r) continue;
    for (const e of r.exits) {
      if (e.requires !== null && !openable.has(e.requires)) continue;
      if (e.minRank > topRank) continue;
      if (reached.has(e.to.region)) continue;
      reached.add(e.to.region);
      queue.push(e.to.region);
    }
  }
  for (const r of map.regions()) {
    if (reached.has(r.id)) continue;
    /* 왜 못 가는지까지 말해 준다. "닿지 않는다" 만으로는 출구를 안 적은
       것인지 잠긴 문 너머인지 알 수 없고, 둘은 고치는 방법이 다르다. */
    const inbound = map
      .regions()
      .flatMap((o) => o.exits.filter((e) => e.to.region === r.id).map((e) => ({ from: o.id, e })));
    /* 문마다 '왜 못 지나가는가' 가 다르다. 잠긴 것과 '그 지역도 못 가는 것' 을
       뭉뚱그리면 고칠 곳을 못 찾는다 — 앞은 플래그를 켤 적을 배치하는 일이고
       뒤는 그 지역부터 이어야 하는 일이다. */
    const why = inbound.length
      ? inbound
          .map(({ from, e }) => {
            const at = `${from} 의 ${e.at}`;
            if (!reached.has(from)) return `${at}: 그 지역에도 닿을 수 없다`;
            if (e.requires !== null && !openable.has(e.requires)) {
              return `${at}: 플래그 ${e.requires} 를 켤 방법이 없다`;
            }
            if (e.minRank > topRank) return `${at}: ${e.minRank}등급을 요구하는데 최고가 ${topRank}이다`;
            return `${at}: ?`;
          })
          .join(" · ")
      : "이 지역으로 들어오는 문이 하나도 없다";
    throw new Error(`지역 ${r.id} 에 스폰에서 닿을 방법이 없다 — ${why}.`);
  }

  /* ── 지역 안의 방 ────────────────────────────────────────────────── */
  for (const r of map.regions()) {
    /* 들어오는 자리들. 다른 지역의 문이 가리키는 칸이고, 스폰 지역이면 스폰도. */
    const entries: string[] = map
      .regions()
      .flatMap((o) => o.exits.filter((e) => e.to.region === r.id).map((e) => `${e.to.x},${e.to.y}`));
    if (r.id === map.spawn.region) entries.push(`${map.spawn.x},${map.spawn.y}`);

    const seen = new Set<string>();
    const stack = entries.filter((k) => {
      const [x, y] = k.split(",").map(Number);
      return map.walkable(r.id, x!, y!);
    });
    for (const k of stack) seen.add(k);
    while (stack.length) {
      const [x, y] = stack.pop()!.split(",").map(Number);
      for (const d of Object.values(DELTA)) {
        const nx = x! + d.dx;
        const ny = y! + d.dy;
        const k = `${nx},${ny}`;
        if (seen.has(k) || !map.walkable(r.id, nx, ny)) continue;
        seen.add(k);
        stack.push(k);
      }
    }
    const stranded = Object.keys(r.seeds).filter((k) => !seen.has(k));
    if (stranded.length) {
      throw new Error(
        `지역 ${r.id}: 들어오는 자리에서 걸어갈 수 없는 칸이 ${stranded.length}개 있다 ` +
          `(${stranded.slice(0, 5).join(" ")}${stranded.length > 5 ? " …" : ""}). ` +
          `아무도 보지 못하는데 생성 비용은 나간다.`,
      );
    }
  }

  /* ── 플래그 ──────────────────────────────────────────────────────── */
  /* 무엇이 플래그를 '읽는가'. 읽는 데가 없으면 켜져도 세계가 반응하지 않고,
     켜질 수 없는데 읽으면 그쪽은 영영 열리지 않는다. */
  const readers = new Map<string, string[]>();
  const note = (flag: string, where: string): void => {
    const xs = readers.get(flag) ?? [];
    xs.push(where);
    readers.set(flag, xs);
  };
  for (const r of map.regions()) {
    for (const e of r.exits) if (e.requires) note(e.requires, `지역 ${r.id} 의 문 ${e.at}`);
    for (const [k, fs] of Object.entries(r.sensitive)) {
      for (const f of fs) note(f, `${r.id} 의 방 ${k}`);
    }
  }
  for (const n of map.npcs()) {
    for (const f of n.sensitiveFlags) note(f, `NPC ${n.id}`);
    for (const t of n.topics) if (t.requires) note(t.requires, `NPC ${n.id} 의 주제 ${t.id}`);
  }
  for (const m of map.missions()) if (m.requires) note(m.requires, `임무 ${m.id}`);

  for (const key of map.flagKeys()) {
    const who = readers.get(key);
    /* ★ '읽지도 켜지도 않는' 것만 거절한다. 켜기만 하는 플래그는 멀쩡하다 —
       세계가 그 사건을 기록하되 아직 아무도 반응하지 않는 상태이고, 그건
       저작 중에 늘 지나가는 단계다. 반대로 어느 쪽도 아니면 오타뿐이다.
       (한때 '읽는 곳이 없으면 거절' 로 짰다가, 적의 slainFlag 만 선언한
        멀쩡한 세계가 부팅을 거절당했다.) */
    if (!who && !named.has(key)) {
      throw new Error(
        `world.json 의 플래그 ${key} 를 읽는 곳도 켜는 곳도 없다 — 오타이거나 남은 찌꺼기다.`,
      );
    }
    if (who && !openable.has(key)) {
      throw new Error(
        `플래그 ${key} 를 켤 방법이 세계 안에 없다 (기본값도 false 이고 켜는 적도 배치되지 않았다). ` +
          `${who.slice(0, 3).join(", ")} 이(가) 영영 열리지 않는다.`,
      );
    }
  }
}

export function seed(db: Db, q: Queries, map: GameMap, balance: Balance, now: number): { seededRooms: number; reaped: number } {
  assertWorldData(map, balance);
  let seededRooms = 0;

  const tx = db.transaction(() => {
    // 플래그 레지스트리는 content_hash 단축경로 '밖'에서 무조건 돈다.
    // 안에 두면 새 플래그를 선언해도 시더가 건너뛰어, 그 플래그가 DB 에
    // 존재하지 않는 채 state_hash 가 계산된다 (전부 "null" 로).
    // INSERT OR IGNORE 이므로 멱등하고 사실상 공짜다.
    for (const [key, value] of Object.entries(map.flagDefaults())) {
      q.insertFlagIfAbsent.run(key, value, now);
    }

    const want = map.contentHash();
    const have = q.getMeta.get("content_hash")?.value;
    if (have !== want) {
      for (const r of map.rooms()) {
        if (r.sensitiveFlags.length > MAX_SENSITIVE) {
          // charter 47-48줄: 방 하나가 2^n 개의 상태를 갖는 것을 부팅에서 막는다.
          throw new Error(
            `${r.id} 이 ${r.sensitiveFlags.length}개의 플래그를 선언했다 (상한 ${MAX_SENSITIVE}). ` +
              `방마다 반응할 플래그를 반드시 좁게 선언한다.`,
          );
        }
        const info = q.upsertRoom.run({
          id: r.id,
          region: r.region,
          x: r.x,
          y: r.y,
          tile: r.tile,
          seed: r.seed,
          seed_id: r.seedId,
          sensitive_flags: JSON.stringify(r.sensitiveFlags),
          flags_decl_hash: r.flagsDeclHash,
          now,
        });
        seededRooms += info.changes;
      }
      // NPC 도 같은 방식으로 투영한다 (저작 주체는 코드, 표는 그림자).
      for (const n of map.npcs()) {
        const decl = [...new Set(n.sensitiveFlags)].sort();
        if (decl.length > MAX_SENSITIVE) {
          throw new Error(
            `NPC ${n.id} 이 ${decl.length}개의 플래그를 선언했다 (상한 ${MAX_SENSITIVE}).`,
          );
        }
        q.upsertNpc.run({
          id: n.id,
          room_id: n.roomId,
          name: n.name,
          persona_seed: n.persona,
          sensitive_flags: JSON.stringify(decl),
          flags_decl_hash: declHashOf(decl),
          now,
        });
      }

      q.setMeta.run("content_hash", want, now);
    }
  });
  tx();

  const reaped = q.reapStalePlayers.run(now - STALE_PLAYER_MS).changes;
  return { seededRooms, reaped };
}

export function loadFlags(q: Queries): Map<string, string> {
  return new Map(q.allFlags.all().map((r) => [r.key, r.value]));
}
