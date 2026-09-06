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
import type { Balance, EnemyDef, ItemDef, RankDef, SkillDef } from "../engine/enemies";

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
    /** 전리품·임무 공로를 받으려면 적 최대 체력의 몇 할을 깎아야 하는가.
     *  적지 않으면 0 — 옛 동작(피해 1이라도 넣으면 전액) 그대로다. */
    minLootShare: z.number().min(0).max(1).default(0),
  })
  .strict();

const zSkill = z
  .object({
    name: z.string().min(1),
    /** 'ally' 면 같은 전투의 다른 사람에게도 걸 수 있다. 적지 않으면 'self'. */
    target: z.enum(["self", "ally"]).default("self"),
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
    /* 예고 동작. 없으면 그냥 계속 때리는 적이다 — 약한 적까지 몸을 젖히면
       '큰 것이 온다' 가 배경 소음이 된다. */
    windup: z
      .object({
        everyNth: z.number().int().positive(),
        mult: z.number().gt(1),
      })
      .strict()
      .nullable()
      .default(null),
    drops: z.array(zDrop),
  })
  .strict();
/* ★ 한때 여기 refine 이 있었다: "slainFlag 를 켜는 적은 respawnMs 를 가질 수
   없다." 이유는 옳았다 — 파수꾼이 되살아나는데 flag 가 켜진 채면 그 플래그를
   선언한 방들의 묘사가 "사라진 뒤" 인 채로 파수꾼과 마주 본다.

   그런데 그 조항은 **두 개의 다른 축을 하나로 묶고 있었다**:

     세계가 영구히 바뀌었다   — 플래그. 한 방향이고 되돌아가지 않는다
     그 적이 영구히 사라졌다  — 존재. 리스폰 타이머가 정한다

   묶어 둔 대가는 컸다. 보스가 서버 수명 동안 한 번뿐이라, 첫 플레이어가 잡고
   나면 나머지 전원에게 임무 5개 중 2개와 적 6종 중 2종이 없는 게임이 됐다.

   푸는 방법은 refine 을 지우는 것이 아니라 **두 축을 실제로 분리하는 것**이다:
     · world/combat.ts 의 enemyIn 이 respawnMs 가 있는 적은 플래그로 지우지 않는다
     · moods/<플래그>.md 는 '지금 없다' 가 아니라 '그런 일이 있었다' 를 쓴다
       (그 문장은 적이 돌아온 뒤에도 참이어야 한다)
   뒤엣것은 기계가 볼 수 없어서 briefs/README.md 의 저작 규칙으로 갔다. */

const zRank = z
  .object({
    name: z.string().min(1),
    requires: z.array(
      z.object({ itemId: z.string().min(1), qty: z.number().int().positive() }).strict(),
    ),
  })
  .strict();

const FILES = {
  player: zPlayer,
  skills: z.record(z.string().min(1), zSkill),
  items: z.record(z.string().min(1), zItem),
  enemies: z.record(z.string().min(1), zEnemy),
  /** 키가 등급 숫자다. "1".."9" — 사다리는 1부터 빈틈 없이 이어져야 한다. */
  ranks: z.record(z.string().regex(/^[1-9]$/, "1~9 의 정수 문자열"), zRank),
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
  const rawRanks = read(dir, "ranks", FILES.ranks);

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
    /* ★ 예고는 '반응할 한 박자' 를 내주는 것이 전부다. 그 박자가 플레이어의
       스윙보다 짧으면 예고를 보고도 아무것도 못 하고, 예고는 일격 뒤에 붙는
       설명문이 된다 — 그러면 이건 깊이가 아니라 그냥 더 센 적이다. */
    if (e.windup !== null && e.swingMs < player.swingMs) {
      throw new Error(
        `enemies.json: ${id} 의 예고가 반응할 수 없이 짧다 ` +
          `(적 ${e.swingMs}ms < 플레이어 ${player.swingMs}ms).`,
      );
    }
  }

  /* 사다리는 1부터 빈틈 없이 이어져야 한다. 2가 없는데 3이 있으면 3에
     영영 도달할 수 없고, 그건 조용히 도달 불가능한 콘텐츠가 된다. */
  const ranks: RankDef[] = Object.entries(rawRanks)
    .map(([lv, v]) => ({ level: Number(lv), ...v }))
    .sort((a, b) => a.level - b.level);
  ranks.forEach((r, i) => {
    if (r.level !== i + 1) {
      throw new Error(`ranks.json: 등급 사다리에 빈틈이 있다 (${i + 1} 다음이 ${r.level}).`);
    }
    for (const need of r.requires) {
      if (!(need.itemId in items)) {
        throw new Error(`ranks.json: ${r.level}등급이 선언되지 않은 아이템 ${need.itemId} 를 요구한다.`);
      }
    }
  });
  if (ranks.length === 0) throw new Error("ranks.json: 등급이 하나도 없다.");

  return { enemies, skills, skillList: Object.values(skills), items, player, ranks };
}
