/* 계정. 마이그레이션 006 과 hello 의 auth 갈래 전부.
 *
 * 확인하는 것:
 *   덧옷    계정을 만들면 지금 캐릭터가 그대로 계정의 것이 된다 (새 시작이 아니다)
 *   무덤    묶이는 순간 옛 익명 토큰이 죽는다 — 안 죽으면 계정이 자물쇠가 아니다
 *   기기    한 캐릭터가 여러 기기 토큰을 들고, 상한을 넘으면 오래된 것이 축출된다
 *   오라클  모르는 이름과 틀린 비밀번호가 같은 문장이고 같은 시간이다
 *   경계    기기 토큰의 miss 가 익명 토큰의 miss 와 같은 경로로 흐른다
 *   저장    비밀번호가 평문으로 어디에도 남지 않는다
 *
 * ★ 이 검사는 실제 scrypt 를 돈다 (해시 한 번에 ~95ms). 그게 요점이다 —
 *   파라미터를 낮춰 검사하면 '이벤트 루프를 막지 않는가' 를 못 본다.
 */

import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { boot } from "../server/index";
import { FIXTURE_WORLD, FIXTURE_BALANCE, FIXTURE_MOODS } from "./fixture";
import { PROTOCOL_VERSION, type ServerMsg } from "../shared/protocol";
import { hashSecret, nameKeyOf, verifySecret } from "../server/net/secret";
import { MAX_DEVICES, resolveAuth } from "../server/net/accounts";

const FIXTURE = { world: FIXTURE_WORLD, balance: FIXTURE_BALANCE, moods: FIXTURE_MOODS } as const;
const PORT = 8914;
const DB = join(tmpdir(), `mud-accounts-${process.pid}.db`);

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

type Auth = { kind: "register" | "login"; name: string; password: string };

/** 한 번 붙어서 welcome/error 를 받아 오는 것이 이 파일의 기본 단위다.
 *  계정은 hello 의 일부라, '로그인' 은 곧 자격을 들고 붙는 것이다. */
async function hello(
  token: string | null,
  auth?: Auth,
): Promise<{ welcome?: Extract<ServerMsg, { t: "welcome" }>; snapshot?: Extract<ServerMsg, { t: "snapshot" }>; error?: Extract<ServerMsg, { t: "error" }> }> {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  await new Promise<void>((res, rej) => {
    ws.once("open", () => res());
    ws.once("error", rej);
  });
  const inbox: ServerMsg[] = [];
  ws.on("message", (d) => inbox.push(JSON.parse(String(d)) as ServerMsg));
  ws.send(JSON.stringify({ t: "hello", pv: PROTOCOL_VERSION, token, name: null, ...(auth ? { auth } : {}) }));
  const deadline = Date.now() + 5000;
  for (;;) {
    const err = inbox.find((m): m is Extract<ServerMsg, { t: "error" }> => m.t === "error");
    const snap = inbox.find((m): m is Extract<ServerMsg, { t: "snapshot" }> => m.t === "snapshot");
    if (err || snap) {
      ws.close();
      return {
        welcome: inbox.find((m): m is Extract<ServerMsg, { t: "welcome" }> => m.t === "welcome"),
        snapshot: snap,
        error: err,
      };
    }
    if (Date.now() > deadline) {
      ws.close();
      return {};
    }
    await sleep(10);
  }
}

async function main() {
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
  const server = boot(DB, PORT, { ...FIXTURE, llm: "off" });
  const q = server.ctx.q;

  // ── ① 저장 형식 ─────────────────────────────────────────────────────
  section("① 저장 형식이 자기를 설명한다 (PHC)");
  const stored = await hashSecret("열려라 참깨");
  check("scrypt 이고 파라미터가 문자열 안에 있다",
    /^scrypt\$N=\d+,r=\d+,p=\d+\$/.test(stored), stored.slice(0, 40));
  check("★ 평문이 어디에도 없다", !stored.includes("열려라"), stored.slice(0, 60));
  check("맞는 비밀번호를 통과시킨다", (await verifySecret("열려라 참깨", stored)).ok);
  check("틀린 비밀번호를 거절한다", !(await verifySecret("틀렸다", stored)).ok);
  check("같은 비밀번호도 매번 다른 저장값이다 (salt)",
    (await hashSecret("열려라 참깨")) !== stored);
  /* 형식이 깨져 있어도 던지지 않는다 — 던지면 '그 계정은 있는데 저장이
     이상하다' 가 예외의 유무로 새어 나간다. */
  check("★ 깨진 저장값에도 던지지 않고 거짓을 돌려준다",
    !(await verifySecret("x", "쓰레기")).ok && !(await verifySecret("x", "scrypt$$$")).ok);
  check("이름 키는 NFKC + 소문자다 (DDL 의 CHECK 와 짝)",
    nameKeyOf("  Ｙｕｓｔｉｎａ  ") === "yustina", nameKeyOf("  Ｙｕｓｔｉｎａ  "));

  // ── ② 덧옷 ─────────────────────────────────────────────────────────
  section("② 계정은 덧옷이다 — 지금 캐릭터가 그대로 계정의 것이 된다");
  const anon = await hello(null);
  const anonToken = anon.welcome!.token;
  const anonId = anon.welcome!.self.id;
  check("익명으로 들어왔다", Boolean(anonId) && anon.snapshot!.self.account === null);
  // 이 캐릭터를 알아볼 흔적 하나 — 계정을 만든 뒤에도 남아야 한다.
  q.addItem.run({ player_id: anonId, item_id: "minor_potion", qty: 3, now: 1 });

  const reg = await hello(anonToken, { kind: "register", name: "유스티나", password: "열려라참깨여덟자" });
  check("★ 같은 캐릭터다 (새로 시작하지 않았다)", reg.welcome!.self.id === anonId,
    `${reg.welcome!.self.id} vs ${anonId}`);
  check("★ 가방도 그대로다", reg.snapshot!.self.items.find((i) => i.id === "minor_potion")?.qty === 3,
    JSON.stringify(reg.snapshot!.self.items));
  check("계정 이름이 와이어에 온다 (서버가 붙인 원형)",
    reg.snapshot!.self.account === "유스티나", String(reg.snapshot!.self.account));
  check("DB 에서도 묶여 있다",
    q.playersOfAccount.all(q.accountByNameKey.get("유스티나")!.id).some((p) => p.id === anonId));
  check("★ 비밀번호가 평문으로 DB 에 없다",
    !q.accountByNameKey.get("유스티나")!.secret.includes("열려라참깨여덟자"));

  const accountToken = reg.welcome!.token;
  check("새 기기 토큰을 받았다 (옛 토큰과 다르다)", accountToken !== anonToken);

  // ── ③ 무덤 토큰 ────────────────────────────────────────────────────
  section("③ 묶이는 순간 옛 익명 토큰이 죽는다");
  /* ★ 이게 없으면 계정이 자물쇠가 아니다. 예전 토큰을 아는 사람은 비밀번호
     없이 그 캐릭터를 계속 연다 — 계정을 만든 의미가 사라진다. */
  const zombie = await hello(anonToken);
  check("★ 옛 토큰은 그 캐릭터를 더 이상 열지 못한다",
    zombie.welcome!.self.id !== anonId, `${zombie.welcome!.self.id} vs ${anonId}`);
  check("모르는 토큰과 똑같이 '신규 생성' 으로 흡수된다 (오라클 아님)",
    zombie.snapshot!.self.account === null && zombie.snapshot!.self.items.length === 0);

  // ── ④ 로그인 ───────────────────────────────────────────────────────
  section("④ 로그인 — 다른 기기에서 같은 캐릭터로");
  const login = await hello(null, { kind: "login", name: "유스티나", password: "열려라참깨여덟자" });
  check("★ 토큰 없이도 같은 캐릭터로 들어온다", login.welcome!.self.id === anonId);
  check("가방도 따라온다",
    login.snapshot!.self.items.find((i) => i.id === "minor_potion")?.qty === 3);
  check("이름의 대소문자·공백은 정규화된다",
    (await hello(null, { kind: "login", name: "  유스티나  ", password: "열려라참깨여덟자" }))
      .welcome!.self.id === anonId);

  // ── ⑤ 오라클 ───────────────────────────────────────────────────────
  section("⑤ 로그인 거절은 아무것도 흘리지 않는다");
  const t0 = Date.now();
  const wrongPw = await hello(null, { kind: "login", name: "유스티나", password: "틀린비밀번호여덟자" });
  const dtKnown = Date.now() - t0;
  const t1 = Date.now();
  const noSuch = await hello(null, { kind: "login", name: "없는사람", password: "틀린비밀번호여덟자" });
  const dtUnknown = Date.now() - t1;
  /* ★ 이 절이 헛돌지 않는지 먼저 본다. 비밀번호가 형식에서 걸리면 두 요청이
     계정 조회에 닿기도 전에 같은 문장으로 돌아가, 아래 검사가 전부 공회전한다
     (실제로 그렇게 짰다가 돌연변이가 통과했다). */
  check("(전제) 형식 검사에 걸리지 않았다 — 계정 조회까지 갔다",
    wrongPw.error!.message !== "비밀번호가 너무 짧거나 깁니다." &&
      noSuch.error!.message !== "비밀번호가 너무 짧거나 깁니다.",
    JSON.stringify([wrongPw.error!.message, noSuch.error!.message]));
  check("둘 다 error{auth_failed} 다",
    wrongPw.error?.code === "auth_failed" && noSuch.error?.code === "auth_failed",
    JSON.stringify([wrongPw.error?.code, noSuch.error?.code]));
  /* ★ 글자 그대로 같아야 한다. 갈라지면 그 자체가 이름 열거 오라클이다. */
  check("★ 모르는 이름과 틀린 비밀번호가 같은 문장이다",
    wrongPw.error!.message === noSuch.error!.message,
    JSON.stringify([wrongPw.error!.message, noSuch.error!.message]));
  /* ★ 시간도. 없는 이름에 즉시 돌아가면 '그 이름이 있는가' 가 타이밍으로
     샌다. 그래서 모르는 이름에도 더미 해시를 대조한다.
     ★ 와이어로 재면 안 된다 — 소켓 왕복이 수십 ms 라 scrypt(≈95ms)를 통째로
       빼도 비율이 크게 안 변한다. 실제로 그렇게 재 봤더니 더미 해시를 지운
       돌연변이가 초록으로 통과했다. resolveAuth 를 직접 부른다. */
  const say = {
    badName: "n",
    badPassword: "p",
    taken: "t",
    refused: "r",
  };
  const timed = async (n: string): Promise<number> => {
    const at = Date.now();
    await resolveAuth(q, (fn) => fn(), { kind: "login", name: n, password: "틀린비밀번호여덟자" },
      null, 1, say);
    return Date.now() - at;
  };
  const known = await timed("유스티나");
  const unknown = await timed("없는사람");
  check("★ 없는 이름에도 같은 시간이 든다 (더미 해시를 돈다)",
    unknown > known * 0.5, `있는 이름 ${known}ms · 없는 이름 ${unknown}ms`);
  void dtKnown;
  void dtUnknown;
  check("거절은 재접속을 부르지 않는다 (같은 실패를 무한 반복한다)",
    wrongPw.error!.reconnect === false);
  check("가입만이 이름의 존재를 알려 준다 (가입의 본질이라 감수한다)",
    (await hello(null, { kind: "register", name: "유스티나", password: "열려라참깨여덟자" })).error!
      .message !== wrongPw.error!.message);

  // ── ⑥ 형식 ─────────────────────────────────────────────────────────
  section("⑥ 형식이 틀리면 계정을 만들지 않는다");
  const short = await hello(null, { kind: "register", name: "짧은비번", password: "1234" });
  check("짧은 비밀번호는 거절된다", short.error?.code === "auth_failed");
  check("★ 거절됐으면 계정도 안 생겼다", q.accountByNameKey.get("짧은비번") === undefined);
  const blank = await hello(null, { kind: "register", name: "   ", password: "열려라참깨여덟자" });
  check("빈 이름도 거절된다", blank.error?.code === "auth_failed");
  const bad = await hello(null, { kind: "register", name: "x", password: "열려라참깨여덟자" } as Auth);
  check("(대조) 형식이 맞으면 만들어진다", bad.error === undefined && bad.welcome !== undefined);

  // ── ⑦ 기기 ─────────────────────────────────────────────────────────
  section("⑦ 기기 토큰 — 폰과 노트북이 함께 산다");
  const dev1 = (await hello(null, { kind: "login", name: "유스티나", password: "열려라참깨여덟자" }))
    .welcome!.token;
  const dev2 = (await hello(null, { kind: "login", name: "유스티나", password: "열려라참깨여덟자" }))
    .welcome!.token;
  check("로그인마다 다른 기기 토큰이 나온다", dev1 !== dev2);
  check("★ 둘 다 같은 캐릭터를 연다 (하나가 다른 하나를 죽이지 않는다)",
    (await hello(dev1)).welcome!.self.id === anonId &&
      (await hello(dev2)).welcome!.self.id === anonId);
  // 상한을 넘겨 본다.
  for (let i = 0; i < MAX_DEVICES + 2; i++) {
    await hello(null, { kind: "login", name: "유스티나", password: "열려라참깨여덟자" });
  }
  check(`★ 기기 토큰이 상한(${MAX_DEVICES})을 넘지 않는다`,
    q.deviceTokensOf.all(anonId).length === MAX_DEVICES,
    String(q.deviceTokensOf.all(anonId).length));
  check("★ 축출된 옛 토큰은 더 이상 열지 못한다 (신규 생성으로 흡수)",
    (await hello(dev1)).welcome!.self.id !== anonId);

  // ── ⑧ 경계 ─────────────────────────────────────────────────────────
  section("⑧ 기기 토큰의 miss 는 익명 토큰의 miss 와 같은 경로다");
  /* ★ 새 캐릭터는 IP 당 10분에 5개다 (실제 방어책이라 무르지 않는다).
     그래서 이 절은 딱 하나만 더 만든다 — 위의 zombie(무덤 토큰)가 이미
     '죽은 토큰 -> 신규 생성' 을 보였고, 여기서 남은 것은 '형식만 맞는 모르는
     토큰' 갈래다. 두 갈래가 같은 곳으로 흘러야 오라클이 안 생긴다. */
  const fake = "f".repeat(64);
  const a = await hello(fake);
  check("★ 모르는 토큰도 오류가 아니라 신규 생성이다 (토큰 존재 오라클 없음)",
    a.error === undefined && a.welcome !== undefined && a.welcome.self.id !== anonId,
    JSON.stringify(a.error));
  check("익명이다 (계정도 가방도 없다)",
    a.snapshot!.self.account === null && a.snapshot!.self.items.length === 0);
  check("★ 무덤 토큰과 모르는 토큰이 같은 곳으로 흐른다 (둘 다 새 캐릭터)",
    zombie.snapshot!.self.account === null && a.snapshot!.self.account === null);

  // ── ⑨ 영속 ─────────────────────────────────────────────────────────
  section("⑨ 서버를 내렸다 올려도 계정이 남는다");
  await server.close();
  await sleep(80);
  const again = boot(DB, PORT, { ...FIXTURE, llm: "off" });
  const back = await hello(null, { kind: "login", name: "유스티나", password: "열려라참깨여덟자" });
  check("★ 재시작 뒤에도 로그인된다", back.welcome!.self.id === anonId);
  check("계정 이름도 그대로다", back.snapshot!.self.account === "유스티나");
  check("스키마 버전이 6 이다",
    again.ctx.q.getMeta.get("schema_version")?.value === "6",
    String(again.ctx.q.getMeta.get("schema_version")?.value));
  await again.close();

  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
  console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${checks - failures}/${checks} 검사 통과`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
