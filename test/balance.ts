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

  section("② 틀린 값이면 '부팅에서' 죽는다 — 조용히 도는 것보다 낫다");
  const cases: [string, string, (d: Record<string, unknown>) => void, string][] = [
    ["체력이 0인 적", "enemies", (d) => { (d.ashen_pages as Record<string, unknown>).maxHp = 0; }, "maxHp"],
    ["최소가 최대보다 큰 피해", "enemies", (d) => { (d.ashen_pages as Record<string, unknown>).damage = [9, 2]; }, "damage"],
    ["확률이 1을 넘는 드랍", "enemies", (d) => {
      (d.ashen_pages as Record<string, unknown>).drops = [{ itemId: "minor_potion", qty: 1, chance: 1.5 }];
    }, "chance"],
    ["★ 보스인데 리스폰한다", "enemies", (d) => { (d.shadow_warden as Record<string, unknown>).respawnMs = 1000; }, "보스"],
    ["★ 없는 아이템을 떨어뜨린다", "enemies", (d) => {
      (d.ashen_pages as Record<string, unknown>).drops = [{ itemId: "없는물약", qty: 1, chance: 1 }];
    }, "선언되지 않은 아이템"],
    ["모르는 필드 (오타)", "enemies", (d) => { (d.ashen_pages as Record<string, unknown>).maxHP = 50; }, "maxHP"],
    ["★ potion 인데 heal 이 없다", "items", (d) => { (d.minor_potion as Record<string, unknown>).heal = null; }, "heal"],
    ["trophy 인데 heal 이 있다", "items", (d) => { (d.warden_shard as Record<string, unknown>).heal = 5; }, "heal"],
    ["치명타 확률이 1을 넘는다", "player", (d) => { d.critChance = 2; }, "critChance"],
    ["스킬 종류가 오타", "skills", (d) => { (d.mend as Record<string, unknown>).kind = "healz"; }, "kind"],
  ];
  for (const [label, file, mutate, needle] of cases) {
    const why = refuses(broken(file, mutate));
    check(label, why !== null && why.includes(needle), why ?? "통과해 버렸다");
  }
  const missing = mkdtempSync(join(tmpdir(), "bal-"));
  check("파일이 아예 없으면 그렇게 말한다",
    (refuses(missing) ?? "").includes("읽을 수 없다"));

  section("③ 배치와 정의는 다른 것이다 (부팅에서 짝을 본다)");
  const noSuchEnemy = broken("enemies", (d) => { delete d.ashen_pages; });
  let bootFailed = "";
  try {
    boot(DB, PORT, { llm: "off", balance: loadBalance(noSuchEnemy) }).close();
  } catch (err) {
    bootFailed = err instanceof Error ? err.message : String(err);
  }
  rmSync(noSuchEnemy, { recursive: true, force: true });
  check("★ 배치된 적이 정의에 없으면 서버가 뜨지 않는다",
    bootFailed.includes("ashen_pages"), bootFailed || "떴다");

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
