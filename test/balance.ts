/* 밸런스가 '데이터' 라는 것을 지킨다.
 *
 * 확인하는 것:
 *   계약   content/balance/*.json 이 실제로 읽히고, 틀린 값이면 '부팅에서' 죽는다
 *   주입   수치를 바꾸면 게임이 실제로 달라진다 (= 코드가 상수를 들고 있지 않다)
 *   경계   engine/ 은 파일을 읽지 않는다 — 읽는 것은 content/, 주는 것은 index.ts */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { loadBalance } from "../server/content/balance";
import { loadWorld } from "../server/content/world";
import { makeMap } from "../server/engine/map";
import { simulate, simulateMissions } from "../server/tools/balanceSim";
import { boot } from "../server/index";
import { PROTOCOL_VERSION, type ServerMsg } from "../shared/protocol";

const PORT = 8910;
const DB = join(tmpdir(), `mud-balance-${process.pid}.db`);

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 진짜 파일을 복사해 한 군데만 망가뜨린 임시 디렉터리. */
function broken(file: string, mutate: (data: Record<string, unknown>) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "bal-"));
  cpSync("content/balance", dir, { recursive: true });
  const path = join(dir, `${file}.json`);
  const data = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  mutate(data);
  writeFileSync(path, JSON.stringify(data, null, 2));
  return dir;
}
/** 그 디렉터리로 loadBalance 를 부르면 죽는가. 죽으면 이유를 돌려준다. */
function refuses(dir: string): string | null {
  try {
    loadBalance(dir);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  section("① 진짜 파일이 읽히고 검증을 통과한다");
  const b = loadBalance();
  check("적·스킬·아이템·플레이어가 전부 실렸다",
    Object.keys(b.enemies).length >= 3 && Object.keys(b.skills).length === 3 &&
      Object.keys(b.items).length >= 2 && b.player.maxHp > 0,
    JSON.stringify({ e: Object.keys(b.enemies), s: Object.keys(b.skills) }));
  check("★ JSON 의 '키' 가 곧 id 다 (값 안에 id 를 또 적지 않는다)",
    Object.entries(b.enemies).every(([k, v]) => v.id === k) &&
      Object.entries(b.items).every(([k, v]) => v.id === k));
  check("skillList 는 선언 순서를 지킨다 (커맨드 창의 순서다)",
    JSON.stringify(b.skillList.map((s) => s.id)) === JSON.stringify(Object.keys(b.skills)),
    JSON.stringify(b.skillList.map((s) => s.id)));

  /* ── 난이도 불변식 ──────────────────────────────────────────────────
     '올바른 수치' 는 설계 결정이라 검사가 정할 수 없다. 검사가 정할 수 있는
     것은 두 가지다: 이길 수 없는 적이 없을 것, 그리고 아무 생각 없이 이기는
     보스가 없을 것. 둘 다 실제 엔진 함수로 돌려서 본다 (server/tools/balanceSim.ts).

     수치를 고치면 여기가 먼저 말해 준다 — 플레이해 보고 아는 것보다 낫다. */
  section("①' 난이도 — 이길 수 없는 적도, 생각 없이 이기는 보스도 없다");
  const sim = simulate(b, 120);
  const skilled = sim.filter((r) => r.style === "skilled");
  const reactive = sim.filter((r) => r.style === "reactive");
  const basic = sim.filter((r) => r.style === "basic");
  /* '제대로 싸우는 사람' 의 기준이 예고를 보는 쪽(reactive)으로 옮겨 갔다.
     스킬만 쓰는 쪽에도 바닥을 둔다 — 예고를 놓친 것이 곧 죽음이면 그건
     깊이가 아니라 암기다. */
  for (const r of reactive) {
    check(`${r.name}: 제대로 싸우면 이길 수 있다 (${Math.round(r.winRate * 100)}%)`,
      r.winRate >= 0.6, `${Math.round(r.winRate * 100)}% · ${r.medianSec}s`);
  }
  for (const r of skilled) {
    check(`${r.name}: 예고를 놓쳐도 절망적이지는 않다 (${Math.round(r.winRate * 100)}%)`,
      r.winRate >= 0.35, `${Math.round(r.winRate * 100)}%`);
  }
  /* ★ 예고가 값을 만드는가. 이 검사가 없으면 예고는 '화면에 한 줄 더' 일
     뿐이다 — 실제로 예고를 넣기 전의 방어 태세가 승률 기여 1%p 였고,
     한 판 표만 봐서는 그것을 알 수 없었다. */
  const windupIds = Object.values(b.enemies).filter((e) => e.windup !== null).map((e) => e.id);
  check("★ 예고를 가진 적이 있다 (없으면 아래 검사가 공회전한다)", windupIds.length > 0);
  const gains = windupIds.map((id) => ({
    id,
    gain: (reactive.find((r) => r.id === id)?.winRate ?? 0) -
      (skilled.find((r) => r.id === id)?.winRate ?? 0),
  }));
  check("★ 예고를 보고 막는 것이 승률로 돌아온다 (방어 태세에 값이 붙었다)",
    gains.some((g) => g.gain >= 0.15),
    JSON.stringify(gains.map((g) => [g.id, Math.round(g.gain * 100)])));
  /* '보스' = 세계를 바꾸는 적. 돌아오는가와는 다른 축이다 — 한때 그 둘이
     묶여 있었고(refine), 그래서 보스가 서버 수명 동안 한 번뿐이었다. */
  const bosses = Object.values(b.enemies).filter((e) => e.slainFlag !== null).map((e) => e.id);
  for (const id of bosses) {
    const bs = basic.find((r) => r.id === id)!;
    check(`★ ${bs.name}: 기본 공격만으로는 이기기 어렵다 (스킬이 의미를 갖는다)`,
      bs.winRate <= 0.35, `${Math.round(bs.winRate * 100)}%`);
  }
  const trash = sim.filter((r) => r.style === "basic" && !bosses.includes(r.id));
  check("★ 잡몹 중 적어도 하나는 기본 공격만으로도 편하게 잡힌다 (첫 전투)",
    trash.some((r) => r.winRate === 1 && r.medianHpPct >= 80),
    JSON.stringify(trash.map((r) => [r.name, r.medianHpPct])));

  /* ★ 임무는 '연달아' 싸운다. 한 판 승률 100% 가 임무 완주를 뜻하지 않는다 —
     실제로 겪었다: 잔류 괴령은 혼자서는 100% 이기지만 남는 체력이 40% 라,
     둘을 연달아 잡으라는 첫 임무가 회복 없이는 두 번째에서 죽었다.
     위의 표만 봤으면 초록불이었다. */
  section("①* 임무 — 받을 수 있는 일은 끝낼 수 있어야 한다");
  const runs = simulateMissions(b, 120);
  for (const r of runs.filter((x) => x.style === "reactive" && x.potions === 2)) {
    check(`${r.name}: 제대로 싸우고 물약이 있으면 끝낼 수 있다 (${Math.round(r.clearRate * 100)}%)`,
      r.clearRate >= 0.6, `${Math.round(r.clearRate * 100)}%`);
  }
  /* 첫 임무는 아무것도 모르는 사람이 받는다. 여기서 죽으면 그게 첫인상이다. */
  const firstMissions = runs.filter(
    (r) => r.style === "basic" && r.potions === 0 && r.clearRate >= 0.9,
  );
  check("★ 기본 공격과 빈손으로도 끝낼 수 있는 임무가 있다 (처음 받는 일)",
    firstMissions.length > 0,
    JSON.stringify(runs.filter((r) => r.style === "basic" && r.potions === 0)
      .map((r) => [r.name, Math.round(r.clearRate * 100)])));

  /* ★ 사다리의 모든 칸이 무언가를 열어야 한다. 열지 않는 등급은 이름만
     바꾸면서 시간을 먹는다 — 실제로 3·4·5 등급(어둠 결정 19개, 50~90분)이
     아무 문도 안 열고 있었다. 지역 문 10개 중 minRank 를 요구하는 것이
     하나뿐이었고 그 1등급은 무료였다. */
  section("①° 사다리 — 오른 등급이 무언가를 연다");
  const gated = new Map<number, string[]>();
  for (const r of makeMap(loadWorld()).regions()) {
    for (const e of r.exits) {
      if (e.minRank <= 0) continue;
      gated.set(e.minRank, [...(gated.get(e.minRank) ?? []), `${r.id}->${e.to.region}`]);
    }
  }
  for (const m of makeMap(loadWorld()).missions()) {
    if (m.minRank <= 0) continue;
    gated.set(m.minRank, [...(gated.get(m.minRank) ?? []), `임무 ${m.id}`]);
  }
  for (const rank of b.ranks) {
    /* 1등급은 예외다 — 등록 자체이고, 그것이 여는 것은 '사다리에 오르는 것' 이다.
       다만 1등급도 무언가를 열지 않으면 등록할 이유가 없으므로 함께 본다. */
    check(`${rank.level}등급(${rank.name})이 무언가를 연다`,
      (gated.get(rank.level)?.length ?? 0) > 0,
      `사다리에 있는데 이 등급을 요구하는 문·임무가 없다. 지역이 늘 때까지 사다리를 줄이거나, 걸 곳을 만들 것`);
  }
  check("★ 사다리가 콘텐츠보다 길지 않다",
    Math.max(...[...gated.keys()], 0) >= b.ranks[b.ranks.length - 1]!.level,
    `최고 등급 ${b.ranks[b.ranks.length - 1]!.level} · 실제로 걸린 최고 ${Math.max(...[...gated.keys()], 0)}`);

  section("①'' 배치 — 마을은 안전하고, 깊을수록 세진다");
  const map = makeMap(loadWorld());
  const spawnRegion = map.region(map.spawn.region)!;
  check("★ 스폰 지역에는 적이 없다 (돌아올 곳이 있어야 한다)",
    Object.keys(spawnRegion.enemies).length === 0,
    JSON.stringify(Object.keys(spawnRegion.enemies)));
  /* 배치된 적이 전부 같은 놈이면 곡선이 아니다. */
  const placed = new Set(map.regions().flatMap((r) => Object.values(r.enemies)));
  check("적이 여러 종류로 배치돼 있다", placed.size >= 4, JSON.stringify([...placed]));
  check("정의만 있고 어디에도 없는 적이 없다",
    Object.keys(b.enemies).every((id) => placed.has(id)),
    JSON.stringify(Object.keys(b.enemies).filter((id) => !placed.has(id))));
  /* 보스는 하나의 지역에 하나. 둘이면 어느 쪽을 잡아도 같은 플래그가 켜져
     다른 하나가 영영 안 나오는 적이 된다. */
  for (const r of map.regions()) {
    const bossHere = Object.values(r.enemies).filter((id) => bosses.includes(id));
    check(`${r.id}: 보스가 둘 이상 겹치지 않는다`, bossHere.length <= 1, JSON.stringify(bossHere));
  }

  section("② 틀린 값이면 '부팅에서' 죽는다 — 조용히 도는 것보다 낫다");
  const cases: [string, string, (d: Record<string, unknown>) => void, string][] = [
    ["체력이 0인 적", "enemies", (d) => { (d.husk_specimen as Record<string, unknown>).maxHp = 0; }, "maxHp"],
    ["최소가 최대보다 큰 피해", "enemies", (d) => { (d.husk_specimen as Record<string, unknown>).damage = [9, 2]; }, "damage"],
    ["확률이 1을 넘는 드랍", "enemies", (d) => {
      (d.husk_specimen as Record<string, unknown>).drops = [{ itemId: "stabilizer", qty: 1, chance: 1.5 }];
    }, "chance"],
    ["★ 없는 아이템을 떨어뜨린다", "enemies", (d) => {
      (d.husk_specimen as Record<string, unknown>).drops = [{ itemId: "없는물약", qty: 1, chance: 1 }];
    }, "선언되지 않은 아이템"],
    ["모르는 필드 (오타)", "enemies", (d) => { (d.husk_specimen as Record<string, unknown>).maxHP = 50; }, "maxHP"],
    ["★ potion 인데 heal 이 없다", "items", (d) => { (d.stabilizer as Record<string, unknown>).heal = null; }, "heal"],
    ["trophy 인데 heal 이 있다", "items", (d) => { (d.research_log as Record<string, unknown>).heal = 5; }, "heal"],
    ["치명타 확률이 1을 넘는다", "player", (d) => { d.critChance = 2; }, "critChance"],
    ["스킬 종류가 오타", "skills", (d) => { (d.mend as Record<string, unknown>).kind = "healz"; }, "kind"],
    ["예고 배수가 1 이하 (커지지 않는 '큰 일격')", "enemies", (d) => {
      (d.proliferant as Record<string, unknown>).windup = { everyNth: 3, mult: 1 };
    }, "mult"],
    /* ★ 예고는 '반응할 한 박자' 가 전부다. 그 박자가 플레이어 스윙보다 짧으면
       예고를 보고도 아무것도 못 한다 — 깊이가 아니라 그냥 더 센 적이 된다. */
    ["★ 반응할 수 없이 짧은 예고", "enemies", (d) => {
      (d.proliferant as Record<string, unknown>).swingMs = 200;
    }, "반응할 수 없이 짧다"],
  ];
  for (const [label, file, mutate, needle] of cases) {
    const why = refuses(broken(file, mutate));
    check(label, why !== null && why.includes(needle), why ?? "통과해 버렸다");
  }
  const missing = mkdtempSync(join(tmpdir(), "bal-"));
  check("파일이 아예 없으면 그렇게 말한다",
    (refuses(missing) ?? "").includes("읽을 수 없다"));

  section("③ 배치와 정의는 다른 것이다 (부팅에서 짝을 본다)");
  const noSuchEnemy = broken("enemies", (d) => { delete d.husk_specimen; });
  let bootFailed = "";
  try {
    boot(DB, PORT, { llm: "off", balance: loadBalance(noSuchEnemy) }).close();
  } catch (err) {
    bootFailed = err instanceof Error ? err.message : String(err);
  }
  rmSync(noSuchEnemy, { recursive: true, force: true });
  check("★ 배치된 적이 정의에 없으면 서버가 뜨지 않는다",
    bootFailed.includes("husk_specimen"), bootFailed || "떴다");

  section("④ 주입이 실제로 통한다 — 수치를 바꾸면 게임이 달라진다");
  /* 이게 이 작업의 요점이다. 코드가 상수를 들고 있었다면 파일을 고쳐도
     아무 일도 일어나지 않는다. */
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
  const tuned = loadBalance();
  const server = boot(DB, PORT, {
    llm: "off",
    balance: { ...tuned, player: { ...tuned.player, maxHp: 77 } },
  });
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  await new Promise<void>((res, rej) => {
    ws.once("open", () => res());
    ws.once("error", rej);
  });
  const inbox: ServerMsg[] = [];
  ws.on("message", (d) => inbox.push(JSON.parse(String(d)) as ServerMsg));
  ws.send(JSON.stringify({ t: "hello", pv: PROTOCOL_VERSION, token: null, name: null }));
  await sleep(400);
  const snap = inbox.find((m) => m.t === "snapshot");
  check("★ player.json 의 maxHp 가 새 캐릭터에 실제로 적용된다",
    snap?.t === "snapshot" && snap.self.maxHp === 77,
    JSON.stringify(snap?.t === "snapshot" ? snap.self.maxHp : snap?.t));
  check("hp 도 같은 값으로 시작한다",
    snap?.t === "snapshot" && snap.self.hp === 77);
  ws.terminate();
  await server.close();
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${checks - failures}/${checks} 검사 통과`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
