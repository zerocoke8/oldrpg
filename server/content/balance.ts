/* 밸런스 데이터를 읽어 검증한다. engine/ 과 데이터 사이의 유일한 문.
 *
 * ★ 여기가 engine/ 이 아닌 이유: 파일을 읽는다. engine/ 은 결정론이어야 하고
 *   I/O 를 모른다 — 시드 PRNG·시계·렌더러와 똑같이, 읽는 것은 바깥이 하고
 *   engine 은 주입받는다.
 *
 * ★ 검증이 부팅에서 '죽는' 이유: 틀린 밸런스로 조용히 도는 것이 더 나쁘다.
 *   체력이 0인 적, 존재하지 않는 아이템을 떨어뜨리는 적, heal 이 없는 물약은
 *   전부 런타임 한참 뒤에야 이상한 모습으로 드러난다.
 *
 * zod 를 쓰는 이유: 프로토콜 검증에서 이미 쓰고 있고(shared/validators.ts),
 * "모양이 틀리면 어디가 왜 틀렸는지" 를 사람이 읽을 수 있게 말해 준다. */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Balance, EnemyDef, ItemDef, SkillDef } from "../engine/enemies";

/** 저장소 루트의 content/balance/. MUD_BALANCE 로 갈아끼울 수 있다 (테스트·실험용). */
const DEFAULT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../content/balance");

const range = z
  .tuple([z.number().int().min(0), z.number().int().min(0)])
  .refine(([lo, hi]) => lo <= hi, "[최소, 최대] 여야 한다");

const zPlayer = z
  .object({
    maxHp: z.number().int().positive(),
    swingMs: z.number().int().positive(),
    damage: range,
    critChance: z.number().min(0).max(1),
    critMult: z.number().min(1),
    respawnMs: z.number().int().nonnegative(),
  })
  .strict();

const zSkill = z
  .object({
    name: z.string().min(1),
    cooldownMs: z.number().int().nonnegative(),
    kind: z.enum(["strike", "heal", "guard"]),
    power: range,
  })
  .strict();

const zItem = z
  .object({
    name: z.string().min(1),
    kind: z.enum(["potion", "trophy"]),
    heal: z.number().int().positive().nullable(),
  })
  .strict()
  /* potion 인데 heal 이 없으면 마셔도 아무 일이 없고, trophy 에 heal 이 있으면
     쓸 수 없는 물건에 회복량이 적혀 있다. 둘 다 조용히 이상하다. */
  .refine((i) => (i.kind === "potion") === (i.heal !== null), {
    message: "potion 은 heal 이 있어야 하고, 그 밖에는 null 이어야 한다",
  });

const zDrop = z
  .object({
    itemId: z.string().min(1),
    qty: z.number().int().positive(),
    chance: z.number().gt(0).max(1),
  })
  .strict();

const zEnemy = z
  .object({
    name: z.string().min(1),
    maxHp: z.number().int().positive(),
    damage: range,
    swingMs: z.number().int().positive(),
    slainFlag: z.string().min(1).nullable(),
    respawnMs: z.number().int().positive().nullable(),
    drops: z.array(zDrop),
  })
  .strict()
  /* 세계를 바꾸는 적은 돌아오지 않는다. 파수꾼이 되살아나는데 guardian_slain 이
     켜진 채 남으면, 그 플래그를 선언한 방들의 묘사가 "파수꾼이 사라진 뒤" 인
     채로 파수꾼과 마주 보게 된다. */
  .refine((e) => !(e.slainFlag !== null && e.respawnMs !== null), {
    message: "slainFlag 를 켜는 적(보스)은 respawnMs 를 가질 수 없다",
  });

const FILES = {
  player: zPlayer,
  skills: z.record(z.string().min(1), zSkill),
  items: z.record(z.string().min(1), zItem),
  enemies: z.record(z.string().min(1), zEnemy),
} as const;

function read<T extends z.ZodTypeAny>(dir: string, name: string, schema: T): z.infer<T> {
  const path = join(dir, `${name}.json`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`${path} 를 읽을 수 없다: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    // 어디가 왜 틀렸는지를 사람이 읽을 수 있게. 부팅 로그가 유일한 창이다.
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".") || "(루트)"}: ${i.message}`);
    throw new Error(`${path} 의 밸런스가 잘못됐다:\n${lines.join("\n")}`);
  }
  return parsed.data;
}

export function loadBalance(dir = process.env.MUD_BALANCE ?? DEFAULT_DIR): Balance {
  const player = read(dir, "player", FILES.player);
  const rawSkills = read(dir, "skills", FILES.skills);
  const rawItems = read(dir, "items", FILES.items);
  const rawEnemies = read(dir, "enemies", FILES.enemies);

  /* JSON 의 '키' 가 곧 id 다. 값 안에 id 를 또 적게 하면 둘이 어긋날 수 있고,
     그건 사람이 눈으로 못 잡는 종류의 오류다. 여기서 한 번에 채운다. */
  const skills: Record<string, SkillDef> = {};
  for (const [id, v] of Object.entries(rawSkills)) skills[id] = { id, ...v };
  const items: Record<string, ItemDef> = {};
  for (const [id, v] of Object.entries(rawItems)) items[id] = { id, ...v };
  const enemies: Record<string, EnemyDef> = {};
  for (const [id, v] of Object.entries(rawEnemies)) enemies[id] = { id, ...v };

  // 파일을 넘나드는 참조는 zod 가 볼 수 없다. 여기서 본다.
  for (const [id, e] of Object.entries(enemies)) {
    for (const d of e.drops) {
      if (!(d.itemId in items)) {
        throw new Error(`enemies.json: ${id} 가 선언되지 않은 아이템 ${d.itemId} 를 떨어뜨린다.`);
      }
    }
  }

  return { enemies, skills, skillList: Object.values(skills), items, player };
}
