/* prompts/ 아래의 마크다운을 읽어 들인다.
 *
 * charter 139줄: "프롬프트는 narration/prompts/에 파일로 분리한다.
 * 코드에 인라인하지 않는다." 그래서 문장은 전부 파일에 있고 이 파일은
 * 자르고 치환하는 일만 한다.
 *
 * 부팅 때 한 번 읽고 메모리에 둔다 — 요청마다 디스크를 때리지 않는다. */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ESM 에는 __dirname 이 없다.
const HERE = dirname(fileURLToPath(import.meta.url));
const PROMPTS = join(HERE, "prompts");

/** `# 절이름` 으로 나뉜 마크다운을 { 절이름: 본문 } 으로. HTML 주석은 버린다. */
function sections(md: string): Record<string, string> {
  const body = md.replace(/<!--[\s\S]*?-->/g, "");
  const out: Record<string, string> = {};
  let name: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (name) out[name] = buf.join("\n").trim();
  };
  for (const line of body.split("\n")) {
    const m = /^#\s+(\S+)\s*$/.exec(line);
    if (m) {
      flush();
      name = m[1]!;
      buf = [];
    } else if (name) {
      buf.push(line);
    }
  }
  flush();
  return out;
}

export interface RoomPrompt {
  /** room_text.prompt_version 에 그대로 기록된다. 파일명이 곧 버전이다. */
  readonly version: string;
  readonly system: string;
  /** {{seed}} / {{mood}} 를 치환해 user 메시지를 만든다. */
  render(vars: { seed: string; mood: string }): string;
}

export function loadRoomPrompt(version = "room.v1.ko"): RoomPrompt {
  const raw = readFileSync(join(PROMPTS, `${version}.md`), "utf8");
  const s = sections(raw);
  if (!s.system || !s.user) {
    throw new Error(`${version}.md 에 '# system' 과 '# user' 절이 모두 있어야 한다`);
  }
  const system = s.system;
  const user = s.user;
  return {
    version,
    system,
    render: ({ seed, mood }) =>
      user.replace("{{seed}}", seed).replace("{{mood}}", mood ? `현재 이 구역의 상태: ${mood}` : "").trim(),
  };
}

export interface Mood {
  /** LLM 에게 주는 톤 지시. */
  readonly prompt: string;
  /** LLM 없이(또는 실패 시) 문장 뒤에 붙는 결정론적 한 문장. */
  readonly fallback: string;
}

/** prompts/moods/<flag>.md 를 전부 읽는다. 파일이 없는 플래그는 톤이 없는 것이고,
 *  그건 정상이다 — 모든 플래그가 묘사에 영향을 주지는 않는다. */
export function loadMoods(): Map<string, Mood> {
  const dir = join(PROMPTS, "moods");
  const out = new Map<string, Mood>();
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    const s = sections(readFileSync(join(dir, f), "utf8"));
    out.set(f.replace(/\.md$/, ""), {
      prompt: s.prompt ?? "",
      fallback: s.fallback ?? "",
    });
  }
  return out;
}
