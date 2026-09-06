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
    oneWay: z.boolean(),
  })
  .strict();

const zRegion = z
  .object({
    name: z.string().min(1),
    tiles: z.array(z.string().regex(/^[#.STE]+$/, "타일은 # . S T E 만 쓴다")).min(1),
    seeds: z.record(coord, z.string().min(1)),
    sensitive: z.record(coord, z.array(z.string().min(1))),
    enemies: z.record(coord, z.string().min(1)),
    exits: z.array(zExit),
  })
  .strict();

const zWorld = z.object({ spawn: zPos }).strict();

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
    regions.push({ id, ...r });
  }

  const ids = new Set(regions.map((r) => r.id));
  if (!ids.has(world.spawn.region)) {
    throw new Error(`world.json: 스폰 지역 ${world.spawn.region} 이 regions/ 에 없다.`);
  }

  return { regions, spawn: world.spawn };
}
