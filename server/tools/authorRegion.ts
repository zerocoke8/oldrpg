/* 지역 저작 도구. 브리프 하나에서 content/world/regions/<id>.json 을 만든다.
 *
 *     npm run author -- b3                 개요 + 씨앗까지 (모델을 부른다)
 *     npm run author -- b3 --dry-run       지도만 그려 본다 (아무것도 안 쓴다)
 *     npm run author -- b3 --layout-only   타일만 써 둔다 (모델을 안 부른다)
 *
 * 분업이 이 도구의 전부다:
 *
 *   배치(타일)  결정론적 생성기 (engine/layout.ts). LLM 이 만들지 않는다 —
 *               만들게 하면 연결성도 출구 자리도 아무것도 보장되지 않는다.
 *   씨앗(문장)  LLM (narration/author.ts). 개요 1회 + 열 칸씩 묶어서.
 *   검토        사람. 도구는 파일을 쓰고 끝난다. 커밋은 사람이 한다.
 *
 * ★ 절대 덮어쓰지 않는다 (규칙 3). 이미 있는 씨앗·타일·개요는 그대로 두고
 *   빈 것만 채운다. 씨앗을 한 글자 고치면 seed_id 가 바뀌어 그 방의 생성된
 *   텍스트가 전부 캐시 미스가 되기 때문이다. 다시 짓고 싶으면 사람이 그
 *   줄을 지우고 도구를 다시 돌린다 — 지우는 것은 사람의 결정이다.
 *
 * ★ 그래서 이 도구는 몇 번을 돌려도 안전하고, 중간에 죽어도 이어서 돌면 된다.
 *   묶음 하나가 끝날 때마다 파일에 쓴다 (모델 호출이 비싼 쪽이므로). */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DELTA, OPPOSITE, type Dir } from "../../shared/ids";
import { fileURLToPath } from "node:url";
import { generateLayout, connectedComponents, shapeOf } from "../engine/layout";
import { makeRng } from "../engine/rng";
import { briefPath, loadBrief, regionPath, type RegionBrief } from "../content/world";
import { makeAuthor, type Author, type SeedAsk } from "../narration/author";

export interface AuthorRunOptions {
  /** 한 번에 물을 칸 수. 크면 싸지만 잘릴 위험이 커진다. */
  batch?: number;
  /** 파일에 쓰지 않고 무엇을 할지만 보여준다. */
  dryRun?: boolean;
  /** 배치만 만들어 파일에 쓰고 모델은 부르지 않는다.
   *
   *  ★ 씨앗을 사람이(또는 대화 중인 모델이) 직접 쓰는 경로다. 결과는 완전히
   *    같다 — 지역 파일의 seeds 에 문장이 들어가는 것뿐이고, 그것을 누가
   *    썼는지는 파일에 남지 않는다. 어차피 커밋되는 순간 리뷰를 거친
   *    저작물이 되고 그때부터 불변이다 (규칙 3).
   *    API 키가 없거나, 비용을 안 쓰거나, 지역 전체를 한 사람이 일관되게
   *    쓰고 싶을 때 이쪽이 낫다. */
  layoutOnly?: boolean;
  /** 테스트가 가짜 저자를 꽂는 자리. */
  author?: Author;
  /** content/world/ 를 갈아끼운다 (테스트용). */
  dir?: string;
}

export interface AuthorResult {
  id: string;
  /** 이번에 배치를 만들었는가 (이미 있으면 false). */
  generatedLayout: boolean;
  rooms: number;
  /** 이번에 개요를 만들었는가. */
  generatedOverview: boolean;
  /** 이번에 채운 씨앗 수. */
  filled: number;
  /** 아직 씨앗이 없는 칸. 0 이 아니면 다시 돌려야 한다. */
  missing: string[];
  /** 모델을 몇 번 불렀는가. */
  calls: number;
}

/** 지역 JSON 의 '지금' 모습. 도구는 이걸 읽어 빈 곳만 채워 다시 쓴다. */
interface RegionFile {
  name: string;
  tiles: string[];
  seeds: Record<string, string>;
  sensitive: Record<string, string[]>;
  enemies: Record<string, string>;
  /* 도구는 NPC 를 만들지 않는다 — 누가 어디 서서 무엇을 아는가는 진행의
     결정이라 사람이 쓴다. 자리만 만들어 두고 그대로 실어 나른다. */
  npcs: Record<string, unknown>;
  exits: ExitRow[];
}

interface ExitRow {
  at: string;
  dir: Dir;
  to: { region: string; x: number; y: number };
  requires: string | null;
  minRank: number;
  oneWay: boolean;
}

/** 그 칸의 그 방향이 벽인가. 지역 간 문은 벽 자리에만 둔다 — 걸어갈 수 있는
 *  칸을 가리키면 같은 키 입력에 두 가지 뜻이 생긴다. */
const wallSide = (tiles: readonly string[], x: number, y: number, dir: Dir): boolean => {
  const d = DELTA[dir];
  return (tiles[y + d.dy]?.[x + d.dx] ?? "#") === "#";
};
const walkableAt = (tiles: readonly string[], x: number, y: number): boolean =>
  (tiles[y]?.[x] ?? "#") !== "#";

/** 브리프의 `doors` 를 양쪽 파일에 써 넣는다.
 *
 *  ★ 사람은 한쪽만 적는다. 짝을 손으로 적게 하면 좌표 하나가 어긋나고, 그건
 *    부팅에서야 잡힌다 — 그때는 이미 두 파일을 열어 놓고 어느 쪽이 맞는지
 *    되짚어야 한다. 여기서 한 번 만들면 어긋날 자리가 없다.
 *
 *  ★ 이미 있는 문은 건드리지 않는다 (도구는 덮어쓰지 않는다). 같은 자리에
 *    다른 곳으로 가는 문을 적었다면 그건 사람이 지워야 하는 충돌이다. */
function linkDoors(
  id: string,
  tiles: readonly string[],
  doors: RegionBrief["doors"],
  read: (rid: string) => RegionFile | null,
  write: (rid: string, f: RegionFile) => void,
  mine: ExitRow[],
  log: (s: string) => void,
): void {
  for (const d of doors) {
    const [ax, ay] = d.at.split(",").map(Number) as [number, number];
    const where = `브리프의 문 ${d.at} ${d.dir}`;
    if (!walkableAt(tiles, ax, ay)) throw new Error(`${where}: ${d.at} 은 걸을 수 있는 칸이 아니다.`);
    if (!wallSide(tiles, ax, ay, d.dir)) {
      throw new Error(`${where}: 그 방향이 벽이 아니다 — 한 칸 이동과 뜻이 겹친다.`);
    }
    const other = read(d.to.region);
    if (!other) throw new Error(`${where}: 붙일 지역 ${d.to.region} 이 없다.`);
    if (!walkableAt(other.tiles, d.to.x, d.to.y)) {
      throw new Error(`${where}: 목적지 ${d.to.region} ${d.to.x},${d.to.y} 이 벽이다.`);
    }
    const back = OPPOSITE[d.dir];
    if (!wallSide(other.tiles, d.to.x, d.to.y, back)) {
      throw new Error(
        `${where}: 저쪽 ${d.to.region} ${d.to.x},${d.to.y} 의 ${back} 이 벽이 아니다 — 짝을 놓을 자리가 없다.`,
      );
    }

    const has = (xs: readonly ExitRow[], at: string, dir: Dir): boolean =>
      xs.some((e) => e.at === at && e.dir === dir);
    if (!has(mine, d.at, d.dir)) {
      mine.push({ at: d.at, dir: d.dir, to: d.to, requires: d.requires, minRank: d.minRank, oneWay: false });
      log(`문: ${id} ${d.at} ${d.dir} -> ${d.to.region} ${d.to.x},${d.to.y}`);
    }
    const backAt = `${d.to.x},${d.to.y}`;
    if (!has(other.exits, backAt, back)) {
      other.exits.push({
        at: backAt, dir: back, to: { region: id, x: ax, y: ay },
        requires: d.requires, minRank: d.minRank, oneWay: false,
      });
      write(d.to.region, other);
      log(`문: ${d.to.region} ${backAt} ${back} -> ${id} ${d.at} (짝)`);
    }
  }
}

const readRegion = (path: string): RegionFile | null =>
  existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as RegionFile) : null;

const writeJson = (path: string, data: unknown): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
};

const walkableCoords = (tiles: readonly string[]): string[] => {
  const out: string[] = [];
  for (let y = 0; y < tiles.length; y++) {
    const row = tiles[y] ?? "";
    for (let x = 0; x < row.length; x++) if (row[x] !== "#") out.push(`${x},${y}`);
  }
  return out;
};

/** 이번 묶음의 칸을 `*` 로 표시한 지도. 모델이 '어디를 쓰고 있는지' 를 본다. */
function mapWith(tiles: readonly string[], marked: ReadonlySet<string>): string {
  return tiles
    .map((row, y) =>
      [...row].map((ch, x) => (marked.has(`${x},${y}`) ? "*" : ch)).join(""),
    )
    .join("\n");
}

export async function authorRegion(
  id: string,
  options: AuthorRunOptions = {},
  log: (s: string) => void = console.log,
): Promise<AuthorResult> {
  const batch = Math.max(1, options.batch ?? 10);
  const brief: RegionBrief = loadBrief(id, options.dir);
  const rPath = regionPath(id, options.dir);
  const bPath = briefPath(id, options.dir);

  const existing = readRegion(rPath);

  /* ── 1. 배치 ─────────────────────────────────────────────────────────
     이미 있으면 손대지 않는다. 타일을 다시 만들면 좌표가 통째로 밀려서
     이미 쓴 씨앗이 전혀 다른 방에 붙는다 — 조용히 세계가 뒤섞인다. */
  let tiles: string[];
  let generatedLayout = false;
  if (existing?.tiles?.length) {
    tiles = existing.tiles;
    log(`배치: 이미 있다 (${tiles[0]!.length}x${tiles.length}). 그대로 쓴다.`);
  } else if (brief.tiles?.length) {
    tiles = brief.tiles;
    generatedLayout = true;
    log(`배치: 브리프의 격자를 쓴다 (${tiles[0]!.length}x${tiles.length}).`);
  } else {
    tiles = generateLayout({ rooms: brief.rooms, loopChance: brief.loopChance }, makeRng(brief.layoutSeed));
    generatedLayout = true;
    log(`배치: 시드 ${brief.layoutSeed} 로 생성 (${tiles[0]!.length}x${tiles.length}).`);
  }

  /* dry-run 의 요점은 지도를 눈으로 보는 것이다. 마음에 안 들면 브리프의
     layoutSeed 를 바꿔 다시 돌린다 — 모델을 한 번도 부르지 않고. */
  if (options.dryRun) for (const row of tiles) log(`  ${row}`);

  const parts = connectedComponents(tiles);
  if (parts !== 1) {
    /* 갈 수 없는 방은 씨앗도 생성 비용도 그대로 먹으면서 아무도 못 본다.
       생성기는 구조적으로 하나만 만들지만 손으로 그린 격자는 그렇지 않다. */
    throw new Error(`${id}: 걷는 칸이 ${parts}덩어리로 끊겨 있다. 갈 수 없는 방이 생긴다.`);
  }
  const coords = walkableCoords(tiles);

  /* ── 2. 개요 ─────────────────────────────────────────────────────────
     한 번만 만든다. 방을 나중에 더 뚫어도 같은 장소로 이어져야 한다. */
  const noModel = options.dryRun || options.layoutOnly;
  const author = options.author ?? (noModel ? null : makeAuthor());
  let calls = 0;
  let overview = brief.overview;
  let generatedOverview = false;
  if (overview) {
    log("개요: 브리프에 이미 있다. 그대로 쓴다.");
  } else if (noModel || !author) {
    log("개요: 모델을 부르지 않는다. 씨앗을 손으로 쓸 때는 필요 없다.");
    overview = "";
  } else {
    overview = await author.overview({ name: brief.name, theme: brief.theme, landmarks: brief.landmarks });
    calls++;
    generatedOverview = true;
    log(`개요: ${overview.length}자 생성.`);
  }

  /* ── 3. 씨앗 ─────────────────────────────────────────────────────────
     이미 있는 것은 절대 건드리지 않는다 (규칙 3). */
  const seeds: Record<string, string> = { ...(existing?.seeds ?? {}) };
  /* 격자 밖의 씨앗은 버린다. 타일을 손으로 좁힌 뒤 남은 유령 항목이고,
     그대로 두면 '벽인 칸에 씨앗이 있다' 로 부팅이 죽는다. */
  const inGrid = new Set(coords);
  for (const k of Object.keys(seeds)) if (!inGrid.has(k)) delete seeds[k];

  const todo = coords.filter((c) => !seeds[c]);
  log(`씨앗: ${coords.length}칸 중 ${todo.length}칸이 비어 있다.`);

  /* ── 문 ──────────────────────────────────────────────────────────────
     씨앗보다 먼저 한다. 여기서 던지면 모델을 부르기 전이라 돈이 안 나간다. */
  const exits: ExitRow[] = [...(existing?.exits ?? [])];
  if (!options.dryRun) {
    linkDoors(
      id,
      tiles,
      brief.doors,
      (rid) => readRegion(regionPath(rid, options.dir)),
      (rid, f) => writeJson(regionPath(rid, options.dir), f),
      exits,
      log,
    );
  }

  const save = (): void => {
    if (options.dryRun) return;
    const out: RegionFile = {
      name: existing?.name ?? brief.name,
      tiles,
      seeds: Object.fromEntries(coords.filter((c) => seeds[c]).map((c) => [c, seeds[c]!])),
      sensitive: existing?.sensitive ?? {},
      enemies: existing?.enemies ?? {},
      npcs: existing?.npcs ?? {},
      exits,
    };
    writeJson(rPath, out);
  };

  let filled = 0;
  if (options.layoutOnly) {
    // 배치만 쓴다. 빈 칸 목록은 아래에서 그대로 보고된다 — 그게 '할 일' 이다.
    save();
  } else if (!options.dryRun && author) {
    for (let i = 0; i < todo.length; i += batch) {
      const slice = todo.slice(i, i + batch);
      const asks: SeedAsk[] = slice.map((c) => {
        const [x, y] = c.split(",").map(Number) as [number, number];
        return { coord: c, shape: shapeOf(tiles, x, y) };
      });
      const got = await author.seeds(
        { name: brief.name, overview, map: mapWith(tiles, new Set(slice)) },
        asks,
      );
      calls++;
      for (const [k, v] of got) {
        // 이 조건이 규칙 3의 마지막 관문이다. 위에서 걸러 왔지만 여기가 유일한 쓰기다.
        if (!seeds[k]) {
          seeds[k] = v;
          filled++;
        }
      }
      // 묶음마다 쓴다. 중간에 죽어도 여기까지는 남는다 (모델 호출이 비싼 쪽이다).
      save();
      log(`  ${Math.min(i + batch, todo.length)}/${todo.length} — ${got.size}칸 받음`);
    }
  }
  if (!options.dryRun && (generatedLayout || filled > 0)) save();

  /* 개요는 브리프에 적어 둔다 — 지역 데이터가 아니라 '어떻게 만들었는가' 다. */
  if (generatedOverview && !options.dryRun) {
    writeJson(bPath, { ...brief, overview });
  }

  const missing = coords.filter((c) => !seeds[c]);
  return { id, generatedLayout, rooms: coords.length, generatedOverview, filled, missing, calls };
}

/* ── CLI ───────────────────────────────────────────────────────────── */

async function main(argv: string[]): Promise<void> {
  const id = argv.find((a) => !a.startsWith("--"));
  if (!id) {
    console.error("사용법: npm run author -- <지역id> [--batch N] [--dry-run] [--layout-only]");
    console.error("  content/world/briefs/<지역id>.json 이 있어야 한다.");
    process.exit(2);
  }
  const at = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const dryRun = argv.includes("--dry-run");
  const layoutOnly = argv.includes("--layout-only");

  try {
    process.loadEnvFile(".env");
  } catch {
    /* .env 없음 */
  }
  if (!dryRun && !layoutOnly && !(process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN)) {
    /* 폴백으로 조용히 넘어가지 않는다. 저작의 결과물은 커밋되고 그 뒤로는
       불변이다 — "특징 없는 돌 통로" 50개를 커밋하는 것이 최악이다. */
    console.error("ANTHROPIC_API_KEY 가 없다. 저작은 실물 모델이 있어야 한다.");
    console.error(".env 를 만들거나, --layout-only 로 배치만 만들고 씨앗은 손으로 쓸 것.");
    process.exit(1);
  }

  const r = await authorRegion(id, { batch: Number(at("--batch") ?? 10), dryRun, layoutOnly });
  console.log(
    `\n${r.id}: ${r.rooms}방 · 이번에 채운 씨앗 ${r.filled} · 모델 호출 ${r.calls}회` +
      (r.missing.length ? `\n★ 아직 비어 있는 칸 ${r.missing.length}: ${r.missing.join(" ")}` : ""),
  );
  if (r.missing.length) {
    console.log("  다시 돌리면 빈 칸만 채운다. 이미 쓴 씨앗은 건드리지 않는다.");
  }
  console.log(`\n${regionPath(r.id)} 를 읽어 보고 커밋할 것. 씨앗은 커밋되면 불변이다.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
