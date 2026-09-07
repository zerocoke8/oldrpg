/* 배포 직전의 자기점검.  npm run preflight
 *
 * ★ 왜 test:all 로 부족한가: 검사는 test/fixture.ts 의 **고정 세계**로 돈다
 *   (CLAUDE.md: "게임 내용을 바꿨는데 프로토콜 검사가 깨지면 그건 결합이다").
 *   그래서 "지금 커밋의 **운영 콘텐츠**로 서버가 실제로 뜨는가" 를 검사는
 *   구조적으로 볼 수 없다. 그 질문의 답이 '아니오' 인 것을 알게 되는 자리가
 *   지금까지는 `fly deploy` 뒤의 로그였다. 이 도구가 그 자리를 앞으로 당긴다.
 *
 * ★ 이 도구가 답하는 질문은 하나다: **이 커밋을, 지금, 배포해도 되는가.**
 *   그래서 여기서 보는 것은 전부 '이번 배포에 고유한' 것이다 —
 *   Dockerfile 의 자기 정합처럼 커밋마다 같은 것은 test/deploy.ts ⓪ 가 본다.
 *   (⑥ 의 fly.toml 대조만 예외다. 그 파일은 배포 몇 분 전에 사람이 손대는
 *   유일한 파일이라, 오타 하나를 잡으려고 검사 전체를 돌리게 하면 안 돈다.)
 *
 * ★ 통과가 '배포가 성공한다' 는 뜻은 아니다. 마지막 절이 **배포 뒤에만
 *   닫히는 것들** 을 명시적으로 남긴다 — 조용히 빠뜨리는 대신 목록으로
 *   내놓는다. 무엇을 모르는지 아는 것이 검사의 절반이다. */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBalance } from "../content/balance";
import { loadWorld } from "../content/world";
import { makeMap } from "../engine/map";
import { loadTones } from "../narration/prompts";
import { boot } from "../index";
import { planPregen } from "./pregen";
import type { TokenCounter } from "./cost";

type Level = "ok" | "warn" | "fail";

export interface PreflightReport {
  ok: boolean;
  fails: number;
  warns: number;
}

/** 배포 뒤에 사람이 눈으로 확인해야만 닫히는 것들. 코드로 만들 수 없어서
 *  목록으로 있는 것이지, 덜 중요해서 목록인 것이 아니다. 각 줄은 '무엇을
 *  보면 아는가' 를 함께 준다 — 그게 없으면 이건 그냥 걱정 목록이다. */
const AFTER_DEPLOY: { what: string; how: string }[] = [
  {
    what: "/data 소유권 — 볼륨은 root 소유로 마운트되고 컨테이너는 node 로 돈다",
    how: 'fly logs 에 "를 열 수 없다" 가 보이면 fly ssh console -C "chown -R 1000:1000 /data"',
  },
  {
    what: "MUD_TRUST_PROXY 가 맞는 홉 수인가 — 틀려도 아무 일도 안 일어난다",
    how: 'fly logs | grep "IP 판정" — 첫 연결에서 실제 X-Forwarded-For 를 한 줄로 찍는다',
  },
  {
    what: "better-sqlite3 가 이미지 안에서 실제로 빌드/적재되는가",
    /* ★ v0 -> v1 은 안 찍힌다. 새 DB 의 v1 은 schema.sql 이 조용히 만들고
       (migrate.ts), 로그를 남기는 루프는 v2 부터 돈다. 없는 줄을 찾으라고
       하면 사람이 '실패했다' 고 읽는다. */
    how: "fly logs 에 [db] schema v1 -> v2 … v5 -> v6 다섯 줄이 보이면 네이티브 애드온이 살아 있다",
  },
  {
    what: "머신이 하나뿐인가 — 둘이면 세계가 둘이다",
    how: "fly status (fly scale count 1 로 고정)",
  },
  {
    what: "백업이 기계 밖으로 나가는가 — 볼륨과 함께 사라지면 백업이 아니다",
    how: "npm run backup 뒤 그 파일을 fly ssh sftp get 으로 내려받아 보관",
  },
];

export async function runPreflight(
  log: (s: string) => void = console.log,
  /** 입력 토큰을 셀 사람. 기본은 '키가 있으면 센다' 이고, null 이면 안 센다.
   *  ★ 검사가 null 을 준다. 안 그러면 키가 있는 기계에서만 이 도구가
   *    네트워크로 나가고, 그러면 같은 커밋이 기계에 따라 다르게 돈다 —
   *    BootOptions.llm 이 "off" 를 가진 것과 정확히 같은 이유다. */
  counter: TokenCounter | null | undefined = undefined,
): Promise<PreflightReport> {
  let fails = 0;
  let warns = 0;
  const say = (level: Level, label: string, detail = ""): void => {
    if (level === "fail") fails++;
    if (level === "warn") warns++;
    const mark = level === "ok" ? "  ok  " : level === "warn" ? "  경고" : "  FAIL";
    log(`${mark} ${label}${detail ? `\n       ${detail}` : ""}`);
  };
  const section = (s: string): void => log(`\n${s}`);

  /* ★ 이 도구는 **저장소 루트 전용**이다. 컨테이너 안에는 client/ 도
     Dockerfile 도 없다 (이미지는 dist/·server/·shared/·content/ 만 COPY 한다).
     거기서 돌리면 지금까지는 ENOENT 스택 트레이스가 나왔고, 그건 '배포가
     잘못됐다' 로 읽힌다 — 실제로는 도구를 잘못된 곳에서 부른 것뿐이다.
     컨테이너 안에서 쓸 수 있는 것은 pregen · backup · restore 셋이다. */
  const missing = ["Dockerfile", "client", "shared", ".dockerignore"].filter((f) => !existsSync(f));
  if (missing.length) {
    log(
      `[preflight] 여기서는 돌 수 없다 — ${missing.join(", ")} 가 없다.\n` +
        "[preflight] 이 도구는 배포 '전에' 저장소 루트에서 돈다. 컨테이너 안이라면\n" +
        "[preflight] 쓸 수 있는 것은 pregen · backup · restore 셋뿐이다.",
    );
    return { ok: false, fails: 1, warns: 0 };
  }

  // ── ① 운영 콘텐츠 ────────────────────────────────────────────────────
  section("① 운영 콘텐츠 — content/ 가 실제로 로드되고 검증을 통과하는가");
  let map: ReturnType<typeof makeMap> | null = null;
  try {
    const world = loadWorld();
    loadBalance();
    map = makeMap(world);
    const rooms = map.rooms().length;
    const npcs = map.npcs().length;
    say(
      "ok",
      `지역 ${world.regions.length} · 방 ${rooms} · NPC ${npcs} · ` +
        `플래그 ${Object.keys(world.flags).length} · 임무 ${world.missions.length}`,
      `content_hash=${map.contentHash().slice(0, 12)}…`,
    );
    /* ★ 지역당 방 수는 게임성 결정이다 (CLAUDE.md: "지역은 50방쯤으로
       유지한다"). 넘으면 반경 기반 canSee·창 미니맵·스냅샷 분할이 한꺼번에
       필요해지는데, 그 필요는 배포한 뒤 사람이 붐빌 때 나타난다. */
    for (const r of world.regions) {
      const n = map.rooms().filter((room) => room.id.startsWith(`${r.id}:`)).length;
      if (n > 80) say("warn", `지역 ${r.id} 이 ${n}방이다 (권장 50 안팎)`, "스냅샷이 커진다 — 지역을 쪼갤 것");
    }
    /* 톤 파일이 없는 지역은 조용히 전역 꼬리로 떨어진다. 죽지 않으므로
       배포해도 아무도 모르고, 그 지역만 목소리가 없는 채로 생성된다. */
    const tones = loadTones();
    const toneless = world.regions.filter((r) => !tones.has(r.id)).map((r) => r.id);
    if (toneless.length) {
      say("warn", `톤 파일이 없는 지역: ${toneless.join(", ")}`,
        "narration/prompts/tones/<지역>.md — 없으면 그 지역만 전역 꼬리로 생성된다");
    } else {
      say("ok", "지역마다 톤 파일이 있다");
    }
  } catch (err) {
    say("fail", "content/ 로드 실패 — 이 상태로 배포하면 컨테이너가 부팅에서 죽는다",
      err instanceof Error ? err.message : String(err));
  }

  // ── ② 부팅 ──────────────────────────────────────────────────────────
  section("② 부팅 — 빈 DB 에 운영 콘텐츠로 실제로 뜨는가 (마이그레이션 + 시드)");
  const TMP = join(tmpdir(), `mud-preflight-${process.pid}.db`);
  for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) rmSync(f, { force: true });
  let booted = false;
  try {
    /* 포트 0 = 커널이 빈 포트를 준다. llm:"off" — 점검이 돈을 쓰면 안 된다. */
    const server = boot(TMP, 0, { llm: "off" });
    booted = true;
    const version = server.ctx.q.getMeta.get("schema_version")?.value ?? "?";
    await server.close();
    say("ok", `빈 DB 에서 스키마 v${version} 까지 올라가고 시드가 돌았다`);
  } catch (err) {
    say("fail", "운영 콘텐츠로 부팅에 실패했다", err instanceof Error ? err.message : String(err));
  }

  // ── ③ 클라이언트 번들 ────────────────────────────────────────────────
  section("③ 클라이언트 — dist/ 가 있고 소스보다 새 것인가");
  /* ★ 이미지는 dist/ 를 빌드 스테이지에서 다시 만든다. 그런데 로컬의 낡은
     dist/ 는 `npm run dev` 와 이 점검에서 여전히 쓰이고, 무엇보다 '빌드가
     지금 코드로 통과하는가' 를 여기서 알아야 배포 사이클을 안 버린다. */
  if (!existsSync("dist/index.html")) {
    say("fail", "dist/index.html 이 없다", "npm run build");
  } else {
    /* ★ mtime 만 보면 '새 것' 인 가짜가 통과한다. test/deploy.ts 가 dist/ 를
       치우고 60바이트짜리 가짜를 깔았다가 되돌리는데, 검사가 중간에 죽으면
       그 가짜가 남는다 — 그리고 그 가짜의 mtime 은 방금이라 ③ 이 ok 를 찍는다.
       진짜 vite 산출물은 /assets/ 번들을 참조한다. 그것만 보면 갈린다. */
    const html = readFileSync("dist/index.html", "utf8");
    if (!/\/assets\/[^"']+\.js/.test(html)) {
      say("fail", "dist/index.html 이 번들을 참조하지 않는다 — 진짜 빌드가 아니다",
        `${html.length}바이트: ${html.slice(0, 70)}`);
    }
    const distAt = statSync("dist/index.html").mtimeMs;
    const newest = (dir: string): number => {
      let max = 0;
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        const p = join(dir, e.name);
        max = Math.max(max, e.isDirectory() ? newest(p) : statSync(p).mtimeMs);
      }
      return max;
    };
    const srcAt = Math.max(
      newest("client"),
      newest("shared"),
      statSync("vite.config.ts").mtimeMs,
      existsSync("index.html") ? statSync("index.html").mtimeMs : 0,
    );
    if (srcAt > distAt) {
      say("warn", "dist/ 가 client/·shared/ 보다 오래됐다", "npm run build (이미지는 어차피 다시 빌드한다)");
    } else {
      say("ok", "dist/ 가 소스보다 새 것이다");
    }
  }

  // ── ④ 비밀 ──────────────────────────────────────────────────────────
  section("④ 비밀 — 키가 이미지나 커밋으로 새지 않는가");
  /* ★ 이 절만은 '되돌릴 수 없는' 실패를 막는다. 나머지는 다시 배포하면
     되지만, 키가 이미지 레이어나 커밋에 한 번 굽히면 그 키는 죽은 키다. */
  const listed = (file: string, needle: string): boolean =>
    existsSync(file) &&
    readFileSync(file, "utf8").split("\n").map((l) => l.trim()).includes(needle);
  say(listed(".dockerignore", ".env") ? "ok" : "fail",
    ".env 가 .dockerignore 에 있다 (없으면 COPY . . 이 키를 이미지에 굽는다)");
  say(listed(".gitignore", ".env") ? "ok" : "fail", ".env 가 .gitignore 에 있다");
  if (existsSync("fly.toml")) {
    const fly = readFileSync("fly.toml", "utf8");
    const leaks = /ANTHROPIC|_KEY|SECRET|TOKEN/i.test(fly);
    say(leaks ? "fail" : "ok",
      "fly.toml 에 비밀이 없다 (fly.toml 은 커밋된다 — 키는 fly secrets set)",
      leaks ? "fly.toml 에서 지우고 fly secrets set ANTHROPIC_API_KEY=... 로 줄 것" : "");
  }
  try {
    /* 커밋되지 않은 변경이 있으면 배포된 세계와 저장소의 커밋이 어긋난다.
       그 순간 백업의 content_hash 가 '어느 커밋의 세계인가' 를 못 가리킨다. */
    const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim();
    say(dirty ? "warn" : "ok",
      dirty ? "커밋되지 않은 변경이 있다" : "작업 트리가 깨끗하다",
      dirty ? "백업의 content_hash 가 어느 커밋의 세계인지 못 가리킨다" : "");
  } catch {
    /* git 이 없는 곳에서도 나머지 점검은 돌아야 한다. */
  }

  // ── ⑤ 선생성 ────────────────────────────────────────────────────────
  section("⑤ 선생성 — 배포 직후에 무엇을, 몇 번, 얼마에 부르는가");
  const hasKey = Boolean(process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN);
  say(hasKey ? "ok" : "warn",
    hasKey ? "ANTHROPIC_API_KEY 가 있다" : "ANTHROPIC_API_KEY 가 없다",
    hasKey ? "" : "선생성 없이 배포해도 게임은 돈다 (첫 입장이 폴백을 본다). 키는 fly secrets set 으로 준다");
  if (booted) {
    /* ★ 이 수는 '빈 DB 기준' 이다. 이미 도는 서버를 갱신하는 중이라면 운영
       DB 의 백업을 받아 MUD_DB 로 가리키면 남은 자리만 나온다. */
    await planPregen(TMP, { llm: "off" }, log, counter);
    log("       (빈 DB 기준이다. 갱신 배포라면 운영 백업을 MUD_DB 로 가리킬 것)");
  }
  for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) rmSync(f, { force: true });

  // ── ⑥ fly.toml ──────────────────────────────────────────────────────
  section("⑥ fly.toml — 배포 몇 분 전에 사람이 손대는 유일한 파일");
  if (!existsSync("fly.toml")) {
    say("warn", "fly.toml 이 없다", "fly launch --no-deploy");
  } else {
    const fly = readFileSync("fly.toml", "utf8");
    const df = readFileSync("Dockerfile", "utf8").replace(/\\\n\s*/g, " ");
    const flyStr = (k: string): string | undefined =>
      new RegExp(`^\\s*${k}\\s*=\\s*['"]([^'"]+)['"]`, "m").exec(fly)?.[1];
    const flyNum = (k: string): string | undefined =>
      new RegExp(`^\\s*${k}\\s*=\\s*(\\d+)`, "m").exec(fly)?.[1];
    const envOf = (k: string): string | undefined => new RegExp(`\\b${k}=(\\S+)`).exec(df)?.[1];
    const dataDir = envOf("MUD_DB")?.replace(/\/[^/]+$/, "");
    say(flyStr("destination") === dataDir ? "ok" : "fail",
      `볼륨 목적지 ${flyStr("destination")} = MUD_DB 의 디렉터리 ${dataDir}`);
    say(flyNum("internal_port") === envOf("MUD_PORT") ? "ok" : "fail",
      `internal_port ${flyNum("internal_port")} = MUD_PORT ${envOf("MUD_PORT")}`);
    const awake = flyStr("auto_stop_machines") === "off";
    say(awake ? "ok" : "fail", "머신이 잠들지 않는다 (auto_stop_machines = off)",
      awake ? "" : "잠들면 메모리의 권위 상태 — 전투·리스폰·큐 — 가 통째로 사라진다");
    say(Number(flyNum("min_machines_running") ?? 0) >= 1 ? "ok" : "fail",
      "항상 하나는 떠 있다 (min_machines_running >= 1)");
    say(flyStr("app") ? "ok" : "fail", `app = ${flyStr("app")} · region = ${flyStr("primary_region")}`);
  }

  // ── ⑦ 배포 뒤에만 닫히는 것 ──────────────────────────────────────────
  section("⑦ 이 도구가 확인하지 '못하는' 것 — 배포 뒤 눈으로 닫는다");
  for (const item of AFTER_DEPLOY) log(`  □ ${item.what}\n       ${item.how}`);

  log("");
  if (fails > 0) log(`[preflight] ★ 실패 ${fails} · 경고 ${warns}. 고치고 다시 돌릴 것.`);
  else log(`[preflight] 통과 (경고 ${warns}). ⑦ 의 목록을 손에 들고 배포할 것.`);
  return { ok: fails === 0, fails, warns };
}

/* tsx 로 이 파일을 '직접' 실행할 때만 돈다 (pregen·backup·restore 와 같은 관용구). */
const isEntry = (() => {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return realpathSync(arg) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isEntry) {
  runPreflight()
    .then((r) => process.exit(r.ok ? 0 : 1))
    .catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
}
