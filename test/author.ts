/* 저작 파이프라인. 브리프 하나 -> content/world/regions/<id>.json.
 *
 * 이 파일이 지키는 것은 하나다: **저작이 규칙 1과 3을 깨지 않는다.**
 *
 *   규칙 1  배치(타일·적·출구)는 코드가 만든다. 모델은 문장만 얹는다.
 *           모델이 돌려준 것 중 '우리가 물어본 좌표' 만 통과한다.
 *   규칙 3  이미 있는 씨앗은 절대 덮어쓰지 않는다. 한 글자만 바뀌어도
 *           seed_id 가 달라져 그 방의 생성된 텍스트가 전부 날아간다.
 *
 * 실물 모델은 부르지 않는다 (가짜 저자를 꽂는다). 부르면 검사가 요금과
 * 네트워크에 달리고, 무엇보다 '무엇을 검사하는지' 가 모델의 기분에 달린다. */

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { connectedComponents, generateLayout, shapeOf } from "../server/engine/layout";
import { makeRng } from "../server/engine/rng";
import { makeMap } from "../server/engine/map";
import { loadWorld } from "../server/content/world";
import { assertWorldData } from "../server/db/seed";
import { loadBalance } from "../server/content/balance";
import { makeAuthor, type Author, type SeedAsk } from "../server/narration/author";
import { authorRegion } from "../server/tools/authorRegion";

let failures = 0;
let checks = 0;
function check(label: string, cond: boolean, detail = ""): void {
  checks++;
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}
const section = (s: string) => console.log(`\n${s}`);

const walkables = (tiles: readonly string[]): number =>
  tiles.reduce((n, row) => n + [...row].filter((c) => c !== "#").length, 0);

/** content/world 를 통째로 복사한 임시 디렉터리 + 브리프 하나. */
function workspace(id: string, brief: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "author-"));
  cpSync("content/world", dir, { recursive: true });
  mkdirSync(join(dir, "briefs"), { recursive: true });
  writeFileSync(join(dir, "briefs", `${id}.json`), JSON.stringify(brief, null, 2), "utf8");
  return dir;
}
const regionOf = (dir: string, id: string): Record<string, never> & {
  name: string;
  tiles: string[];
  seeds: Record<string, string>;
  sensitive: Record<string, string[]>;
  enemies: Record<string, string>;
  npcs: Record<string, unknown>;
  exits: unknown[];
} => JSON.parse(readFileSync(join(dir, "regions", `${id}.json`), "utf8")) as never;

/** 가짜 저자. 무엇을 물었는지 기록하고, 시키는 대로 삐뚤어진 답을 준다. */
function fakeAuthor(
  reply: (asks: readonly SeedAsk[]) => Record<string, unknown>,
): Author & { asked: SeedAsk[][]; overviews: number; maps: string[] } {
  const asked: SeedAsk[][] = [];
  const maps: string[] = [];
  let overviews = 0;
  return {
    overviewVersion: "fake",
    seedsVersion: "fake",
    asked,
    maps,
    get overviews() {
      return overviews;
    },
    overview: () => {
      overviews++;
      return Promise.resolve("가짜 개요. 물이 차 있고 계단이 무너져 있다.");
    },
    seeds: (ctx, asks) => {
      asked.push([...asks]);
      maps.push(ctx.map);
      const raw = reply(asks);
      const out = new Map<string, string>();
      /* 진짜 makeAuthor().seeds 와 같은 문지기를 여기서도 돌린다 — 이 가짜는
         '모델' 이 아니라 '저자' 를 대신하므로, 걸러진 뒤의 모습이어야 한다. */
      const wanted = new Set(asks.map((a) => a.coord));
      for (const [k, v] of Object.entries(raw)) {
        if (wanted.has(k) && typeof v === "string" && v.trim()) out.set(k, v.trim());
      }
      return Promise.resolve(out);
    },
  };
}

/** 좌표마다 서로 다른 씨앗. */
const seedFor = (c: string) => `${c} 의 씨앗`;
const answerAll = (asks: readonly SeedAsk[]): Record<string, string> =>
  Object.fromEntries(asks.map((a) => [a.coord, seedFor(a.coord)]));

/** 가짜 Anthropic 클라이언트. 텍스트 하나를 돌려준다. */
function fakeClient(text: string, stop: Anthropic.Message["stop_reason"] = "end_turn") {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  return {
    calls,
    messages: {
      create(body: Anthropic.MessageCreateParamsNonStreaming) {
        calls.push(body);
        return Promise.resolve({
          content: [{ type: "text", text, citations: null }],
          stop_reason: stop,
        } as unknown as Anthropic.Message);
      },
    },
  };
}

async function main() {
  const quiet = () => {};

  // ── ① 배치 생성기 ────────────────────────────────────────────────────
  section("① 배치는 코드가 만든다 (규칙 1) — 결정론이고 항상 이어져 있다");
  const a1 = generateLayout({ rooms: 40 }, makeRng(1234));
  const a2 = generateLayout({ rooms: 40 }, makeRng(1234));
  const b = generateLayout({ rooms: 40 }, makeRng(1235));
  check("같은 시드는 같은 격자를 낸다", JSON.stringify(a1) === JSON.stringify(a2));
  check("다른 시드는 다른 격자를 낸다", JSON.stringify(a1) !== JSON.stringify(b));
  check("걷는 칸 수가 정확히 요청한 만큼이다", walkables(a1) === 40, String(walkables(a1)));

  let allConnected = true;
  let allBordered = true;
  for (let s = 1; s <= 40; s++) {
    const t = generateLayout({ rooms: 10 + s, loopChance: s % 3 === 0 ? 0 : 0.2 }, makeRng(s * 7919));
    if (connectedComponents(t) !== 1) allConnected = false;
    if (walkables(t) !== 10 + s) allBordered = false;
    // 테두리는 전부 벽이어야 한다 — 아니면 격자 밖으로 걸어 나갈 수 있다.
    const h = t.length;
    const w = t[0]!.length;
    for (let x = 0; x < w; x++) if (t[0]![x] !== "#" || t[h - 1]![x] !== "#") allBordered = false;
    for (let y = 0; y < h; y++) if (t[y]![0] !== "#" || t[y]![w - 1] !== "#") allBordered = false;
  }
  check("★ 40가지 시드에서 전부 하나로 이어져 있다 (뚫는 순간 붙어 있으므로)", allConnected);
  check("테두리는 전부 벽이고 칸 수도 정확하다", allBordered);
  check("rooms 가 0 이면 거절한다", (() => {
    try {
      generateLayout({ rooms: 0 }, makeRng(1));
      return false;
    } catch {
      return true;
    }
  })());

  const split = ["#####", "#.#.#", "#####"];
  check("★ 끊긴 격자를 connectedComponents 가 잡는다 (손으로 그린 지도용)",
    connectedComponents(split) === 2, String(connectedComponents(split)));
  check("shapeOf 가 막다른 곳을 말한다", shapeOf(["###", "#.#", "#.#", "###"], 1, 1).includes("막다른 곳"),
    shapeOf(["###", "#.#", "#.#", "###"], 1, 1));
  check("shapeOf 가 갈림길을 말한다",
    shapeOf(["###", "...", "#.#"], 1, 1).includes("갈림길"), shapeOf(["###", "...", "#.#"], 1, 1));

  // ── ② 덮어쓰지 않는다 ────────────────────────────────────────────────
  section("② 이미 있는 것은 절대 덮어쓰지 않는다 (규칙 3)");
  const BRIEF = {
    name: "시험 지역",
    theme: "검사를 위한 장소.",
    landmarks: ["표지석"],
    rooms: 12,
    layoutSeed: 424242,
    loopChance: 0.1,
    tiles: null,
    overview: null,
  };
  const dir = workspace("bt", BRIEF);
  const fa = fakeAuthor(answerAll);

  const r1 = await authorRegion("bt", { dir, author: fa, batch: 5 }, quiet);
  check("1회차: 배치를 만들었다", r1.generatedLayout && r1.rooms === 12, JSON.stringify([r1.rooms]));
  check("1회차: 개요를 한 번 만들었다", r1.generatedOverview && fa.overviews === 1);
  check("1회차: 12칸을 전부 채웠다", r1.filled === 12 && r1.missing.length === 0,
    JSON.stringify([r1.filled, r1.missing]));
  check("묶음으로 물었다 (5 + 5 + 2)", JSON.stringify(fa.asked.map((a) => a.length)) === "[5,5,2]",
    JSON.stringify(fa.asked.map((a) => a.length)));
  check("★ 이웃 정보를 함께 물었다 (지도에 없는 문을 만들지 않게)",
    fa.asked.flat().every((a) => /[북남서동]/.test(a.shape)), JSON.stringify(fa.asked[0]));
  check("★ 이번 묶음의 칸을 지도에 표시해 줬다", (fa.maps[0] ?? "").includes("*"));
  check("개요가 브리프에 기록됐다",
    (JSON.parse(readFileSync(join(dir, "briefs", "bt.json"), "utf8")) as { overview: string | null })
      .overview !== null);

  const first = regionOf(dir, "bt");
  const firstTiles = JSON.stringify(first.tiles);

  // 사람이 씨앗 하나를 고쳐 둔다. 도구는 이걸 되돌리면 안 된다.
  const hand = Object.keys(first.seeds)[3]!;
  first.seeds[hand] = "사람이 손으로 고친 씨앗";
  writeFileSync(join(dir, "regions", "bt.json"), JSON.stringify(first, null, 2), "utf8");

  const fa2 = fakeAuthor(answerAll);
  const r2 = await authorRegion("bt", { dir, author: fa2, batch: 5 }, quiet);
  const second = regionOf(dir, "bt");
  check("2회차: 모델을 한 번도 부르지 않았다", r2.calls === 0 && fa2.asked.length === 0,
    String(r2.calls));
  check("2회차: 개요도 다시 만들지 않았다", !r2.generatedOverview && fa2.overviews === 0);
  check("★ 사람이 고친 씨앗이 그대로다", second.seeds[hand] === "사람이 손으로 고친 씨앗",
    String(second.seeds[hand]));
  check("★ 배치도 다시 만들지 않았다 (좌표가 밀리면 세계가 뒤섞인다)",
    JSON.stringify(second.tiles) === firstTiles && !r2.generatedLayout);

  // 한 칸만 지우면 그 칸만 다시 묻는다.
  const gap = Object.keys(second.seeds)[7]!;
  delete second.seeds[gap];
  writeFileSync(join(dir, "regions", "bt.json"), JSON.stringify(second, null, 2), "utf8");
  const fa3 = fakeAuthor(answerAll);
  const r3 = await authorRegion("bt", { dir, author: fa3, batch: 5 }, quiet);
  check("★ 지운 칸 하나만 다시 묻는다", r3.filled === 1 && fa3.asked.flat().length === 1,
    JSON.stringify([r3.filled, fa3.asked.flat().map((a) => a.coord)]));
  check("그 칸이 맞다", fa3.asked[0]?.[0]?.coord === gap, String(fa3.asked[0]?.[0]?.coord));
  check("나머지는 그대로다", regionOf(dir, "bt").seeds[hand] === "사람이 손으로 고친 씨앗");

  // ── ③ 모델은 세계를 만들 수 없다 ─────────────────────────────────────
  section("③ 모델이 돌려준 것 중 '물어본 좌표' 만 통과한다 (규칙 1)");
  // 사람이 손으로 붙여 둔 구조. 도구가 이걸 건드리면 안 된다.
  const before = regionOf(dir, "bt");
  before.enemies = {};
  before.sensitive = { [Object.keys(before.seeds)[0]!]: ["guardian_slain"] };
  before.npcs = {};
  before.exits = [];
  before.seeds = {};
  writeFileSync(join(dir, "regions", "bt.json"), JSON.stringify(before, null, 2), "utf8");

  const naughty = fakeAuthor((asks) => ({
    ...answerAll(asks.slice(0, 2)), // 물어본 것 중 둘만 답하고
    "99,99": "지도에 없는 방", //      없는 방을 만들어내고
    "0,0": "벽인 칸", //               벽에도 하나 두고
    [asks[2]?.coord ?? "x"]: "", //    빈 문자열
    [asks[3]?.coord ?? "y"]: 42, //    문자열이 아닌 것
  }));
  const r4 = await authorRegion("bt", { dir, author: naughty, batch: 12 }, quiet);
  const after = regionOf(dir, "bt");
  check("★ 지도에 없는 좌표는 파일에 들어가지 않았다", !("99,99" in after.seeds));
  check("★ 벽인 칸도 마찬가지다", !("0,0" in after.seeds));
  check("빈 문자열은 씨앗이 아니다", Object.values(after.seeds).every((v) => v.trim().length > 0));
  check("문자열이 아닌 것도 버렸다", Object.values(after.seeds).every((v) => typeof v === "string"));
  check("답한 만큼만 채웠다", r4.filled === 2, String(r4.filled));
  check("★ 나머지는 '빠졌다' 고 보고한다 (조용히 메우지 않는다)",
    r4.missing.length === 10, JSON.stringify(r4.missing.length));
  check("★ 사람이 붙인 구조를 건드리지 않았다",
    JSON.stringify(after.sensitive) === JSON.stringify(before.sensitive) &&
      JSON.stringify(after.enemies) === "{}" && JSON.stringify(after.exits) === "[]" &&
      JSON.stringify(after.npcs) === JSON.stringify(before.npcs),
    JSON.stringify([after.sensitive, after.enemies, after.exits, after.npcs]));
  check("배치도 그대로다", JSON.stringify(after.tiles) === firstTiles);

  // 끊긴 격자는 애초에 거절한다.
  const broken = workspace("bx", { ...BRIEF, tiles: ["#####", "#.#.#", "#####"] });
  let refused = "";
  try {
    await authorRegion("bx", { dir: broken, author: fakeAuthor(answerAll) }, quiet);
  } catch (e) {
    refused = e instanceof Error ? e.message : String(e);
  }
  check("★ 끊긴 격자를 거절한다 (갈 수 없는 방은 비용만 먹는다)", refused.includes("덩어리"), refused);
  rmSync(broken, { recursive: true, force: true });

  // ── ④ 결과가 진짜 세계로 부팅된다 ───────────────────────────────────
  section("④ 만들어진 지역이 그대로 부팅 검증을 통과한다");
  const filler = fakeAuthor(answerAll);
  const r5 = await authorRegion("bt", { dir, author: filler }, quiet);
  check("남은 칸을 채웠다", r5.missing.length === 0, JSON.stringify(r5.missing));
  const map = makeMap(loadWorld(dir));
  check("loadWorld 가 새 지역을 읽는다", Boolean(map.region("bt")));
  check("기존 지역도 그대로다", Boolean(map.region("b1")) && Boolean(map.region("b2")));
  let bootError = "";
  try {
    assertWorldData(map, loadBalance());
  } catch (e) {
    bootError = e instanceof Error ? e.message : String(e);
  }
  check("★ assertWorldData 를 통과한다 (사람이 손볼 것 없이 그대로 돈다)", bootError === "", bootError);
  check("방 수가 맞다", map.rooms().filter((r) => r.region === "bt").length === 12,
    String(map.rooms().filter((r) => r.region === "bt").length));

  rmSync(dir, { recursive: true, force: true });

  // ── ⑤ 진짜 저자의 파싱 ──────────────────────────────────────────────
  section("⑤ makeAuthor — 모델 응답을 어떻게 받아들이는가");
  const asks: SeedAsk[] = [
    { coord: "1,1", shape: "동 (막다른 곳)" },
    { coord: "2,1", shape: "서 (막다른 곳)" },
  ];
  const ctx = { name: "시험", overview: "개요", map: "#.#" };

  const fenced = fakeClient('네, 여기 있습니다:\n```json\n{"1,1":"첫 칸","2,1":"둘째 칸"}\n```\n끝!');
  const got = await makeAuthor({ client: fenced }).seeds(ctx, asks);
  check("코드 울타리와 사족이 붙어도 JSON 을 꺼낸다", got.get("1,1") === "첫 칸" && got.size === 2,
    JSON.stringify([...got]));
  check("system 프롬프트가 파일에서 왔다",
    (fenced.calls[0]?.system as string).includes("씨앗"), String(fenced.calls[0]?.system).slice(0, 40));
  check("이웃 정보가 user 메시지에 실렸다",
    JSON.stringify(fenced.calls[0]?.messages).includes("막다른 곳"));

  const extra = fakeClient('{"1,1":"좋다","9,9":"없는 방","2,1":""}');
  const got2 = await makeAuthor({ client: extra }).seeds(ctx, asks);
  check("★ 물어보지 않은 좌표를 버린다", !got2.has("9,9") && got2.size === 1, JSON.stringify([...got2]));

  const truncated = fakeClient('{"1,1":"잘린', "max_tokens");
  let cut = "";
  try {
    await makeAuthor({ client: truncated }).seeds(ctx, asks);
  } catch (e) {
    cut = e instanceof Error ? e.message : String(e);
  }
  check("★ 잘린 응답을 던진다 (반쯤 만든 세계를 커밋하지 않는다)", cut.includes("max_tokens"), cut);

  const garbage = fakeClient("죄송합니다, 도와드릴 수 없습니다.");
  let bad = "";
  try {
    await makeAuthor({ client: garbage }).seeds(ctx, asks);
  } catch (e) {
    bad = e instanceof Error ? e.message : String(e);
  }
  check("JSON 이 아니면 던진다", bad.includes("JSON"), bad);

  const ov = fakeClient("물에 잠긴 계단. 아래로 갈수록 물이 깊어진다.");
  const text = await makeAuthor({ client: ov }).overview({
    name: "시험", theme: "물", landmarks: ["눈금"],
  });
  check("개요도 프롬프트 파일을 쓴다", text.includes("물에 잠긴"),
    text);
  check("★ landmarks 가 프롬프트에 들어갔다",
    JSON.stringify(ov.calls[0]?.messages).includes("눈금"));

  section(failures === 0 ? `PASS — ${checks}/${checks} 검사 통과` : `FAIL — ${failures}/${checks} 실패`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
