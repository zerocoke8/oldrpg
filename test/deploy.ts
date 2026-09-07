/* 배포 배관. "친구가 링크를 열면 실제로 게임이 뜨는가" 를 확인한다.
 *
 * 확인하는 것:
 *   한 포트   정적 파일과 ws 업그레이드가 같은 오리진에서 처리된다
 *             (HTTPS 에서 ws:// 가 mixed content 로 차단되는 것을 막는 유일한 길)
 *   경로 탈출 dist/ 밖의 파일은 절대 나가지 않는다
 *   IP 예산   프록시 뒤에서 무너지지 않고, 거절이 카운터를 영구히 적립하지 않는다
 *   선생성    운영 시작 전에 초기 문장을 전부 박아 둘 수 있고, 여러 번 돌려도 안전하다 */

import { mkdirSync, rmSync, writeFileSync, existsSync, renameSync, readFileSync, cpSync, statSync, symlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { build } from "vite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import WebSocket from "ws";
import { boot } from "../server/index";
import { FIXTURE_WORLD, FIXTURE_BALANCE, FIXTURE_MOODS } from "./fixture";

/** 모든 boot() 가 같은 고정 세계를 쓴다 — 운영 콘텐츠가 바뀌어도 검사는 그대로다. */
const FIXTURE = { world: FIXTURE_WORLD, balance: FIXTURE_BALANCE, moods: FIXTURE_MOODS } as const;

/** ⓪ 가 Dockerfile·.dockerignore 와 대조하는 쪽. 값이 여러 파일에 흩어져 있다. */
const PKG = JSON.parse(readFileSync("package.json", "utf8")) as {
  scripts: Record<string, string>;
  dependencies?: Record<string, string>;
  engines?: { node?: string };
};
import { runPregen } from "../server/tools/pregen";
import { runBackup } from "../server/tools/backup";
import { runRestore } from "../server/tools/restore";
import { openDb } from "../server/db/open";
import { makeQueries } from "../server/db/queries";
import { PROTOCOL_VERSION, type ServerMsg } from "../shared/protocol";
import type { NpcLineRequest, RoomTextRequest } from "../shared/narration";

const PORT = 8909;
const DB = join(tmpdir(), `mud-deploy-${process.pid}.db`);
const BASE = `http://127.0.0.1:${PORT}`;

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

/** hello 까지 마친 소켓 하나. */
async function connect(path = "/ws"): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}${path}`);
  await new Promise<void>((res, rej) => {
    ws.once("open", () => res());
    ws.once("error", rej);
  });
  return ws;
}

async function main() {
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });

  /* ── ⓪ 이미지 표면 — 도커 데몬 없이 확인할 수 있는 것 ────────────────
   *
   * ★ 무엇이 이 절을 만들었나: Dockerfile 이 content/ 를 복사하지 않아
   *   **이미지가 100% 시작 실패**하고 있었다. boot() 은 DB 를 열기도 전에
   *   loadBalance()/loadWorld() 를 부르고(server/index.ts), 그 둘의
   *   DEFAULT_DIR 은 `<module>/../../content/...` = `/app/content/...` 이다.
   *   기존 34개 검사가 전부 boot() 을 in-process 로 부르므로, '이미지에
   *   파일이 안 들어갔다' 는 구조적으로 볼 수 없었다.
   *
   * ★ 여기서 확인하지 '못하는' 것 (초록이어도 이미지가 뜬다는 증명이 아니다):
   *     이미지 레이어 캐시 · apt 로 python3/make/g++ 이 실제로 깔리는가 ·
   *     better-sqlite3 가 prebuild 로 받아지는가 컴파일되는가 · 최종 크기 ·
   *     USER node 와 볼륨 마운트 지점의 소유권 · EXPOSE 와 실제 포트 매핑 ·
   *     .dockerignore 를 도커 데몬이 해석한 결과 · npm ci 가 받는 것.
   *   도커 데몬이 있는 곳에서 한 번은 진짜로 빌드해 봐야 한다.
   *
   * ★ ⓪-e 는 **실제 content/** 를 읽는다. 픽스처를 주입하면 'content/ 가
   *   이미지에 있는가' 라는 질문 자체가 사라지기 때문이다. 그래서
   *   test/deploy.ts 는 CLAUDE.md 가 이름 붙인 넷(world·regions·balance·
   *   author)에 이은 다섯 번째 운영 콘텐츠 독자다 — 사고가 아니라 의도다.
   *   보는 것은 '경로가 있는가' 뿐이고 방의 수도 씨앗도 보지 않는다. */
  section("⓪ 이미지 표면 — 도커 데몬 없이 확인할 수 있는 것");
  const dockerfile = readFileSync("Dockerfile", "utf8");
  const dfLines = dockerfile.split("\n");
  const froms = dfLines.flatMap((l) => /^FROM\s+(\S+)/.exec(l)?.[1] ?? []);
  /** COPY --from=build <src> <dest> 의 목적지들. "./server" -> "server".
   *  목적지가 "./" 면 원본의 파일명이 그대로 이름이 된다 (package.json). */
  const copyDests = dfLines
    .flatMap((l) => {
      const m = /^COPY\s+--from=build\s+(\S+)\s+(\S+)/.exec(l);
      if (!m) return [];
      const dest = m[2]!.replace(/^\.\//, "").replace(/\/$/, "");
      return [dest || m[1]!.split("/").pop()!];
    });
  /** ENV 는 백슬래시로 이어진다 — 이어 붙인 뒤 KEY=VALUE 를 전부 긁는다. */
  const envBlock = dockerfile.replace(/\\\n\s*/g, " ");
  const envOf = (k: string): string | undefined =>
    new RegExp(`\\b${k}=(\\S+)`).exec(envBlock)?.[1];
  const expose = /^EXPOSE\s+(\d+)/m.exec(dockerfile)?.[1];
  const mkdirTarget = /^RUN mkdir -p (\S+)/m.exec(dockerfile)?.[1];
  const cmd = JSON.parse(/^CMD\s+(\[.*\])/m.exec(dockerfile)?.[1] ?? "[]") as string[];
  const healthPath = /fetch\('http:\/\/[^']*?'\+[^+]*\+'(\/[a-z]+)'/.exec(dockerfile)?.[1];

  // ⓪-a 자기 정합 — 값이 여러 파일에 흩어져 있고 어긋나도 아무도 안 알려 준다.
  check("★ 빌드와 실행의 베이스 이미지가 글자 그대로 같다 (네이티브 ABI)",
    froms.length === 2 && froms[0] === froms[1], JSON.stringify(froms));
  check("CMD 의 진입점이 COPY 트리 안에 실재한다",
    Boolean(cmd.at(-1)) && existsSync(cmd.at(-1)!) &&
      copyDests.includes(cmd.at(-1)!.split("/")[0]!),
    JSON.stringify({ cmd, copyDests }));
  check("CMD 가 package.json 의 start 와 같다 (로컬에서만 되는 서버가 아니다)",
    cmd.join(" ") === PKG.scripts.start, `${cmd.join(" ")} vs ${PKG.scripts.start}`);
  check("ENV MUD_PORT 와 EXPOSE 가 같다", envOf("MUD_PORT") === expose,
    `${envOf("MUD_PORT")} vs ${expose}`);
  check("★ MUD_DB 의 디렉터리가 mkdir 대상과 같다 (USER node 아래 SQLITE_CANTOPEN)",
    envOf("MUD_DB")?.replace(/\/[^/]+$/, "") === mkdirTarget,
    `${envOf("MUD_DB")} vs ${mkdirTarget}`);
  check("HEALTHCHECK 가 부르는 경로를 정적 서버가 실제로 처리한다",
    Boolean(healthPath) && readFileSync("server/net/static.ts", "utf8").includes(`"${healthPath}"`),
    String(healthPath));
  check("engines.node 의 메이저가 FROM 태그와 같다",
    /(\d+)/.exec(PKG.engines?.node ?? "")?.[1] === /:(\d+)/.exec(froms[0] ?? "")?.[1],
    `${PKG.engines?.node} vs ${froms[0]}`);

  /* ⓪-b 빌드 입력이 컨텍스트에 들어가는가. 런타임 COPY 가 아무리 맞아도
     컨텍스트에서 빠지면 `COPY . .` 이 못 가져가고 빌드가 죽는다. */
  check("빌드 스테이지가 COPY 하는 두 파일이 실재한다",
    existsSync("package.json") && existsSync("package-lock.json"));
  const ignorePatterns = readFileSync(".dockerignore", "utf8")
    .split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  /** 보수적 매처. 세그먼트 수가 같을 때만 글롭을 풀고, 조상 접두사도 본다. */
  const ignored = (path: string): boolean => {
    const segs = path.split("/");
    for (let i = 1; i <= segs.length; i++) {
      const prefix = segs.slice(0, i).join("/");
      const pSegs = prefix.split("/");
      for (const pat of ignorePatterns) {
        const patSegs = pat.replace(/^\//, "").split("/");
        if (patSegs.length !== pSegs.length) continue;
        const re = new RegExp(
          "^" + patSegs.map((x) =>
            x.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]"),
          ).join("/") + "$",
        );
        if (re.test(prefix)) return true;
      }
    }
    return false;
  };
  /* ★ 모르는 문법이면 통과가 아니라 실패다. 모델하지 않는 것을 조용히
     통과시키면 이 검사가 거짓 확신을 판다. */
  check("★ .dockerignore 에 이 매처가 모르는 문법이 없다 (! 부정 · ** 재귀)",
    !ignorePatterns.some((p) => p.startsWith("!") || p.includes("**")),
    JSON.stringify(ignorePatterns));
  check("빌드에 필요한 트리가 컨텍스트에서 빠지지 않았다",
    !["server", "shared", "content", "package.json", "package-lock.json"].some(ignored),
    JSON.stringify(ignorePatterns));
  check("(대조) dist 는 컨텍스트에서 빠진다 — 빌드 스테이지가 다시 만든다",
    ignored("dist"));

  /* ⓪-c 런타임이 fs 로 읽는 뿌리가 전부 COPY 트리 안에 있는가.
     갱신법: grep -rn "readFileSync\|readdirSync\|createReadStream" server/ */
  const FS_ROOTS: { path: string; why: string }[] = [
    { path: "server/db/schema.sql", why: "migrate.ts 가 첫 부팅에 통째로 실행한다" },
    { path: "server/db/migrations", why: "migrate.ts 가 버전마다 읽는다" },
    { path: "server/narration/prompts", why: "prompts.ts — 프롬프트·톤·무드·목소리" },
    { path: "dist", why: "net/static.ts 의 MUD_STATIC 기본값" },
    { path: "content/world", why: "content/world.ts 의 DEFAULT_DIR" },
    { path: "content/balance", why: "content/balance.ts 의 DEFAULT_DIR" },
  ];
  for (const r of FS_ROOTS) {
    check(`런타임이 읽는 ${r.path} 가 이미지에 들어간다 (${r.why})`,
      copyDests.includes(r.path.split("/")[0]!) && existsSync(r.path),
      JSON.stringify(copyDests));
  }

  /* ⓪-d prune --omit=dev 뒤에도 남아야 할 것이 dependencies 에 있는가. */
  const bare = new Set<string>();
  const seenFiles = new Set<string>();
  const resolveRel = (from: string, spec: string): string | null => {
    const base = join(from, "..", spec);
    for (const cand of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
      if (existsSync(cand) && statSync(cand).isFile()) return cand;
    }
    return null;
  };
  const walkImports = (file: string): void => {
    if (seenFiles.has(file)) return;
    seenFiles.add(file);
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)) {
      const spec = m[1]!;
      if (spec.startsWith("node:")) continue;
      if (spec.startsWith(".")) {
        const next = resolveRel(file, spec);
        if (next) walkImports(next);
        continue;
      }
      bare.add(spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!);
    }
  };
  walkImports("server/index.ts");
  /** dependencies 의 폐포. 하위 프로세스 없이 node_modules 를 걸어서 닫는다. */
  const prodClosure = new Set<string>();
  const queue = Object.keys(PKG.dependencies ?? {});
  while (queue.length) {
    const name = queue.shift()!;
    if (prodClosure.has(name)) continue;
    const meta = join("node_modules", name, "package.json");
    if (!existsSync(meta)) continue; // optionalDependencies 의 타플랫폼 바이너리
    prodClosure.add(name);
    const m = JSON.parse(readFileSync(meta, "utf8")) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    queue.push(...Object.keys(m.dependencies ?? {}), ...Object.keys(m.optionalDependencies ?? {}));
  }
  check("★ 런타임이 import 하는 패키지가 전부 프로덕션 폐포 안에 있다",
    [...bare].every((b) => prodClosure.has(b)),
    JSON.stringify([...bare].filter((b) => !prodClosure.has(b))));
  /* ★ tsx 는 import 그래프에 안 나타난다 — CMD 가 --import 로 로더를 붙인다.
     없으면 컨테이너가 ERR_MODULE_NOT_FOUND 로 즉사하는데 아무도 못 잡는다.
     폐포의 '개수' 는 단언하지 않는다 — npm 버전에 따라 흔들린다. */
  check("★ tsx 가 프로덕션 폐포 안에 있다 (CMD 의 --import 로더)",
    prodClosure.has("tsx"), JSON.stringify([...prodClosure].sort().slice(0, 12)));

  /* ⓪-e 그 트리로 진짜 부팅한다. ⓪-c 는 손으로 적은 표라 새 뿌리가 생기면
     조용히 낡는다 — 이 절이 그 표가 무엇을 빠뜨렸든 실제 실패로 드러낸다.
     ★ server/shared/content 를 심링크로 때우면 안 된다. node 가 ESM 을
       realpath 로 해소해 import.meta.url 이 저장소의 실제 경로가 되고,
       ../../content 가 저장소의 content/ 를 가리켜 **트리에 없어도 초록**이
       된다. node_modules 만 심링크한다 (패키지 해소는 importer 의 realpath
       에서 위로 올라가므로 폐포 밖으로 새지 않는다). */
  const IMG = join(tmpdir(), `mud-img-${process.pid}`);
  const IMG_DB = join(tmpdir(), `mud-img-${process.pid}.db`);
  rmSync(IMG, { recursive: true, force: true });
  for (const dest of copyDests) {
    if (dest === "node_modules") continue;
    if (dest === "dist") continue; // 아래에서 가짜 한 줄로 짓는다
    cpSync(dest, join(IMG, dest), { recursive: true });
  }
  mkdirSync(join(IMG, "dist"), { recursive: true });
  writeFileSync(join(IMG, "dist/index.html"), "<!doctype html><title>img</title>");
  mkdirSync(join(IMG, "node_modules"), { recursive: true });
  for (const name of [...prodClosure].sort()) {
    const dst = join(IMG, "node_modules", name);
    mkdirSync(join(dst, ".."), { recursive: true });
    if (!existsSync(dst)) symlinkSync(resolve("node_modules", name), dst, "dir");
  }
  const IMG_PORT = PORT + 1;
  const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    cwd: IMG,
    env: { ...process.env, MUD_PORT: String(IMG_PORT), MUD_DB: IMG_DB, MUD_NO_LLM: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let childErr = "";
  child.stderr.on("data", (d) => (childErr += String(d)));
  child.stdout.on("data", (d) => (childErr += String(d)));
  let exitCode: number | null = null;
  child.on("exit", (c) => (exitCode = c));
  let healthy = false;
  for (let i = 0; i < 75 && !healthy && exitCode === null; i++) {
    await sleep(200);
    try {
      const r = await fetch(`http://127.0.0.1:${IMG_PORT}/healthz`);
      healthy = r.status === 200 && (await r.text()) === "ok";
    } catch {
      /* 아직 안 떴다 */
    }
  }
  check("★ COPY 하는 트리만으로 서버가 실제로 뜬다 (/healthz 200)", healthy,
    childErr.slice(-600));
  if (healthy) {
    const root = await fetch(`http://127.0.0.1:${IMG_PORT}/`);
    check("그 트리에서 정적 파일도 나간다", root.status === 200);
  } else {
    check("그 트리에서 정적 파일도 나간다", false, "부팅 실패로 확인 불가");
  }
  child.kill("SIGTERM");
  for (let i = 0; i < 50 && exitCode === null; i++) await sleep(100);
  check("★ SIGTERM 에 우아하게 exit 0 (CMD 가 래퍼 프로세스가 아니다)",
    exitCode === 0, `exit=${exitCode} ${childErr.slice(-300)}`);
  if (exitCode === null) child.kill("SIGKILL");
  rmSync(IMG, { recursive: true, force: true });
  for (const f of [IMG_DB, `${IMG_DB}-wal`, `${IMG_DB}-shm`]) rmSync(f, { force: true });

  /* ⓪-f fly.toml 은 있으면 본다. 없으면 skip 한 줄 — 세 값이 세 파일에
     흩어지므로, 파일이 생기는 순간부터 묶이게 미리 놓아 둔다. */
  if (!existsSync("fly.toml")) {
    console.log("  skip fly.toml 이 없다 — 생기면 mounts.destination · internal_port · 헬스체크 경로를 대조한다");
  } else {
    const fly = readFileSync("fly.toml", "utf8");
    /** TOML 은 작은따옴표와 큰따옴표를 둘 다 쓴다 (fly launch 는 작은따옴표를
     *  낸다). 파서를 새로 들이지 않는 대신 둘 다 받는다. */
    const flyStr = (key: string): string | undefined =>
      new RegExp(`^\\s*${key}\\s*=\\s*['"]([^'"]+)['"]`, "m").exec(fly)?.[1];
    const flyNum = (key: string): string | undefined =>
      new RegExp(`^\\s*${key}\\s*=\\s*(\\d+)`, "m").exec(fly)?.[1];
    check("fly 의 볼륨 목적지가 MUD_DB 의 디렉터리와 같다",
      flyStr("destination") === envOf("MUD_DB")?.replace(/\/[^/]+$/, ""),
      `${flyStr("destination")} vs ${envOf("MUD_DB")}`);
    check("fly 의 internal_port 가 EXPOSE 와 같다", flyNum("internal_port") === expose,
      `${flyNum("internal_port")} vs ${expose}`);
    check("fly 의 헬스체크 경로가 정적 서버가 처리하는 것과 같다",
      flyStr("path") === healthPath, `${flyStr("path")} vs ${healthPath}`);
    /* ★ 이 앱은 하나만 돌아야 한다 (Dockerfile 머리 주석). 머신이 잠들면
       메모리의 권위 상태가 통째로 사라진다 — 비용 설정이 아니라 게임성이다. */
    check("★ 머신이 잠들지 않는다 (auto_stop_machines = off)",
      flyStr("auto_stop_machines") === "off", fly.match(/auto_stop_machines.*/)?.[0] ?? "없음");
    check("★ 항상 하나는 떠 있다 (min_machines_running >= 1)",
      Number(flyNum("min_machines_running") ?? 0) >= 1,
      fly.match(/min_machines_running.*/)?.[0] ?? "없음");
  }

  /* ★ 이 테스트는 dist/ 를 통째로 소유한다. 이미 있으면 치워 두고, 앞 절들은
     '아는 내용' 의 가짜 dist 로 돌고, ⑦ 에서만 진짜로 빌드한다. 그러지 않으면
     앞선 빌드가 남아 있느냐에 따라 결과가 달라진다 (실제로 그렇게 깨졌다). */
  const stashed = existsSync("dist") ? "dist.bak-test" : null;
  if (stashed) {
    rmSync(stashed, { recursive: true, force: true });
    renameSync("dist", stashed);
  }
  mkdirSync("dist/assets", { recursive: true });
  writeFileSync("dist/index.html", "<!doctype html><title>지하 1층</title><div id=root></div>");
  writeFileSync("dist/assets/index-TEST123.js", "console.log('bundle')");
  writeFileSync("secret-not-served.txt", "이 파일은 dist 밖에 있다");

  const server = boot(DB, PORT, { ...FIXTURE,  llm: "off" });

  section("① 정적 파일과 ws 가 같은 포트에서 산다");
  const index = await fetch(`${BASE}/`);
  check("/ 가 index.html 을 준다", index.status === 200, String(index.status));
  check("HTML 로 준다", (index.headers.get("content-type") ?? "").includes("text/html"),
    String(index.headers.get("content-type")));
  check("★ index.html 은 캐시하지 않는다 (캐시되면 배포해도 옛 번들을 부른다)",
    (index.headers.get("cache-control") ?? "").includes("no-cache"),
    String(index.headers.get("cache-control")));

  const asset = await fetch(`${BASE}/assets/index-TEST123.js`);
  check("해시 박힌 자산을 준다", asset.status === 200);
  check("그건 영구 캐시한다", (asset.headers.get("cache-control") ?? "").includes("immutable"),
    String(asset.headers.get("cache-control")));
  check("자바스크립트로 준다",
    (asset.headers.get("content-type") ?? "").includes("javascript"),
    String(asset.headers.get("content-type")));

  const health = await fetch(`${BASE}/healthz`);
  check("헬스체크가 산다 (배포 플랫폼이 이걸 본다)",
    health.status === 200 && (await health.text()) === "ok");

  const spa = await fetch(`${BASE}/아무거나/새로고침`);
  check("모르는 경로도 index.html (새로고침이 404 가 되지 않는다)", spa.status === 200);

  section("② dist/ 밖은 절대 나가지 않는다");
  for (const evil of [
    "/../secret-not-served.txt",
    "/../../etc/passwd",
    "/..%2fsecret-not-served.txt",
    "/assets/../../secret-not-served.txt",
  ]) {
    const r = await fetch(`${BASE}${evil}`);
    const body = await r.text();
    check(`경로 탈출을 막는다: ${evil}`,
      !body.includes("dist 밖에 있다") && !body.includes("root:x:"),
      `${r.status} ${body.slice(0, 40)}`);
  }

  section("③ ws 는 /ws 에서만 받는다");
  const ok = await connect("/ws");
  check("/ws 로는 붙는다", ok.readyState === WebSocket.OPEN);
  ok.close();
  let rejected = false;
  try {
    const bad = await connect("/nope");
    bad.close();
  } catch {
    rejected = true;
  }
  check("다른 경로의 업그레이드는 거절한다", rejected);

  section("④ IP 예산 — 거절이 카운터를 영구히 적립하지 않는다");
  /* 예전에는 상한 검사에서 return 한 뒤 한참 아래에서 close 리스너를 달았다.
     그래서 거절될 때마다 +1 이 영구히 남았고, 프록시 뒤에서는 모두가 한 버킷이라
     누적 거절이 상한에 닿는 순간 서버가 '모두를' 영영 거부했다. */
  const many: WebSocket[] = [];
  for (let i = 0; i < 25; i++) {
    try {
      many.push(await connect());
    } catch {
      /* 거절됨 */
    }
  }
  await sleep(200);
  const refused = many.filter((w) => w.readyState !== WebSocket.OPEN).length;
  check("상한(20)을 넘으면 거절한다", many.length - refused <= 20, `열림 ${many.length - refused}`);
  for (const w of many) w.terminate();
  await sleep(400);

  // 전부 닫았으니 카운터가 0 으로 돌아와야 한다 — 다시 붙을 수 있어야 한다.
  let reconnected = 0;
  const after: WebSocket[] = [];
  for (let i = 0; i < 5; i++) {
    try {
      const w = await connect();
      after.push(w);
      reconnected++;
    } catch {
      /* 여전히 거절 */
    }
  }
  check("★ 전부 끊은 뒤에는 다시 붙을 수 있다 (누수가 없다)", reconnected === 5,
    `${reconnected}/5`);
  for (const w of after) w.terminate();
  await sleep(200);

  section("⑤ 종료가 두 서버를 함께 닫는다");
  await server.close();
  let httpDead = false;
  try {
    await fetch(`${BASE}/healthz`);
  } catch {
    httpDead = true;
  }
  check("http 도 함께 닫힌다 (wss.close 는 http 를 닫지 않는다)", httpDead);

  section("⑥ 선생성 — 운영 시작 전에 초기 문장을 박는다");
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
  let roomCalls = 0;
  let npcCalls = 0;
  const fakeRoom = async (req: RoomTextRequest) => {
    roomCalls++;
    return { text: `[생성] ${req.seed}.`, source: "llm" as const, model: "fake", promptVersion: "room.v1.ko" };
  };
  const fakeNpc = async (req: NpcLineRequest) => {
    npcCalls++;
    return { text: `[생성] ${req.seed}.`, source: "llm" as const, model: "fake", promptVersion: "npc.v1.ko" };
  };
  const quiet = () => {};

  const first = await runPregen(DB, { ...FIXTURE, llm: "off", llmRenderer: fakeRoom, llmNpcRenderer: fakeNpc }, quiet);
  check(`모든 방(${first.rooms})을 큐에 넣었다`, first.queuedRooms === first.rooms,
    `${first.queuedRooms}/${first.rooms}`);
  check("열린 주제도 전부", first.queuedLines === first.lines, `${first.queuedLines}/${first.lines}`);
  check("★ 폴백이 하나도 남지 않았다 (첫 입장이 진짜 문장을 본다)",
    first.leftoverFallback === 0, `${first.leftoverFallback}행`);
  check("실패·포기가 없다", first.failed === 0 && first.givenUp === 0);
  check(`LLM 을 방마다 한 번씩 불렀다 (${roomCalls}회)`, roomCalls === first.rooms,
    `${roomCalls} vs ${first.rooms}`);

  section("⑥' 다시 돌려도 안전하다 (지역을 추가하고 다시 돌리는 경우)");
  const callsBefore = roomCalls + npcCalls;
  const again = await runPregen(DB, { ...FIXTURE, llm: "off", llmRenderer: fakeRoom, llmNpcRenderer: fakeNpc }, quiet);
  check("★ 이미 확정된 것은 다시 만들지 않는다", roomCalls + npcCalls === callsBefore,
    `${callsBefore} -> ${roomCalls + npcCalls}`);
  check("큐에 아무것도 넣지 않았다", again.queuedRooms === 0 && again.queuedLines === 0,
    JSON.stringify([again.queuedRooms, again.queuedLines]));
  check("폴백은 여전히 0", again.leftoverFallback === 0);

  section("⑥'' 선생성된 세계에 들어가면 폴백을 거치지 않는다");
  const live = boot(DB, PORT, { ...FIXTURE,  llm: "off" });
  const ws = await connect();
  ws.send(JSON.stringify({ t: "hello", pv: PROTOCOL_VERSION, token: null, name: null }));
  const seen: ServerMsg[] = [];
  ws.on("message", (d) => seen.push(JSON.parse(String(d)) as ServerMsg));
  await sleep(500);
  const logs = seen.filter((m): m is Extract<ServerMsg, { t: "log" }> => m.t === "log");
  const narr = logs.filter((m) => m.kind === "narr");
  check("방 묘사가 도착했다", narr.length > 0, JSON.stringify(seen.map((m) => m.t)));
  check("★ 처음부터 확정본이다 — 폴백이 아니다",
    narr.every((m) => m.source === "llm"), JSON.stringify(narr.map((m) => m.source)));
  check("교체(log.replace)도 필요 없었다", !seen.some((m) => m.t === "log.replace"));
  ws.terminate();
  await live.close();


  /* ── ⑧ 백업과 복원 ─────────────────────────────────────────────────
   *
   * ★ 이 절의 요점 한 줄: **'복원했다' 와 '살아났다' 는 다른 명제다.**
   *   state_hash 는 (seedId . flagsDeclHash . 값다이제스트) 라, 씨앗을 한 글자
   *   고치거나 sensitive_flags 를 하나 늘리면 복원 행 수는 그대로인데 세계는
   *   그중 하나도 조회하지 않는다. 그래서 복원 도구가 보고하는 결과값이
   *   '넣은 행 수' 가 아니라 **적중** 이고, 아래 두 돌연변이가 그것을 두 번
   *   보여 준다 (씨앗 축과 플래그 선언 축이 각각 캐시를 무효화한다).
   *
   * ⑥ 이 만들어 둔 '진짜 문장이 박힌 DB' 를 그대로 재료로 쓴다.
   * ⑦ 앞에 두는 이유: ⑦ 은 dist/ 를 지우고 진짜 vite build 를 돌리며 그
   * 소유권을 위 주석이 명시한다. 뒤에 붙이면 느린 브라우저 절에 매달린다. */
  section("⑧ 백업과 복원 — 넣은 행 수가 아니라 '적중' 이다");
  const BK = join(tmpdir(), `mud-deploy-${process.pid}.backup.db`);
  const RESTORE_DB = join(tmpdir(), `mud-deploy-${process.pid}.restore.db`);
  for (const f of [BK, `${BK}.json`, RESTORE_DB, `${RESTORE_DB}-wal`, `${RESTORE_DB}-shm`]) {
    rmSync(f, { force: true });
  }

  const bk = await runBackup(DB, BK, quiet);
  check("★ 사본의 integrity_check 가 ok (읽을 수 있는 백업인가)", bk.integrity === "ok",
    bk.integrity);
  check("행 수가 원본과 같다 (도구가 스스로 검산한다)",
    bk.counts.roomText > 0 && bk.counts.npcLines > 0, JSON.stringify(bk.counts));
  check("매니페스트를 함께 쓴다 (열어 보지 않고 어느 세계의 것인지 안다)",
    existsSync(`${BK}.json`));
  /* ★ db.backup() 은 유효한 다른 DB 도 말없이 덮어쓴다. 저작 도구의
     '이미 있는 것은 덮어쓰지 않는다' 규칙을 라이브러리가 안 지켜 주므로
     도구가 지켜야 한다. */
  let overwriteRefused = false;
  await runBackup(DB, BK, quiet).catch(() => (overwriteRefused = true));
  check("★ 목적지가 이미 있으면 거절한다 (백업이 백업을 덮어쓰지 않는다)", overwriteRefused);

  /* 행 단위 동일성. 타임스탬프까지 같아야 '언제 이 문장에 돈을 썼는가' 가
     보존된다 — 그래서 restoreRoomText 가 @now 를 박지 않는다. */
  const srcDb = openDb(DB);
  const bkDb = openDb(BK);
  const srcRows = makeQueries(srcDb).allRoomText.all();
  const bkRows = makeQueries(bkDb).allRoomText.all();
  srcDb.close();
  bkDb.close();
  check("★ room_text 가 행 단위로 같다 (텍스트·source·모델·시각까지)",
    JSON.stringify(srcRows) === JSON.stringify(bkRows),
    `${srcRows.length} vs ${bkRows.length}`);

  /** 빈 DB 를 하나 만들고 거기에 복원한다 — 재해 뒤 새 기계와 같은 상태다. */
  const freshWorld = async (patch?: (w: typeof FIXTURE_WORLD) => void) => {
    for (const f of [RESTORE_DB, `${RESTORE_DB}-wal`, `${RESTORE_DB}-shm`]) rmSync(f, { force: true });
    const world = JSON.parse(JSON.stringify(FIXTURE_WORLD)) as typeof FIXTURE_WORLD;
    patch?.(world);
    return { ...FIXTURE, world, llm: "off" } as const;
  };

  const opts = await freshWorld();
  const r1 = await runRestore(RESTORE_DB, BK, { ...opts }, quiet);
  check("★ 짝이 맞으면 전부 들어간다", r1.inserted.roomText === bk.counts.roomText,
    `${r1.inserted.roomText}/${bk.counts.roomText}`);
  check("고아가 없다 (같은 세계다)", r1.orphans.roomText === 0 && r1.orphans.npcLines === 0);
  check("★ 적중이 100% 다 — 넣은 것을 세계가 실제로 조회한다",
    r1.hits.rooms === r1.slots.rooms && r1.slots.rooms > 0,
    `${r1.hits.rooms}/${r1.slots.rooms}`);
  /* ★ 복원본이 백업본과 행 단위로 같아야 한다. 여기가 '언제 이 문장에 돈을
     썼는가' 가 살아남는 유일한 자리다 — restoreRoomText 가 created_at 을
     @now 로 박으면 행 수도 적중도 그대로인데 이력만 조용히 사라진다. */
  const restoredDb = openDb(RESTORE_DB);
  const restoredRows = makeQueries(restoredDb).allRoomText.all();
  restoredDb.close();
  check("★ 복원본이 백업본과 행 단위로 같다 (돈을 쓴 시각까지 남는다)",
    JSON.stringify(restoredRows) === JSON.stringify(bkRows),
    JSON.stringify([restoredRows[0], bkRows[0]]));
  check("사람은 한 행도 복원하지 않는다",
    (() => {
      const d = openDb(RESTORE_DB);
      const n = (d.prepare("SELECT count(*) AS n FROM players").get() as { n: number }).n;
      d.close();
      return n === 0;
    })());

  /* ★ 진짜 시험: 복원한 DB 로 서버를 띄우면 첫 입장이 폴백을 거치지 않는가.
     ⑥'' 와 정확히 같은 판정문을 쓴다 — '살아났다' 의 정의가 하나여야 한다. */
  const revived = boot(RESTORE_DB, PORT, { ...opts });
  const ws2 = await connect();
  ws2.send(JSON.stringify({ t: "hello", pv: PROTOCOL_VERSION, token: null, name: null }));
  const seen2: ServerMsg[] = [];
  ws2.on("message", (d) => seen2.push(JSON.parse(String(d)) as ServerMsg));
  await sleep(500);
  const narr2 = seen2.filter(
    (m): m is Extract<ServerMsg, { t: "log" }> => m.t === "log" && m.kind === "narr",
  );
  check("★ 복원한 세계의 첫 입장이 확정본을 본다 (source:llm)",
    narr2.length > 0 && narr2.every((m) => m.source === "llm"),
    JSON.stringify(narr2.map((m) => m.source)));
  check("교체(log.replace)도 없다", !seen2.some((m) => m.t === "log.replace"));
  ws2.terminate();
  await revived.close();

  const r2 = await runRestore(RESTORE_DB, BK, { ...opts }, quiet);
  check("★ 두 번 복원해도 같다 (ON CONFLICT DO NOTHING — 멱등)",
    r2.inserted.roomText === 0 && r2.hits.rooms === r1.hits.rooms,
    JSON.stringify([r2.inserted, r2.hits]));

  /* ★ 적중률 돌연변이 하나 — 씨앗 축.
     씨앗을 한 글자 고치면 seedId 가 바뀌고 state_hash 가 통째로 갈린다.
     '행 수는 그대로인데 아무도 조회하지 않는' 상태가 정확히 이것이다. */
  const seedShift = await freshWorld((w) => {
    const b1 = w.regions.find((r) => r.id === "b1")!;
    const key = Object.keys(b1.seeds)[0]!;
    (b1.seeds as Record<string, string>)[key] = `${b1.seeds[key]} 그리고 한 글자.`;
  });
  const rSeed = await runRestore(RESTORE_DB, BK, { ...seedShift, force: true }, quiet);
  check("★ 씨앗을 고치면 넣는 행 수는 그대로다",
    rSeed.had.roomText === bk.counts.roomText, `${rSeed.had.roomText}`);
  check("★ 그런데 적중이 떨어진다 — '복원했다' 는 '살아났다' 가 아니다",
    rSeed.hits.rooms < r1.hits.rooms, `${rSeed.hits.rooms} vs ${r1.hits.rooms}`);
  check("content_hash 가 다르다고 말해 준다", !rSeed.contentHash.same);

  /* ★ 적중률 돌연변이 둘 — 플래그 선언 축. 씨앗을 한 글자도 안 건드려도
     sensitive_flags 를 하나 늘리면 flagsDeclHash 가 바뀌어 같은 일이 난다. */
  const flagShift = await freshWorld((w) => {
    const b1 = w.regions.find((r) => r.id === "b1")!;
    const key = Object.keys(b1.seeds).find((k) => !(b1.sensitive as Record<string, string[]>)[k])!;
    (b1.sensitive as Record<string, string[]>)[key] = ["guardian_slain"];
  });
  const rFlag = await runRestore(RESTORE_DB, BK, { ...flagShift, force: true }, quiet);
  check("★ 씨앗을 안 건드려도 선언을 늘리면 적중이 떨어진다 (두 축이 따로 있다)",
    rFlag.hits.rooms < r1.hits.rooms, `${rFlag.hits.rooms} vs ${r1.hits.rooms}`);

  /* ★ 고아 — 백업이 지금 세계에 없는 방의 문장을 들고 있는 경우. 실제로
     일어난다: 백업 뒤에 지역을 줄이거나 방을 막으면 그 방의 room_text 가
     갈 곳이 없다. room_text.room_id 는 rooms 로 FK 라, 안 거르면
     FOREIGN KEY constraint failed 가 **트랜잭션 전체를 죽여** 멀쩡한
     행들까지 하나도 안 들어간다. */
  const ghostDb = openDb(BK);
  ghostDb
    .prepare(
      `INSERT INTO rooms (id, region, x, y, tile, seed, seed_id, sensitive_flags,
                          flags_decl_hash, created_at, updated_at)
       VALUES ('b1:9,9', 'b1', 9, 9, '.', '없는 방', 'ghost123', '[]', 'x', 1, 1)`,
    )
    .run();
  ghostDb
    .prepare(
      `INSERT INTO room_text (room_id, state_hash, text, source, flags_json,
                              created_at, updated_at)
       VALUES ('b1:9,9', 'ghost123.x.y', '있을 리 없는 방의 문장', 'llm', '[]', 1, 1)`,
    )
    .run();
  ghostDb.close();
  const optsGhost = await freshWorld();
  const rGhost = await runRestore(RESTORE_DB, BK, { ...optsGhost }, quiet);
  check("★ 지금 세계에 없는 방의 문장은 고아로 세고 넣지 않는다",
    rGhost.orphans.roomText === 1, JSON.stringify(rGhost.orphans));
  check("★ 고아 하나가 멀쩡한 나머지를 죽이지 않는다 (FK 가 트랜잭션을 통째로 깬다)",
    rGhost.inserted.roomText + rGhost.skipped.roomText === bk.counts.roomText,
    JSON.stringify([rGhost.inserted, rGhost.skipped, bk.counts.roomText]));
  check("적중은 그대로다 (고아는 애초에 조회되지 않는 자리다)",
    rGhost.hits.rooms === r1.hits.rooms, `${rGhost.hits.rooms} vs ${r1.hits.rooms}`);

  /* ★ 짝이 안 맞으면 --force 없이는 한 행도 쓰지 않는다. */
  let blocked = false;
  await runRestore(RESTORE_DB, BK, { ...seedShift }, quiet).catch(() => (blocked = true));
  check("★ content_hash 가 다르면 --force 없이 거절한다", blocked);

  for (const f of [BK, `${BK}.json`, RESTORE_DB, `${RESTORE_DB}-wal`, `${RESTORE_DB}-shm`]) {
    rmSync(f, { force: true });
  }

  section("⑦ 진짜 브라우저로 — 빌드된 클라이언트가 같은 오리진의 /ws 로 붙는다");
  /* ★ 이게 이번 작업의 진짜 시험대다. 브라우저 테스트(test/browser.ts)는
     vite 개발 서버 + VITE_MUD_WS 주입으로 돌아서, 방금 만든 '정적 서빙 +
     같은 오리진 /ws' 경로를 한 번도 지나지 않는다. 여기서만 확인된다. */
  rmSync("dist", { recursive: true, force: true });
  /* ★ root 를 인자로 넘기면 vite 가 설정 파일을 그 root 안에서 찾는다 —
     client/vite.config.ts 는 없으므로 설정 없이(플러그인도 outDir 도 없이)
     빌드된다. 저장소의 설정을 그대로 쓰려면 인자 없이 부른다. */
  await build({ logLevel: "error" });
  check("빌드가 저장소 루트의 dist/ 에 나온다 (client/dist 가 아니라)",
    existsSync("dist/index.html"), "vite 의 기본 outDir 은 root/dist 다");

  const prod = boot(DB, PORT, { ...FIXTURE,  llm: "off" });
  const pre = [
    "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    "/opt/pw-browsers/chromium/chrome-linux/chrome",
  ].find((p) => existsSync(p));
  const browser = await chromium.launch(pre ? { executablePath: pre } : {});
  const page = await browser.newPage();
  const wsUrls: string[] = [];
  page.on("websocket", (w) => wsUrls.push(w.url()));
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${BASE}/`);
  await page.waitForSelector("text=화살표로 이동", { timeout: 10000 });

  check("★ 빌드된 페이지가 뜨고 게임에 접속된다", true);
  check("★ 같은 오리진의 /ws 로 붙었다 (별도 포트가 아니라)",
    wsUrls.some((u) => u === `ws://127.0.0.1:${PORT}/ws`), JSON.stringify(wsUrls));
  check("자바스크립트 오류가 없다", errors.length === 0, JSON.stringify(errors));
  check("선생성된 확정본이 화면에 보인다",
    (await page.locator("body").innerText()).includes("[생성]"),
    (await page.locator("body").innerText()).slice(0, 120));

  await page.keyboard.press("ArrowLeft");
  await sleep(400);
  check("실제로 움직인다", (await page.locator("body").innerText()).includes("2,3"),
    (await page.locator("body").innerText()).match(/지하 1층 · \d+,\d+/)?.[0] ?? "?");
  await page.screenshot({ path: join("test", "shots", "24-배포-모드.png") });
  await browser.close();
  await prod.close();

  // ── 정리 ────────────────────────────────────────────────────────────
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
  rmSync("secret-not-served.txt", { force: true });
  if (stashed) {
    rmSync("dist", { recursive: true, force: true });
    renameSync(stashed, "dist");
  }

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${checks - failures}/${checks} 검사 통과`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
