/* 지역 데이터를 읽어 검증한다. engine/ 과 세계 사이의 유일한 문.
 * server/content/balance.ts 와 같은 모양이고, 같은 이유로 여기 있다:
 * engine/ 은 파일을 읽지 않는다.
 *
 * ★ 밸런스와 다른 점이 하나 있다. 수치는 바꿔도 공짜지만 씨앗은 아니다 —
 *   씨앗 한 글자를 고치면 seed_id 가 바뀌어 그 방의 생성된 텍스트가 전부
 *   캐시 미스가 된다. 그래서 이 JSON 은 '고쳐도 되는 파일' 이 아니라
 *   '리뷰를 거쳐 커밋되는 저작물' 이다 (CLAUDE.md 의 "무엇이 코드고 무엇이
 *   데이터인가"). 형식만 JSON 이고 취급은 코드와 같다.
 *
 * ★ 여기서 보는 것은 '한 파일 안에서 판정할 수 있는 것' 까지다.
 *   지역을 넘나드는 정합성(출구의 짝, 배치된 적이 실재하는가, 플래그가
 *   선언돼 있는가)은 db/seed.ts 의 assertWorldData 가 본다 — 그것들은
 *   밸런스와 플래그 레지스트리를 함께 봐야 판정된다. */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { DIRECTIONS } from "../../shared/ids";
import type { MapData, RegionDef } from "../engine/map";

/** 저장소 루트의 content/world/. MUD_WORLD 로 갈아끼울 수 있다 (테스트·실험용). */
const DEFAULT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../content/world");

/** `"x,y"`. 좌표 키의 형식을 여기서 한 번 강제한다 — "3, 5" 나 "3;5" 는
 *  런타임에 '아무 방과도 안 맞는 조용한 항목' 이 된다. */
const coord = z.string().regex(/^\d+,\d+$/, '"x,y" 형식이어야 한다');

const zPos = z
  .object({ region: z.string().min(1), x: z.number().int().min(0), y: z.number().int().min(0) })
  .strict();

const zExit = z
  .object({
    at: coord,
    dir: z.enum(DIRECTIONS),
    to: zPos,
    requires: z.string().min(1).nullable(),
    /** 이 등급 이상이어야 지나간다. 적지 않으면 0 — 아무나. */
    minRank: z.number().int().min(0).default(0),
    oneWay: z.boolean(),
  })
  .strict();

/** 주제 하나. 배열인 이유는 순서가 곧 대화 메뉴의 순서이기 때문이다 —
 *  지역·적과 달리 여기만 키가 아니라 항목 안에 id 가 있다. */
const zTopic = z
  .object({
    id: z.string().min(1).regex(/^[a-z0-9_]+$/, "소문자·숫자·밑줄만"),
    label: z.string().min(1).nullable(),
    seed: z.string().min(1),
    requires: z.string().min(1).nullable(),
  })
  .strict();

const zNpc = z
  .object({
    at: coord,
    name: z.string().min(1),
    persona: z.string().min(1),
    sensitive: z.array(z.string().min(1)),
    /** 길드 등급 접수를 보는 NPC 인가. 적지 않으면 false. */
    guild: z.boolean().default(false),
    topics: z.array(zTopic).min(1),
  })
  .strict();

const zRegion = z
  .object({
    name: z.string().min(1),
    tiles: z.array(z.string().regex(/^[#.STE]+$/, "타일은 # . S T E 만 쓴다")).min(1),
    seeds: z.record(coord, z.string().min(1)),
    sensitive: z.record(coord, z.array(z.string().min(1))),
    enemies: z.record(coord, z.string().min(1)),
    /* 키가 곧 NPC id 다. ':' 를 금지하는 이유는 승급 큐의 키 구분자이기
       때문이다 — 들어가면 큐가 엉뚱한 항목을 같은 것으로 본다. */
    npcs: z.record(z.string().min(1).regex(/^[a-z0-9_]+$/, "소문자·숫자·밑줄만"), zNpc),
    exits: z.array(zExit),
  })
  .strict();

/** 플래그 하나의 선언. broadcast 는 '이 값을 클라이언트에 공개할 것인가' 다 —
 *  플래그마다 스포일러인지 아닌지가 다르고 그건 세계관의 결정이라 데이터다. */
const zFlag = z
  .object({
    /** JSON 스칼라의 정규 표기. world_flags.value 에 이 문자열이 그대로 들어간다. */
    default: z.string().min(1),
    broadcast: z.boolean(),
  })
  .strict();

const zWorld = z
  .object({
    spawn: zPos,
    flags: z.record(z.string().min(1).regex(/^[a-z0-9_]+$/, "소문자·숫자·밑줄만"), zFlag),
  })
  .strict();

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`${path} 를 읽을 수 없다: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function parse<T extends z.ZodTypeAny>(path: string, schema: T, raw: unknown): z.infer<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    // 어디가 왜 틀렸는지를 사람이 읽을 수 있게. 부팅 로그가 유일한 창이다.
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".") || "(루트)"}: ${i.message}`);
    throw new Error(`${path} 가 잘못됐다:\n${lines.join("\n")}`);
  }
  return parsed.data;
}

/* ── 브리프 ────────────────────────────────────────────────────────────
   지역 하나를 만들기 위해 '사람이 쓰는' 입력. 저작 도구만 읽는다 —
   서버는 브리프를 모른다 (읽는 것은 regions/*.json 뿐이다).

   여기 있는 이유: 이것도 content/ 를 읽어 검증하는 일이고, 같은 zod 를
   쓰고 같은 오류 메시지 규약을 쓴다. 도구가 스스로 파싱하면 그 규약이 갈린다. */

const zBrief = z
  .object({
    /** 표시 이름. regions/<id>.json 의 name 이 된다. */
    name: z.string().min(1),
    /** 이 장소가 무엇인가. 사람이 쓰는 유일한 '창작' 이고 나머지는 여기서 파생된다. */
    theme: z.string().min(1),
    /** 반드시 있어야 하는 것들. 개요가 이걸 중심으로 짜인다. */
    landmarks: z.array(z.string().min(1)).default([]),
    /** 목표 방 수. tiles 를 직접 적으면 무시된다. 50방쯤을 권한다. */
    rooms: z.number().int().min(1).max(400).default(40),
    /** 배치 생성기의 시드. 같은 시드는 같은 지도를 낸다 — 지도가 어디서
     *  왔는지가 커밋 안에 남는다. */
    layoutSeed: z.number().int().default(1),
    /** 고리가 생길 확률. 0 이면 막다른 길 투성이의 나무 미로. */
    loopChance: z.number().min(0).max(0.5).default(0.12),
    /** 손으로 그린 격자. 있으면 생성기를 쓰지 않는다. */
    tiles: z.array(z.string()).nullable().default(null),
    /** 도구가 한 번 만들어 적어 둔다. 있으면 다시 만들지 않는다 —
     *  방을 나중에 더 뚫어도 같은 장소로 이어져야 한다. */
    overview: z.string().nullable().default(null),
  })
  .strict();

export type RegionBrief = z.infer<typeof zBrief>;

export function loadBrief(id: string, dir = process.env.MUD_WORLD ?? DEFAULT_DIR): RegionBrief {
  const path = join(dir, "briefs", `${id}.json`);
  return parse(path, zBrief, readJson(path));
}

/** 브리프에 개요를 적어 넣는다. 이미 있으면 건드리지 않는다 (호출자가 먼저 본다). */
export function briefPath(id: string, dir = process.env.MUD_WORLD ?? DEFAULT_DIR): string {
  return join(dir, "briefs", `${id}.json`);
}

export function regionPath(id: string, dir = process.env.MUD_WORLD ?? DEFAULT_DIR): string {
  return join(dir, "regions", `${id}.json`);
}

export function loadWorld(dir = process.env.MUD_WORLD ?? DEFAULT_DIR): MapData {
  const world = parse(join(dir, "world.json"), zWorld, readJson(join(dir, "world.json")));

  const regionDir = join(dir, "regions");
  let files: string[];
  try {
    files = readdirSync(regionDir).filter((f) => f.endsWith(".json")).sort();
  } catch (err) {
    throw new Error(`${regionDir} 를 읽을 수 없다: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (files.length === 0) throw new Error(`${regionDir} 에 지역이 하나도 없다.`);

  const regions: RegionDef[] = [];
  for (const f of files) {
    const path = join(regionDir, f);
    /* 파일 이름이 곧 지역 id 다. 값 안에 id 를 또 적게 하면 둘이 어긋날 수 있고,
       그건 사람이 눈으로 못 잡는 종류의 오류다 (balance.ts 와 같은 규칙). */
    const id = f.slice(0, -".json".length);
    const r = parse(path, zRegion, readJson(path));
    /* 한 파일 안에서 판정되는 것들. 나머지는 assertWorldData 가 본다.
       타일 줄 길이는 여기서 본다 — 이게 어긋나면 x 범위가 y 마다 달라져
       그 뒤의 모든 검사가 무엇을 말하는지 알 수 없게 된다. */
    const widths = new Set(r.tiles.map((t) => t.length));
    if (widths.size !== 1) {
      throw new Error(`${path}: 타일 줄 길이가 제각각이다 (${[...widths].sort().join(" ")}).`);
    }
    /* 주제 id 가 지역 안에서 겹치면 뒤엣것이 영영 안 열린다 (topicOf 가 find 다). */
    for (const [npcId, npc] of Object.entries(r.npcs)) {
      const seen = new Set<string>();
      for (const t of npc.topics) {
        if (seen.has(t.id)) throw new Error(`${path}: NPC ${npcId} 의 주제 ${t.id} 가 두 번 있다.`);
        seen.add(t.id);
      }
    }
    /* JSON 의 `sensitive` 를 코드의 `sensitiveFlags` 로. 이름이 다른 이유는
       파일에서는 방의 `sensitive` 와 같은 낱말이 읽기 좋고, 코드에서는
       "무엇의 sensitive 인가" 가 드러나야 하기 때문이다. */
    const npcs = Object.fromEntries(
      Object.entries(r.npcs).map(([npcId, n]) => [
        npcId,
        { at: n.at, name: n.name, persona: n.persona, sensitiveFlags: n.sensitive, guild: n.guild, topics: n.topics },
      ]),
    );
    regions.push({ id, ...r, npcs });
  }

  /* NPC id 는 '전역' 유일해야 한다. npcs 표의 PK 이고 승급 큐의 키다.
     지역마다 파일이 나뉘어 있으므로 이 검사는 여기서만 할 수 있다. */
  const npcSeen = new Map<string, string>();
  for (const r of regions) {
    for (const npcId of Object.keys(r.npcs)) {
      const other = npcSeen.get(npcId);
      if (other) throw new Error(`NPC id ${npcId} 가 ${other} 와 ${r.id} 에 둘 다 있다 (전역 유일해야 한다).`);
      npcSeen.set(npcId, r.id);
    }
  }

  const ids = new Set(regions.map((r) => r.id));
  if (!ids.has(world.spawn.region)) {
    throw new Error(`world.json: 스폰 지역 ${world.spawn.region} 이 regions/ 에 없다.`);
  }

  /* 선언되지 않은 플래그를 쓰는 곳은 db/seed.ts 의 assertWorldData 가 잡는다 —
     적의 slainFlag 와 밸런스를 함께 봐야 하므로 여기서는 판정할 수 없다. */
  return { regions, spawn: world.spawn, flags: world.flags };
}
