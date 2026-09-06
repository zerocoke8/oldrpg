/* 부팅. 그리고 '유일한 조합 지점'.
 *
 * engine/ 은 db/ 를 모르고, narration/ 은 engine/ 과 db/ 를 모른다
 * (.eslintrc.cjs 가 빌드 에러로 강제). 그 셋을 아는 파일은 여기와
 * world/roomText.ts 둘뿐이다. */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openDb } from "./db/open";
import { migrate } from "./db/migrate";
import { makeQueries } from "./db/queries";
import { loadFlags, seed } from "./db/seed";
import { loadBalance } from "./content/balance";
import { loadWorld } from "./content/world";
import { makeMap, type MapData } from "./engine/map";
import { World } from "./engine/world";
import { makeStaticNpcRenderer, makeStaticRenderer } from "./narration/static";
import { makeLlmNpcRenderer, makeLlmRenderer } from "./narration/llm";
import { loadMoods, loadTails, type Mood } from "./narration/prompts";
import { makeRoomTextService } from "./world/roomText";
import { makeNpcTextService } from "./world/npcText";
import { makeDialogue } from "./world/dialogue";
import { makeInventory } from "./world/inventory";
import { makeGuild } from "./world/guild";
import { makeUpgradeService } from "./world/upgrade";
import { makeEvents } from "./world/events";
import { makeCombat, type CombatOptions } from "./world/combat";
import { makeEmit } from "./net/emit";
import { makePresence } from "./net/presence";
import { Registry } from "./net/session";
import { startServer } from "./net/server";
import { enqueueRoomText, type Ctx } from "./net/handlers";
import { roomIdOf } from "../shared/ids";
import type { RoomId } from "../shared/ids";
import type { NpcBrief } from "../shared/protocol";
import type { Session } from "./net/session";
import type { ErrorEvent } from "../shared/protocol";
import type { NpcLineRenderer, RoomTextRenderer } from "../shared/narration";
import type { Balance } from "./engine/enemies";
import type { QueueOptions } from "./narration/queue";
import type { UpgradeService } from "./world/upgrade";
import type { EventService } from "./world/events";
import type { CombatService } from "./world/combat";

/** 승급 경로가 없을 때 (API 키 없음). 아무것도 하지 않는다. */
const NO_UPGRADES: UpgradeService = {
  watch: () => {},
  enqueue: () => false,
  idle: () => Promise.resolve(),
  stop: () => {},
  stats: () => ({ pending: 0, running: 0, done: 0, failed: 0, givenUp: 0, watching: 0 }),
};

/* .env 를 읽는다 (charter: 키는 .env). Node 22 의 내장 기능이라 의존성이 없다.
   파일이 없어도 정상이다 — 그때는 LLM 없이 1단계와 똑같이 돈다. */
try {
  process.loadEnvFile(".env");
} catch {
  /* .env 없음 */
}

const DB_PATH = process.env.MUD_DB ?? "mud.db";
const PORT = Number(process.env.MUD_PORT ?? 8787);

export interface BootOptions {
  /** 밸런스를 갈아끼운다. 테스트가 수치를 손에 쥐는 자리이고, 지정하지 않으면
   *  content/balance/ 를 읽는다 (MUD_BALANCE 로도 갈아끼울 수 있다). */
  balance?: Balance;
  /** 세계(지역)를 갈아끼운다. 지정하지 않으면 content/world/ 를 읽는다
   *  (MUD_WORLD 로도 갈아끼울 수 있다). 테스트가 작은 세계를 손에 쥐는 자리다. */
  world?: MapData;
  /** 실물 모델 호출을 통째로 끈다 ("off"). 주입된 가짜 렌더러는 그대로 쓴다.
   *
   *  ★ 왜 필요한가: 렌더러를 '안 꽂은 것' 이 곧 '네트워크로 나가는 것' 이었다.
   *    테스트는 두 렌더러 중 필요한 쪽만 꽂는 것이 자연스러운데, 안 꽂은 쪽은
   *    .env 에 키가 있는 기계에서 실물 API 로 나갔다 — 키 없는 기계는 영원히
   *    초록, 키 있는 기계는 빨강이고, 그 빨강이 진짜 회귀가 아니라서 사람이
   *    빨강을 무시하는 법을 배운다. 기본값이 위험한 쪽이면 안 된다.
   *    환경변수 MUD_NO_LLM=1 도 같은 뜻이다. */
  llm?: "auto" | "off";
  /** 테스트가 가짜 렌더러를 꽂는 자리. 지정하면 API 키 여부와 무관하게 이걸 쓴다. */
  llmRenderer?: RoomTextRenderer;
  /** NPC 대사의 가짜 렌더러. 방과 따로인 이유: 4b 테스트는 대사만 승급시키고
   *  방 묘사는 폴백으로 두고 싶다 (그 반대도 마찬가지). */
  llmNpcRenderer?: NpcLineRenderer;
  /** 플래그별 톤·문장을 갈아끼운다. 지정하지 않으면 narration/prompts/moods/ 를 읽는다.
   *  세계·밸런스와 같은 이유의 주입이다 — 검사가 운영 문구에 매달리지 않게. */
  moods?: ReadonlyMap<string, Mood>;
  /** 큐 옵션 (테스트에서 동시성/쿨다운을 조인다). */
  queue?: QueueOptions;
  /** 전투 옵션 (테스트가 시계와 시드를 손에 쥔다). */
  combat?: CombatOptions;
}

export function boot(dbPath = DB_PATH, port = PORT, options: BootOptions = {}) {
  const clock = () => Date.now();

  /* ★ 데이터를 가장 먼저 읽는다. 잘못된 값이면 DB 를 열기도 전에 죽는 편이
     낫다 — 조용히 이상한 세계로 도는 것보다.

     여기가 유일한 조합 지점이다: 파일을 읽는 것은 server/content/ 가 하고,
     engine/ 은 그 결과를 주입받기만 한다 (난수·시계·렌더러와 같은 방식). */
  const balance = options.balance ?? loadBalance();
  const map = makeMap(options.world ?? loadWorld());

  const db = openDb(dbPath);
  migrate(db, clock());
  const q = makeQueries(db);
  const { seededRooms, reaped } = seed(db, q, map, balance, clock());

  const world = new World(map);
  world.load(loadFlags(q)); // DB -> 메모리. engine/ 이 db/ 를 import 하지 않는 이유.

  /* 종료 플래그. 두 곳이 본다:
       - handleClose: db.close() 뒤에 도착하는 소켓 close 이벤트가 닫힌 핸들에
         쓰면 ws 의 이벤트 핸들러 안에서 던져 uncaughtException 이 된다.
       - upgrade(): 렌더러가 해소되는 사이 서버가 내려갔을 수 있다. */
  let shuttingDown = false;

  const reg = new Registry();
  const emit = makeEmit(reg);
  /* presence 는 world/events 를 import 하지 않는다 (순환). 늦게 바인딩한다. */
  let events: EventService | null = null;
  let combat: CombatService | null = null;
  let npcsIn: ((roomId: RoomId) => NpcBrief[]) | null = null;
  /* 가방은 메모리 사본이 없어 DB 만 읽으면 되므로, 늦은 바인딩이 필요 없다. */
  const inventory = makeInventory(q, reg, emit, balance, clock, (fn: () => void) => db.transaction(fn)());
  const guild = makeGuild(q, emit, map, balance, clock, (fn: () => void) => db.transaction(fn)(),
    (s: Session) => inventory.push(s));
  const presence = makePresence(
    reg,
    emit,
    map,
    () => events?.publicFlags() ?? [],
    (id) => combat?.viewFor(id) ?? null,
    (roomId) => Boolean(combat?.enemyIn(roomId)),
    (roomId) => npcsIn?.(roomId) ?? [],
    (playerId) => inventory.of(playerId),
    (rank) => guild.view(rank),
  );

  /* ── 서술 레이어 ────────────────────────────────────────────────────
     폴백 렌더러는 '플레이어의 경로' 에 있고, LLM 렌더러는 '백그라운드 큐' 에만
     있다. 이 분리가 규칙 4를 코드 구조로 만든 것이다 — 요청 경로에 모델
     호출이 아예 없으므로 실수로 기다리게 만들 방법이 없다. */
  const moods = options.moods ?? loadMoods();
  const tails = loadTails();
  const fallbackRenderer = makeStaticRenderer(moods, tails);
  const fallbackNpcRenderer = makeStaticNpcRenderer(moods, tails);

  /* 실물 호출은 '명시적으로 끄지 않았고' + '키가 있을 때' 만 켜진다.
     끔이 우선한다 — 키의 존재가 조용히 네트워크를 여는 일이 없어야 한다. */
  const llmOff = options.llm === "off" || process.env.MUD_NO_LLM === "1";
  const hasKey =
    !llmOff && Boolean(process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN);
  const llmRenderer =
    options.llmRenderer ?? (hasKey ? makeLlmRenderer(moods, fallbackRenderer) : null);
  const llmNpcRenderer =
    options.llmNpcRenderer ?? (hasKey ? makeLlmNpcRenderer(moods, fallbackNpcRenderer) : null);

  const roomText = makeRoomTextService(world, q, fallbackRenderer, clock);
  const npcText = makeNpcTextService(world, q, fallbackNpcRenderer, clock);
  const upgrades =
    llmRenderer || llmNpcRenderer
      ? makeUpgradeService(
          world,
          q,
          llmRenderer,
          llmNpcRenderer,
          emit,
          clock,
          () => shuttingDown,
          options.queue ?? {},
        )
      : // 키가 없으면 승급 경로가 통째로 없다. 게임은 1단계와 똑같이 돈다.
        NO_UPGRADES;

  events = makeEvents(world, map, q, reg, emit, moods, roomText, npcText, upgrades, clock);
  /* 대화는 engine(누가 있나) + npcText(대사) + upgrades(승급) 를 조합한다.
     presence 보다 뒤에 만들어지므로 npcsIn 은 위에서 늦게 바인딩한다. */
  const dialogue = makeDialogue(world, map, npcText, upgrades, emit);
  npcsIn = dialogue.npcsIn;
  const combatSvc = makeCombat(q, reg, emit, events, inventory, map, balance, clock, options.combat ?? {});
  combat = combatSvc;

  const ctx: Ctx = {
    reg,
    emit,
    presence,
    map,
    world,
    q,
    roomText,
    upgrades,
    combat: combatSvc,
    dialogue,
    inventory,
    guild,
    balance,
    clock,
    isShuttingDown: () => shuttingDown,
  };
  /* 부활하면 스폰의 묘사를 다시 보낸다. combat 이 net/handlers 를 import 하지
     않도록(순환) 여기서 꽂는다 — index.ts 가 조합 지점이라는 원칙 그대로다. */
  (combatSvc as unknown as { setOnRespawn(fn: (s: Session) => void): void }).setOnRespawn((s) => {
    emit.send(s, { t: "room.describe", room: presence.roomView(s.pos, s) });
    enqueueRoomText(ctx, s, roomIdOf(s.pos));
  });
  /* 적이 돌아왔다 = 그 방의 '구조화 상태' 가 바뀌었다. 묘사는 보내지 않는다 —
     서 있는 사람의 화면을 갈아치우지 않는 것이 charter 63줄이다. */
  (
    combatSvc as unknown as { setOnRoomChanged(fn: (s: Session) => void): void }
  ).setOnRoomChanged((s) => {
    emit.send(s, { t: "room.describe", room: presence.roomView(s.pos, s) });
  });

  const listening = startServer(ctx, port);
  const wss = listening.wss;

  console.log(
    `[mud] ws://localhost:${port} · db=${dbPath} · rooms=${world.allRoomIds().length}` +
      (seededRooms ? ` (시드 ${seededRooms}행)` : "") +
      (reaped ? ` · 유령 플레이어 ${reaped}행 정리` : ""),
  );
  /* 두 렌더러를 따로 찍는다. 한 줄로 방 렌더러만 보고 말하면, NPC 렌더러가
     실물인 채로 "주입된 렌더러" 라고 말하는 거짓말이 된다 — 실제로 그랬다. */
  const model = process.env.MUD_MODEL ?? "claude-opus-5";
  const label = (injected: unknown, live: unknown): string =>
    injected ? "주입" : live ? model : "폴백";
  console.log(
    `[mud] 서술: 방=${label(options.llmRenderer, llmRenderer)} · ` +
      `NPC=${label(options.llmNpcRenderer, llmNpcRenderer)}` +
      (llmOff
        ? " · 실물 모델 호출 꺼짐 (llm:\"off\" / MUD_NO_LLM=1)"
        : hasKey
          ? " · 백그라운드 승급"
          : " · ANTHROPIC_API_KEY 가 없다 (.env 를 만들면 켜진다)"),
  );

  /* 3단계를 손으로 몰아 보는 개발용 입구.
     4단계 전투가 events.setFlag() 를 부르게 되면 이건 그냥 편의 도구로 남는다.
     프로토콜 표면이 0 이라 (액션 유니온에 디버그 동사를 넣지 않았다)
     클라이언트에는 아무 영향이 없다.
       서버 콘솔에:  flag guardian_slain true
     MUD_DEV=1 일 때만 붙는다. */
  if (process.env.MUD_DEV === "1" && process.stdin.isTTY) {
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      for (const line of String(chunk).split("\n")) {
        const m = /^\s*flag\s+(\S+)\s+(\S+)\s*$/.exec(line);
        if (!m) continue;
        try {
          const value = JSON.parse(m[2]!) as Parameters<EventService["setFlag"]>[1];
          const r = events!.setFlag(m[1]!, value);
          console.log(`[dev] flag ${m[1]} = ${m[2]}`, JSON.stringify(r));
        } catch (err) {
          console.error("[dev]", err instanceof Error ? err.message : err);
        }
      }
    });
    process.stdin.unref();
    console.log(`[dev] 콘솔에 "flag guardian_slain true" 로 세계를 바꿀 수 있다`);
  }

  return {
    ctx,
    wss,
    upgrades,
    events,
    combat: combatSvc,
    npcText,
    balance,
    close: () =>
      new Promise<void>((resolve) => {
        shuttingDown = true;
        upgrades.stop();
        combatSvc.stop_();
        // 유예 타이머를 먼저 끈다. 안 그러면 종료 후에 깨어나 없어진
        // 레지스트리에 대고 방출을 시도한다.
        for (const s of reg.all()) {
          if (s.linger) clearTimeout(s.linger);
          s.linger = null;
        }
        /* reg.all() 이 아니라 wss.clients 를 순회한다: hello 를 아직 보내지 않은
           소켓은 Session 이 없어 레지스트리에 없는데, 업그레이드된 소켓으로서
           http 서버의 연결 수에는 잡힌다. 그런 소켓 하나만 있어도
           wss.close() 의 콜백이 영영 호출되지 않아 종료가 멈춘다. */
        const bye: ErrorEvent = {
          t: "error",
          code: "shutdown",
          message: "서버가 종료됩니다.",
          reconnect: true,
        };
        for (const c of wss.clients) {
          try {
            c.send(JSON.stringify(bye));
          } catch {
            /* 이미 닫힘 */
          }
          c.terminate();
        }
        void listening.close().then(() => {
          db.close();
          resolve();
        });
      }),
  };
}

/* tsx 로 이 파일을 '직접' 실행할 때만 부팅한다.
   테스트는 boot() 를 직접 부르므로 여기를 타지 않는다. */
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
  const server = boot();
  /* 컨테이너는 SIGTERM 을 보내고 잠깐 기다린 뒤 죽인다. 그 잠깐 안에
     "서버가 종료됩니다" 를 보내고 DB 를 닫으면, 클라이언트는 재접속을
     시도하고(reconnect:true) WAL 은 깨끗하게 정리된다.
     두 번 와도 한 번만 돈다 — 급한 사람은 두 번 누른다. */
  let closing = false;
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      if (closing) process.exit(1);
      closing = true;
      console.log(`[mud] ${sig} — 종료합니다`);
      void server.close().then(() => process.exit(0));
    });
  }
}
