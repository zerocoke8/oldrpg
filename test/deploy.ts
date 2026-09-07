/* 배포 배관. "친구가 링크를 열면 실제로 게임이 뜨는가" 를 확인한다.
 *
 * 확인하는 것:
 *   한 포트   정적 파일과 ws 업그레이드가 같은 오리진에서 처리된다
 *             (HTTPS 에서 ws:// 가 mixed content 로 차단되는 것을 막는 유일한 길)
 *   경로 탈출 dist/ 밖의 파일은 절대 나가지 않는다
 *   IP 예산   프록시 뒤에서 무너지지 않고, 거절이 카운터를 영구히 적립하지 않는다
 *   선생성    운영 시작 전에 초기 문장을 전부 박아 둘 수 있고, 여러 번 돌려도 안전하다 */

import { mkdirSync, rmSync, writeFileSync, existsSync, renameSync, readFileSync, cpSync, statSync, symlinkSync, readdirSync, lstatSync } from "node:fs";
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
import { planPregen, runPregen } from "../server/tools/pregen";
import { runBackup } from "../server/tools/backup";
import { runRestore } from "../server/tools/restore";
import { runPreflight } from "../server/tools/preflight";
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
  /* ★ 이 검사 자신이 저장소 루트에 남기는 것들도 컨텍스트에서 빠져야 한다.
     fly deploy 는 git 이 아니라 **작업 디렉터리**를 빌드 컨텍스트로 올리므로
     (COPY . . + .dockerignore), .gitignore 만으로는 이미지에 들어가는 것을
     못 막는다. dist.bak-test 는 진짜 dist 의 통째 사본이고, .gitignore 의
     `dist/` 도 .dockerignore 의 `dist` 도 그 이름을 매치하지 않는다. */
  check("★ 이 검사가 남기는 잔해도 컨텍스트에서 빠진다 (dist.bak-test · secret-not-served.txt)",
    ignored("dist.bak-test") && ignored("secret-not-served.txt"),
    JSON.stringify(ignorePatterns));

  /* ⓪-c 런타임이 fs 로 읽는 뿌리가 전부 COPY 트리 안에 있는가.
     갱신법: grep -rn "readFileSync\|readdirSync\|createReadStream" server/ */
  /* ★ 뿌리는 두 종류다. 다섯은 **커밋된 소스**라 저장소에 실재해야 하고,
     없으면 `COPY . .` 이 못 가져가 이미지가 그 파일 없이 뜬다. dist 하나만
     **빌드 스테이지가 만드는 산출물**이다 — .gitignore 되어 있고, 바로 위
     ⓪-b 가 "컨텍스트에서 빠진다" 를 명시적으로 단언한다. 그래서 같은 경로에
     대해 ⓪-b 는 '없어야 한다', ⓪-c 는 '있어야 한다' 를 동시에 요구하고 있었다.
     뒤엣것은 커밋의 성질이 아니라 **기계의 성질**이다 — '이 기계가 전에 한 번
     npm run build 를 했는가'. 갓 클론한 기계에서는 반드시 빨갛고, 빌드해 둔
     기계에서는 항상 초록이라 아무것도 재지 않았다.
     그래서 dist 에는 디스크를 묻지 않고, 대신 아래에서 '빌드 스테이지가 정말
     만드는가' 를 더 강하게 묻는다. */
  const FS_ROOTS: { path: string; why: string; built?: true }[] = [
    { path: "server/db/schema.sql", why: "migrate.ts 가 첫 부팅에 통째로 실행한다" },
    { path: "server/db/migrations", why: "migrate.ts 가 버전마다 읽는다" },
    { path: "server/narration/prompts", why: "prompts.ts — 프롬프트·톤·무드·목소리" },
    { path: "dist", why: "net/static.ts 의 MUD_STATIC 기본값", built: true },
    { path: "content/world", why: "content/world.ts 의 DEFAULT_DIR" },
    { path: "content/balance", why: "content/balance.ts 의 DEFAULT_DIR" },
  ];
  for (const r of FS_ROOTS) {
    check(`런타임이 읽는 ${r.path} 가 이미지에 들어간다 (${r.why})`,
      copyDests.includes(r.path.split("/")[0]!) && (r.built || existsSync(r.path)),
      JSON.stringify(copyDests));
  }

  /* ★ dist 에서 뺀 조건(existsSync)을 더 약한 것으로 바꾸는 것이 아니라, 옳은
     자리에 더 강하게 되돌린다. 지금까지 ⓪ 은 **이미지의 dist 가 언제 만들어
     지는지를 한 줄도 확인하지 않았다** — 빌드 스테이지에서 `RUN npm run build`
     를 통째로 지워도 아무 검사도 물지 않았다 (낡은 dist/ 가 있는 기계에서는
     ⓪-c 마저 초록이었다). 세 가지를 함께 본다:
       1) 빌드 스테이지(첫 FROM ~ 두 번째 FROM) 안에서 build 를 돌리는가
       2) 그 build 가 정말 클라이언트를 굽는가 (package.json 의 vite build)
       3) COPY 의 **원본 경로**가 그 산출물인가 (/app/dist → /app/client/dist
          같은 돌연변이는 목적지만 보면 안 잡힌다) */
  const buildStage = dockerfile.slice(
    dockerfile.indexOf("FROM"),
    dockerfile.indexOf("FROM", dockerfile.indexOf("FROM") + 4),
  );
  const buildRuns = buildStage.split("\n").filter((l) => /^RUN\s/.test(l));
  check("★ dist 는 빌드 스테이지가 만든다 (저장소에 없으므로 여기가 유일한 출처다)",
    buildRuns.some((l) => /npm run build\b/.test(l)) &&
      /vite build/.test(PKG.scripts.build ?? "") &&
      /^COPY\s+--from=build\s+\/app\/dist\s/m.test(dockerfile),
    JSON.stringify({ buildRuns: buildRuns.map((l) => l.replace(/\r/g, "")), build: PKG.scripts.build }));

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
       에서 위로 올라가므로 폐포 밖으로 새지 않는다).
       ★ 윈도우에서 갈리는 것은 링크의 '종류' 뿐이고(권한 때문에 정션이다),
         이 금지는 정션에도 그대로 걸린다 — node 는 정션도 realpath 로 해소하고,
         content 는 애초에 fs 가 재분석 지점을 그냥 따라간다. 즉 '무엇을
         링크하는가' 는 플랫폼으로 갈리지 않는다. 아래 검사가 그것을 못 박는다. */
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
  /* ★ 윈도우에서 type="dir" 은 NT 심볼릭 링크이고 SeCreateSymbolicLinkPrivilege
     (관리자 또는 개발자 모드)를 요구한다 — 없으면 EPERM 으로 **던져서** main()
     이 여기서 통째로 끝난다 (검사 하나가 빨개지는 것이 아니다). 정션은 같은
     자리에서 권한 없이 만들어지고 디렉터리에만 쓸 수 있다.
     비-win32 에서는 "dir" 로 평가돼 이전과 글자 그대로 같다 (POSIX 의 node 는
     이 인자를 애초에 무시한다). */
  const LINK_TYPE = process.platform === "win32" ? "junction" : "dir";
  for (const name of [...prodClosure].sort()) {
    const dst = join(IMG, "node_modules", name);
    mkdirSync(join(dst, ".."), { recursive: true });
    if (!existsSync(dst)) symlinkSync(resolve("node_modules", name), dst, LINK_TYPE);
  }
  /* ★ 링크해도 되는 것은 node_modules 뿐이라는 규약을 주석이 아니라 검사로
     못 박는다 (.eslintrc.cjs 머리: "강제는 부르는 사람이 있어야 강제다").
     server/shared/content 를 링크로 때우면 node 가 ESM 을 realpath 로 해소해
     import.meta.url 이 저장소의 실제 경로가 되고, ../../content 가 저장소의
     content/ 를 가리켜 **트리에 파일이 없어도 초록**이 된다. 링크 종류가
     플랫폼 분기가 된 지금 그 구멍을 밟을 확률이 올라갔다. */
  const linkedTop = readdirSync(IMG, { withFileTypes: true })
    .filter((e) => lstatSync(join(IMG, e.name)).isSymbolicLink())
    .map((e) => e.name);
  check("★ IMG 의 최상위에는 링크가 하나도 없다 (링크는 node_modules 안에만 있다)",
    linkedTop.length === 0, JSON.stringify(linkedTop));
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
  /* ★ 이 검사는 POSIX 에서만 뜻이 있다. 윈도우에는 시그널이 없어서
     child.kill("SIGTERM") 이 TerminateProcess 로 내려가고, 자식은 핸들러를
     돌릴 기회 없이 죽는다 (exit=null · signal=SIGTERM). 거기서 "exit 0" 을
     요구하면 영원히 빨갛고, 그 빨강은 회귀가 아니라 플랫폼이다 — 사람이
     빨강을 무시하는 법을 배우는 자리가 된다.
     그렇다고 조용히 통과시키지도 않는다. 배포 대상은 리눅스 컨테이너이므로
     '우아한 종료' 는 리눅스에서 닫아야 하는 항목이고, 윈도우에서는 그 사실을
     말한다. */
  if (process.platform === "win32") {
    check("종료 신호에 프로세스가 실제로 끝난다 (우아한 종료는 리눅스에서 닫는다)",
      exitCode !== null || child.killed,
      `exit=${exitCode} killed=${child.killed}`);
    console.log("  skip ★ SIGTERM 에 우아하게 exit 0 — 윈도우에는 POSIX 시그널이 없다 (배포 대상은 리눅스다)");
  } else {
    check("★ SIGTERM 에 우아하게 exit 0 (CMD 가 래퍼 프로세스가 아니다)",
      exitCode === 0, `exit=${exitCode} ${childErr.slice(-300)}`);
  }
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
  /* ★ 되돌리기를 '함수 끝' 이 아니라 여기서 process 에 건다. 끝에만 두면
     검사가 중간에 죽었을 때 60바이트 가짜가 dist/ 에 남고, 다음 실행이 그
     가짜를 다시 치웠다 되돌리므로 **영원히 전파된다** (실제로 그랬다).
     그 상태에서 npm start 는 게임이 아니라 빈 페이지를 서빙하고,
     preflight ③ 은 mtime 만 보므로 ok 를 찍는다. */
  const restoreDist = (): void => {
    if (!stashed || !existsSync(stashed)) return;
    rmSync("dist", { recursive: true, force: true });
    renameSync(stashed, "dist");
  };
  process.on("exit", restoreDist);
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


  /* ── ⑨ 배포를 한 번에 되게 하는 것들 ───────────────────────────────
   *
   * ★ 이 절이 보는 것은 전부 **"실기 배포로만 닫힌다" 고 미뤄 뒀던 것** 이다.
   *   미뤄 둔 것을 목록으로만 남기면 배포한 날 하나씩 터지고, 터질 때마다
   *   한 사이클(빌드+배포+재현)을 쓴다. 그래서 넷을 측정 가능한 것으로
   *   바꿨고, 아래가 그 넷이 실제로 측정을 하는지 본다:
   *
   *     ⑨-a  DB 를 못 열 때 '무엇이 왜' 가 로그에 있는가 (볼륨 소유권)
   *     ⑨-b  MUD_TRUST_PROXY 가 맞는지를 서버가 스스로 말하는가
   *     ⑨-c  선생성 견적이 실제로 부를 자리와 같은 수를 세는가
   *     ⑨-d  npm run preflight 가 운영 콘텐츠로 실제 판정을 내는가 */
  section("⑨-a DB 를 못 열면 '무엇이 왜' 가 남는다 (볼륨 소유권)");
  /* ★ 이 실패의 압도적 다수는 fly 볼륨 소유권이고, 그때 나오던 것은
     "SQLITE_CANTOPEN: unable to open database file" 한 줄이었다 — 경로도
     uid 도 없다. 배포한 사람이 로그에서 볼 수 있는 것이 "안 된다" 뿐이면
     그 한 번의 실패에 하루가 간다. */
  let openErr = "";
  try {
    openDb(join(tmpdir(), `mud-nope-${process.pid}`, "sub", "mud.db"));
  } catch (e) {
    openErr = e instanceof Error ? e.message : String(e);
  }
  check("★ 디렉터리가 없으면 그 디렉터리를 이름으로 말한다",
    openErr.includes("가 없다") && openErr.includes("mud-nope"), openErr.slice(0, 160));
  check("드라이버가 한 말도 그대로 남는다 (문장으로 감싸되 삼키지 않는다)",
    /를 열 수 없다 — \S.*/.test(openErr), openErr.slice(0, 160));

  /* ★ SQLite 는 게으르게 연다 — 파일이 SQLite 가 아니면 new Database 가 아니라
     첫 PRAGMA 에서 터진다. 그 갈래가 감싸이지 않아 사람이 읽는 문장 대신
     "file is not a database" 한 줄만 남았고, 핸들까지 샜다. 손상된 /data/mud.db
     를 만나는 바로 그 순간의 경로다. */
  const NOTDB = join(tmpdir(), `mud-notadb-${process.pid}.db`);
  writeFileSync(NOTDB, "이 파일은 SQLite 가 아니다");
  let notdbErr = "";
  try {
    openDb(NOTDB);
  } catch (e) {
    notdbErr = e instanceof Error ? e.message : String(e);
  }
  check("★ SQLite 가 아닌 파일도 사람이 읽는 문장으로 거절한다 (첫 PRAGMA 에서 터진다)",
    notdbErr.includes("를 열 수 없다") && notdbErr.includes(NOTDB), notdbErr.slice(0, 160));
  let notdbLeak = "";
  try {
    rmSync(NOTDB, { force: true });
  } catch (e) {
    notdbLeak = (e as NodeJS.ErrnoException).code ?? String(e);
  }
  check("★ 그리고 핸들을 남기지 않는다 (남으면 그 파일을 치울 수 없다)",
    notdbLeak === "", `${notdbLeak} — openDb 가 PRAGMA 에서 던질 때 db.close() 를 안 했다`);

  /* 소유권 갈래는 '쓸 수 없는 디렉터리' 를 만들 수 있어야 재현된다. 그게 안 되는
     환경이 둘 있고, 조용히 통과시키는 대신 건너뛴 것을 말한다 — '초록' 과
     '안 돌았다' 는 다른 명제다.
       root      모드를 무시한다.
       윈도우    POSIX 모드가 없다. mkdirSync 의 mode 0o500 은 무시되고
                 디렉터리는 그냥 쓸 수 있다 — openDb 가 **성공**해 버린다.
                 (그러면 검사가 빨개지는 데 그치지 않고, 열린 핸들이 남아
                  바로 아래 rmSync 가 EBUSY 로 실행을 끝낸다.)
     이 갈래가 지키는 것은 리눅스 컨테이너의 /data 소유권이므로, 리눅스에서
     닫히면 된다. */
  const cannotMakeReadOnly =
    process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0);
  if (cannotMakeReadOnly) {
    console.log(
      `  skip 소유권 갈래 — ${process.platform === "win32" ? "윈도우에는 POSIX 모드가 없다" : "root 는 모드를 무시한다"}` +
        " (지키는 대상은 리눅스의 /data 다)",
    );
  } else {
    const ro = join(tmpdir(), `mud-ro-${process.pid}`);
    rmSync(ro, { recursive: true, force: true });
    mkdirSync(ro, { recursive: true, mode: 0o500 });
    let roErr = "";
    try {
      openDb(join(ro, "mud.db"));
    } catch (e) {
      roErr = e instanceof Error ? e.message : String(e);
    }
    check("★ 쓸 수 없으면 소유·모드·이 프로세스의 uid 를 함께 말한다",
      roErr.includes("소유") && roErr.includes("모드"), roErr.slice(0, 200));
    rmSync(ro, { recursive: true, force: true });
  }

  section("⑨-b MUD_TRUST_PROXY — 서버가 그 값이 맞는지 스스로 말한다");
  /* ★ 이 설정만은 배포하기 전에 맞는지 알 방법이 없다. 프록시가 XFF 를
     어떻게 쌓는지는 프록시가 정하고 우리는 홉 수를 숫자로 적을 뿐이다.
     그리고 틀려도 **아무 일도 일어나지 않는다** — 조용히 IP 예산이
     무의미해질 뿐(전원이 한 버킷)이고, 그건 누가 쏟아부을 때까지 안 보인다.
     그래서 첫 연결에서 실제로 도착한 헤더를 한 줄로 찍게 했고, 아래가
     그 한 줄이 실제로 판정을 담는지 본다. */
  const XDB = join(tmpdir(), `mud-xff-${process.pid}.db`);
  const savedTrust = process.env.MUD_TRUST_PROXY;
  let xffPort = PORT + 20;

  /** 헤더를 붙여 한 번 붙었다 떼고, 그 사이의 콘솔을 통째로 돌려준다. */
  const probeIp = async (trust: string | undefined, xff: string | null): Promise<string> => {
    for (const f of [XDB, `${XDB}-wal`, `${XDB}-shm`]) rmSync(f, { force: true });
    if (trust === undefined) delete process.env.MUD_TRUST_PROXY;
    else process.env.MUD_TRUST_PROXY = trust;
    const port = xffPort++;
    const out: string[] = [];
    const realLog = console.log;
    const realWarn = console.warn;
    console.log = (...a: unknown[]) => out.push(a.map(String).join(" "));
    console.warn = (...a: unknown[]) => out.push(a.map(String).join(" "));
    let srv: ReturnType<typeof boot> | null = null;
    try {
      srv = boot(XDB, port, { ...FIXTURE, llm: "off" });
      const sock = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
        headers: xff ? { "x-forwarded-for": xff } : {},
      });
      await new Promise<void>((res, rej) => {
        sock.once("open", () => res());
        sock.once("error", rej);
      });
      await sleep(120);
      sock.terminate();
    } finally {
      console.log = realLog;
      console.warn = realWarn;
      if (srv) await srv.close();
    }
    return out.join("\n");
  };

  const okHop = await probeIp("1", "9.9.9.9");
  check("★ 프록시가 본 주소를 쓴다 (socket 이 아니라)",
    okHop.includes("쓰는 값 9.9.9.9"), okHop.match(/IP 판정.*/)?.[0] ?? okHop.slice(-200));
  check("맞게 설정되어 있으면 경고하지 않는다", !okHop.includes("[mud] !"),
    okHop.match(/\[mud] !.*/)?.[0] ?? "");

  /* ★ 보안의 핵심: '가장 왼쪽' 이 아니라 '오른쪽에서 n번째' 다. 왼쪽은
     클라이언트가 마음대로 써서 보낼 수 있고, 우리 프록시가 본 진짜 주소는
     맨 뒤에 붙는다. 홉이 둘이면 뒤에서 둘째가 클라이언트다. */
  const twoHops = await probeIp("2", "1.1.1.1, 2.2.2.2");
  check("★ 오른쪽에서 n번째를 쓴다 (왼쪽을 믿으면 위조로 예산을 통째로 우회한다)",
    twoHops.includes("쓰는 값 1.1.1.1"), twoHops.match(/IP 판정.*/)?.[0] ?? "");

  const tooMany = await probeIp("3", "1.1.1.1, 2.2.2.2");
  check("★ 홉 수가 실제보다 크면 맞는 값을 말해 준다",
    tooMany.includes("MUD_TRUST_PROXY=2 가 맞다"), tooMany.match(/\[mud] !.*/)?.[0] ?? "경고 없음");

  /* ★ 이 갈래가 없으면 "경고가 없다 = 맞다" 가 거짓이 된다. 홉이 설정보다
     많으면 채택되는 것(오른쪽에서 n번째)이 프록시 주소일 수 있는데, 한 표본
     으로는 '프록시가 두 단' 과 '접속자가 위조했다' 를 가를 수 없다.
     그래서 서버는 고르지 않고 둘 다 말하고, 가르는 재료를 준다. */
  const extraHop = await probeIp("1", "1.1.1.1, 2.2.2.2");
  check("★ 홉이 설정보다 많으면 두 해석을 다 말한다 (조용히 넘어가지 않는다)",
    extraHop.includes("둘 중 하나다") && extraHop.includes("MUD_TRUST_PROXY=2"),
    extraHop.match(/\[mud] !.*/)?.[0] ?? "경고 없음");
  check("그리고 무엇으로 가르는지 알려 준다 (공인 IP 와 대조)",
    extraHop.includes("공인 IP"), extraHop.match(/공인 IP.*/)?.[0] ?? "없음");

  const behindProxy = await probeIp("0", "1.1.1.1");
  check("★ 프록시 뒤인데 0 이면 '전원이 한 버킷' 을 경고한다",
    behindProxy.includes("한 IP 버킷"), behindProxy.match(/\[mud] !.*/)?.[0] ?? "경고 없음");

  const noProxy = await probeIp("1", null);
  check("헤더가 안 오면 프록시 뒤가 아니라고 말한다",
    noProxy.includes("X-Forwarded-For 가 없는데"), noProxy.match(/\[mud] !.*/)?.[0] ?? "경고 없음");

  /* ★ 진단할 것이 없으면 말하지 않는다. 접속마다 IP 를 찍으면 그건 우리가
     보관하겠다고 한 적 없는 것이고, 소음에 섞이면 진짜로 찍혔을 때 안 읽는다. */
  const quietCase = await probeIp("0", null);
  check("★ 프록시도 설정도 없으면 한 줄도 찍지 않는다 (로컬·검사가 전부 여기다)",
    !quietCase.includes("IP 판정"), quietCase.match(/IP 판정.*/)?.[0] ?? "");

  if (savedTrust === undefined) delete process.env.MUD_TRUST_PROXY;
  else process.env.MUD_TRUST_PROXY = savedTrust;
  for (const f of [XDB, `${XDB}-wal`, `${XDB}-shm`]) rmSync(f, { force: true });

  section("⑨-c 선생성 견적 — 부르기 전에 '몇 번, 얼마' 를 안다");
  const PDB = join(tmpdir(), `mud-plan-${process.pid}.db`);
  for (const f of [PDB, `${PDB}-wal`, `${PDB}-shm`]) rmSync(f, { force: true });
  const planOpts = { ...FIXTURE, llm: "off" } as const;
  const plan = await planPregen(PDB, planOpts, quiet, null);

  /* ★ 예상이 세계를 바꾸면 그건 예상이 아니다. runPregen 의 1단계는 자리를
     '만들어서' 확인하는데(폴백 행), 이쪽은 state_hash 를 직접 계산해 조회만
     한다 — 그 차이가 실제로 지켜지는지 본다. */
  const pdb = openDb(PDB);
  const textRows = (pdb.prepare("SELECT count(*) AS n FROM room_text").get() as { n: number }).n;
  const lineRows = (pdb.prepare("SELECT count(*) AS n FROM npc_lines").get() as { n: number }).n;
  pdb.close();
  check("★ --dry-run 은 room_text·npc_lines 에 한 행도 쓰지 않는다",
    textRows === 0 && lineRows === 0, `${textRows} / ${lineRows}`);

  /* ★ 이 절의 핵심 판정. 견적이 '다른 수' 를 세면 그건 견적이 아니라 소설이다.
     같은 빈 DB 에 실제로 돌려서 큐에 들어간 자리 수와 대조한다. */
  let planRoomCalls = 0;
  let planNpcCalls = 0;
  const real = await runPregen(
    PDB,
    {
      ...planOpts,
      llmRenderer: async (r: RoomTextRequest) => {
        planRoomCalls++;
        return { text: `[생성] ${r.seed}`, source: "llm" as const, model: "fake", promptVersion: "v" };
      },
      llmNpcRenderer: async (r: NpcLineRequest) => {
        planNpcCalls++;
        return { text: `[생성] ${r.seed}`, source: "llm" as const, model: "fake", promptVersion: "v" };
      },
    },
    quiet,
  );
  check("★ 견적의 호출 수 = 실제로 큐에 들어간 자리 수",
    plan.estimate.calls === real.queuedRooms + real.queuedLines,
    `견적 ${plan.estimate.calls} vs 실제 ${real.queuedRooms}+${real.queuedLines}`);
  check("★ 그리고 실제로 그만큼 불렀다",
    planRoomCalls + planNpcCalls === plan.estimate.calls,
    `${planRoomCalls}+${planNpcCalls} vs ${plan.estimate.calls}`);
  check("방과 대사를 따로 센다 (합만 맞고 갈래가 틀린 것을 잡는다)",
    plan.rooms.todo === real.queuedRooms && plan.lines.todo === real.queuedLines,
    JSON.stringify([plan.rooms, plan.lines, real.queuedRooms, real.queuedLines]));

  /* 이미 확정본이 박힌 DB 에 다시 물으면 부를 것이 없다 — 견적이 '남은
     자리' 를 세는 것이지 '세계의 크기' 를 세는 것이 아니다. */
  const planAgain = await planPregen(PDB, planOpts, quiet, null);
  check("★ 확정본이 있으면 견적이 0 이다 (세계의 크기가 아니라 남은 자리다)",
    planAgain.estimate.calls === 0, `${planAgain.estimate.calls}`);
  check("총 자리 수는 그대로다 (0 이 된 것은 '할 일' 뿐이다)",
    planAgain.rooms.total === plan.rooms.total && planAgain.lines.total === plan.lines.total,
    JSON.stringify([planAgain.rooms, planAgain.lines]));

  /* 입력 토큰: 키가 없으면 추정(폭 2배), 세는 사람이 있으면 실측(폭 0). */
  check("키가 없으면 입력 토큰이 '추정' 이라고 말한다 (폭이 남는다)",
    !plan.estimate.inputMeasured && plan.estimate.inputTokens.hi > plan.estimate.inputTokens.lo,
    JSON.stringify(plan.estimate.inputTokens));

  for (const f of [PDB, `${PDB}-wal`, `${PDB}-shm`]) rmSync(f, { force: true });
  let counted = 0;
  const stubCount = async (system: string, user: string): Promise<number> => {
    counted++;
    return Math.ceil((system.length + user.length) / 1.4);
  };
  const measured = await planPregen(PDB, planOpts, quiet, stubCount);
  check("★ 셀 수 있으면 입력 토큰이 실측이 된다 (폭이 닫힌다)",
    measured.estimate.inputMeasured &&
      measured.estimate.inputTokens.lo === measured.estimate.inputTokens.hi,
    JSON.stringify(measured.estimate.inputTokens));
  check("표본만 센다 (자리마다 세면 얻는 것이 소수점뿐이다)",
    counted > 0 && counted < measured.estimate.calls, `${counted}/${measured.estimate.calls}`);
  check("실측이 추정 폭 안에 있다 (환산이 자릿수를 놓치지 않았다)",
    measured.estimate.inputTokens.lo >= plan.estimate.inputTokens.lo &&
      measured.estimate.inputTokens.lo <= plan.estimate.inputTokens.hi,
    JSON.stringify([plan.estimate.inputTokens, measured.estimate.inputTokens]));

  /* ★ 네트워크가 막힌 기계에서도 도구는 답을 내야 한다. 세다가 던지면
     '견적 없음' 이 아니라 '추정' 으로 내려앉는다. */
  for (const f of [PDB, `${PDB}-wal`, `${PDB}-shm`]) rmSync(f, { force: true });
  const fellBack = await planPregen(PDB, planOpts, quiet, async () => {
    throw new Error("네트워크 없음");
  });
  check("★ 세다가 실패하면 추정으로 내려앉는다 (도구가 죽지 않는다)",
    !fellBack.estimate.inputMeasured && fellBack.estimate.calls === plan.estimate.calls,
    JSON.stringify(fellBack.estimate.inputTokens));

  /* ★ 그런데 '왜 못 셌는가' 를 삼키면 안 된다. .env.example 의 자리표시자
     (sk-ant-...)는 값이 비어 있지 않아 pregen 의 키 가드를 그대로 통과한다 —
     즉 '키가 틀렸다' 와 '키가 없다' 가 똑같이 '추정' 으로 보인다. 그 둘을
     못 가르면 견적을 보고 안심한 채 --limit 을 돌려 전부 401 로 태운다.
     --dry-run 은 과금되지 않으므로, 여기가 키를 공짜로 시험하는 유일한 자리다. */
  const authLog: string[] = [];
  for (const f of [PDB, `${PDB}-wal`, `${PDB}-shm`]) rmSync(f, { force: true });
  await planPregen(PDB, planOpts, (l) => authLog.push(l), async () => {
    throw Object.assign(new Error("401 Unauthorized"), { status: 401 });
  });
  check("★ 키가 거절당하면 --dry-run 이 그렇게 말한다 (공짜로 키를 시험하는 자리)",
    authLog.some((l) => l.includes("키가 거절당했다") && l.includes("401")),
    authLog.filter((l) => l.includes("못 셌다")).join(" | ") || "아무 말도 안 했다");
  check("자리표시자가 가드를 통과한다는 것까지 말한다",
    authLog.some((l) => l.includes("sk-ant-")),
    authLog.find((l) => l.includes("못 셌다")) ?? "없음");

  /* 단가를 모르는 모델에 아무 단가나 끌어다 쓰면 그 순간 보고가 거짓말이 된다. */
  const savedModel = process.env.MUD_MODEL;
  process.env.MUD_MODEL = "claude-어딘가-9";
  for (const f of [PDB, `${PDB}-wal`, `${PDB}-shm`]) rmSync(f, { force: true });
  const unknown = await planPregen(PDB, planOpts, quiet, null);
  check("★ 단가를 모르는 모델이면 값을 지어내지 않는다 (usd = null)",
    unknown.estimate.usd === null, JSON.stringify(unknown.estimate.usd));
  check("그래도 호출 수는 말한다 (그건 세계가 정하는 실측이다)",
    unknown.estimate.calls === plan.estimate.calls);
  if (savedModel === undefined) delete process.env.MUD_MODEL;
  else process.env.MUD_MODEL = savedModel;

  /* --limit: 견적의 출력 폭은 사고 토큰 때문에 추정뿐이라, 작게 한 번
     돌려 봐야만 닫힌다. 그러려면 '정확히 N 개' 여야 한다. */
  for (const f of [PDB, `${PDB}-wal`, `${PDB}-shm`]) rmSync(f, { force: true });
  let limited = 0;
  const trial = await runPregen(
    PDB,
    {
      ...planOpts,
      limit: 3,
      llmRenderer: async (r: RoomTextRequest) => {
        limited++;
        return { text: `[생성] ${r.seed}`, source: "llm" as const, model: "fake", promptVersion: "v" };
      },
    },
    quiet,
  );
  check("★ --limit 3 이 정확히 3 자리만 만든다 (시험 주행이 청구서를 안 연다)",
    limited === 3 && trial.queuedRooms + trial.queuedLines === 3,
    `${limited} / ${trial.queuedRooms}+${trial.queuedLines}`);
  check("상한에 걸려 멈춘 것을 결과가 말한다", trial.stoppedEarly, JSON.stringify(trial));
  /* ★ 여기서 leftoverFallback 을 '남은 일' 로 읽으면 안 된다. 손도 안 댄
     자리는 room_text 에 행이 아예 없어서 그 수에 안 들어가고, 그래서 상한
     주행 뒤의 "폴백 0행" 은 '다 됐다' 가 아니다 (이 검사가 그걸 잡았다).
     남은 자리를 세는 것은 --dry-run 쪽이고, 그 둘이 어긋나면 안 된다. */
  check("★ 그런데 폴백 행 수는 0 이다 — '남은 일' 의 척도가 아니다",
    trial.leftoverFallback === 0, `${trial.leftoverFallback}행`);
  const afterTrial = await planPregen(PDB, planOpts, quiet, null);
  check("★ 남은 자리는 --dry-run 이 센다 (전체 − 만든 것)",
    afterTrial.estimate.calls === plan.estimate.calls - 3,
    `${afterTrial.estimate.calls} vs ${plan.estimate.calls} - 3`);
  for (const f of [PDB, `${PDB}-wal`, `${PDB}-shm`]) rmSync(f, { force: true });

  section("⑨-d preflight — 운영 콘텐츠로 실제 판정을 내린다");
  /* ★ 왜 이게 검사로 부족하고 도구가 따로 필요한가: 검사는 test/fixture.ts 의
     고정 세계로 돈다 (CLAUDE.md). 그래서 "지금 커밋의 **운영** 콘텐츠로
     서버가 뜨는가" 를 구조적으로 볼 수 없다. 그 답을 알게 되는 자리가
     지금까지는 fly deploy 뒤의 로그였다. */
  /* ★ 이 절이 도는 시점의 dist/ 는 이 검사가 ① 앞에서 깐 60바이트 가짜다.
     그래서 preflight 를 두 번 부른다 — 진짜처럼 번들을 참조하는 것 하나와
     그 가짜 하나. 앞은 '운영 콘텐츠로 통과한다' 를, 뒤는 '가짜를 잡는다' 를
     본다. 가짜는 지어낸 것이 아니라 이 검사가 실제로 깔던 그 파일이다. */
  const FAKE_INDEX = readFileSync("dist/index.html", "utf8");
  writeFileSync("dist/index.html",
    '<!doctype html><title>지하 1층</title><script type="module" src="/assets/index-AAA111.js"></script><div id="root"></div>');

  const preLog: string[] = [];
  /* ★ counter=null. 안 주면 키가 있는 기계에서만 count_tokens 로 네트워크에
     나가고, 그러면 같은 커밋이 기계에 따라 다르게 돈다 — 키 없는 기계는
     영원히 초록, 키 있는 기계는 가끔 빨강이고 그 빨강이 회귀가 아니다. */
  const pre1 = await runPreflight((s) => preLog.push(s), null);
  check("★ 지금 커밋의 운영 콘텐츠로 preflight 가 통과한다", pre1.ok,
    preLog.filter((l) => l.includes("FAIL")).join(" | "));
  check("빈 DB 에 마이그레이션이 전부 걸린다고 말한다",
    preLog.some((l) => l.includes("스키마 v") && l.includes("시드")),
    preLog.find((l) => l.includes("스키마")) ?? "없음");
  check("배포 뒤에만 닫히는 것을 목록으로 남긴다 (조용히 빠뜨리지 않는다)",
    preLog.some((l) => l.includes("/data 소유권")) &&
      preLog.some((l) => l.includes("MUD_TRUST_PROXY")));
  /* ★ 체크리스트가 '안 찍히는 로그 줄' 을 가리키면 안 된다. 새 DB 의 v1 은
     schema.sql 이 조용히 만들고 로그 루프는 v2 부터 돈다 — v0 -> v1 을 찾으라고
     하면 사람이 정상 부팅을 실패로 읽는다. */
  check("★ 체크리스트가 실제로 찍히는 로그 줄을 가리킨다 (v0 -> v1 은 안 찍힌다)",
    preLog.some((l) => l.includes("schema v1 -> v2")) &&
      !preLog.some((l) => l.includes("v0 -> v1")),
    preLog.find((l) => l.includes("schema v")) ?? "없음");

  /* ★ 그리고 그 줄이 정말 안 찍히는지를 로그에서 직접 확인한다 — 체크리스트와
     서버가 어긋나면 어느 쪽이 틀렸는지 여기서 갈린다. */
  const BOOTLOG = join(tmpdir(), `mud-bootlog-${process.pid}.db`);
  for (const f of [BOOTLOG, `${BOOTLOG}-wal`, `${BOOTLOG}-shm`]) rmSync(f, { force: true });
  const bootLines: string[] = [];
  const realLog2 = console.log;
  console.log = (...a: unknown[]) => bootLines.push(a.map(String).join(" "));
  const fresh = boot(BOOTLOG, PORT + 30, { ...FIXTURE, llm: "off" });
  console.log = realLog2;
  await fresh.close();
  for (const f of [BOOTLOG, `${BOOTLOG}-wal`, `${BOOTLOG}-shm`]) rmSync(f, { force: true });
  check("★ 빈 DB 의 첫 부팅이 v1 -> v2 부터 찍는다 (v0 -> v1 은 없다)",
    bootLines.some((l) => l.includes("schema v1 -> v2")) &&
      !bootLines.some((l) => l.includes("v0 -> v1")),
    bootLines.filter((l) => l.includes("schema")).join(" | ") || "없음");

  /* ★ mtime 만 보면 '방금 만든 가짜' 가 통과한다. 그 가짜로 npm start 를 하면
     게임이 아니라 빈 페이지가 서빙된다. */
  writeFileSync("dist/index.html", FAKE_INDEX);
  const fakeLog: string[] = [];
  const preFake = await runPreflight((s) => fakeLog.push(s), null);
  check("★ 번들을 참조하지 않는 dist 를 가짜로 잡는다 (mtime 만 보면 통과한다)",
    !preFake.ok && fakeLog.some((l) => l.startsWith("  FAIL") && l.includes("번들을 참조하지 않는다")),
    fakeLog.filter((l) => l.includes("dist")).join(" | ") || "없음");

  /* ★ 이 도구는 저장소 루트 전용이다. 컨테이너 안에는 client/ 도 Dockerfile 도
     없어서 (이미지는 dist/·server/·shared/·content/ 만 COPY 한다) 거기서 돌리면
     ENOENT 스택 트레이스가 났고, 그건 '배포가 잘못됐다' 로 읽힌다. */
  const backHome = process.cwd();
  const elsewhere = join(tmpdir(), `mud-notrepo-${process.pid}`);
  mkdirSync(elsewhere, { recursive: true });
  const awayLog: string[] = [];
  process.chdir(elsewhere);
  let away: Awaited<ReturnType<typeof runPreflight>>;
  try {
    away = await runPreflight((s) => awayLog.push(s), null);
  } finally {
    process.chdir(backHome);
  }
  rmSync(elsewhere, { recursive: true, force: true });
  check("★ 저장소 밖에서 부르면 스택이 아니라 '여기서는 못 돈다' 로 끝난다",
    !away.ok && awayLog.some((l) => l.includes("여기서는 돌 수 없다")),
    JSON.stringify([away, awayLog.slice(0, 2)]));
  check("그리고 컨테이너에서 쓸 수 있는 것을 알려 준다",
    awayLog.some((l) => l.includes("pregen") && l.includes("backup") && l.includes("restore")),
    awayLog.join(" ").slice(0, 160));

  /* ★ 돌연변이: 운영 콘텐츠가 깨지면 빨개져야 한다. 안 그러면 이 도구는
     '언제나 초록' 이고, 언제나 초록인 관문은 관문이 아니다. */
  const savedWorld = process.env.MUD_WORLD;
  process.env.MUD_WORLD = join(tmpdir(), `mud-no-world-${process.pid}`);
  const mutLog: string[] = [];
  const pre2 = await runPreflight((s) => mutLog.push(s), null);
  if (savedWorld === undefined) delete process.env.MUD_WORLD;
  else process.env.MUD_WORLD = savedWorld;
  check("★ 운영 콘텐츠가 깨지면 preflight 가 빨개진다 (관문이 실재한다)",
    !pre2.ok && pre2.fails > 0, JSON.stringify(pre2));
  /* ★ 등급까지 본다. 문구만 보면 같은 줄이 '경고' 로 내려앉아도 통과하고,
     그러면 이 검사가 등급을 하나도 안 지키게 된다 (돌연변이가 잡았다). */
  check("그리고 그것을 '경고' 가 아니라 '실패' 로 말한다",
    mutLog.some((l) => l.startsWith("  FAIL") && l.includes("부팅에서 죽는다")),
    mutLog.filter((l) => l.includes("부팅에서 죽는다")).join(" | ") || "없음");

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
  restoreDist();

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${checks - failures}/${checks} 검사 통과`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
