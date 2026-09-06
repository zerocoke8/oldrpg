/* CLAUDE.md 규칙 1·2의 '기계적' 강제.
   charter 110줄("engine/이 narration/을 import 하는 코드가 생기면 규칙 1이 깨진 것이다")은
   주석으로 지킬 수 있는 문장이 아니라 import 검사로 쓰여 있다. 그래서 빌드 에러로 만든다.

   ★ 강제는 부르는 사람이 있어야 강제다. package.json 의 test:all 이 lint 와
     typecheck 를 먼저 돌린다 — 그 전에는 이 파일이 '선언' 이었지 관문이 아니었다.

   ★ 오버라이드에 no-restricted-syntax 를 넣지 말 것. eslint 8 은 같은 키의 규칙을
     병합하지 않고 '교체' 하므로, 넣는 순간 그 디렉터리에서 위의 Math.random 금지가
     조용히 사라진다 — 4a 전투의 시드 재현성이 거기 걸려 있다. */
module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  parserOptions: { ecmaVersion: 2022, sourceType: "module" },
  plugins: ["@typescript-eslint"],
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  env: { node: true, browser: true, es2022: true },
  ignorePatterns: ["node_modules/", "dist/", "*.cjs"],
  rules: {
    "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    "no-restricted-syntax": [
      "error",
      {
        // 엔진은 결정론이어야 한다. Date.now()/Math.random()은 주입받는다.
        selector: "MemberExpression[object.name='Math'][property.name='random']",
        message: "engine/은 결정론이어야 한다. 난수는 호출자가 주입한다.",
      },
    ],
  },
  overrides: [
    {
      // ── 규칙 1: engine/은 세계의 진실만 안다. 서술도, DB도, 소켓도 모른다.
      files: ["server/engine/**/*.ts"],
      rules: {
        "no-restricted-imports": ["error", { patterns: [
          { group: ["**/narration/**", "*/narration"], message: "규칙 1 위반: engine/ 이 server/narration/ 을 import 했다. 엔진이 진실, LLM은 묘사만 한다. (shared/narration 의 얼어붙은 계약 타입은 허용된다.)" },
          { group: ["**/db/**", "*/db"],                message: "engine/ 은 영속화를 모른다. 상태 변경은 반환값(effects)으로 내고, 기록은 호출자가 한다." },
          { group: ["**/net/**", "**/world/**"],        message: "engine/ 은 전송도 조합도 모른다." },
          { group: ["better-sqlite3", "ws"],            message: "engine/ 은 I/O 라이브러리를 import 하지 않는다." },
          { group: ["@anthropic-ai/*"],                 message: "규칙 1 위반: engine/ 이 LLM SDK 를 직접 부르면 모델 출력이 게임 상태를 바꾸는 경로가 생긴다. 모델 호출은 narration/ 에만 있다." },
          { group: ["node:fs", "node:fs/*", "fs", "**/content/**"], message: "engine/ 은 I/O 를 모른다. 밸런스 같은 데이터는 server/content/ 가 읽어서 '주입' 한다 — 난수·시계와 같은 방식이다." },
        ]}],
      },
    },
    {
      // ── 규칙 1의 반대 방향: narration/은 상태를 '바꿀 수 있는 핸들'을 애초에 못 잡는다.
      files: ["server/narration/**/*.ts"],
      rules: {
        "no-restricted-imports": ["error", { patterns: [
          { group: ["**/engine/**", "*/engine"], message: "narration/ 은 engine/ 을 import 하지 않는다. 얼어붙은 RoomTextRequest 만 받는다." },
          { group: ["**/db/**", "*/db"],         message: "규칙 1 위반: narration/ 이 DB 핸들을 잡으면 LLM 출력이 상태를 바꾸는 경로가 생긴다." },
          { group: ["**/net/**", "**/world/**"],  message: "narration/ 은 텍스트를 반환할 뿐 방출하지 않는다." },
          { group: ["better-sqlite3", "ws"],      message: "narration/ 은 DB/소켓 라이브러리를 import 하지 않는다." },
        ]}],
      },
    },
    {
      /* ── content/ 는 데이터를 읽어 engine/ 의 계약(Balance)으로 바꾸는 곳이다.
         읽기만 한다 — DB 도 소켓도 모른다. 그래야 "밸런스가 게임 상태를 만지는"
         경로가 생기지 않는다. */
      files: ["server/content/**/*.ts"],
      rules: {
        "no-restricted-imports": ["error", { patterns: [
          { group: ["**/db/**", "**/net/**", "**/world/**", "**/narration/**"], message: "content/ 는 데이터를 읽어 계약으로 바꾸기만 한다. 조합은 index.ts 가 한다." },
          { group: ["better-sqlite3", "ws", "@anthropic-ai/*"],                  message: "content/ 는 I/O 라이브러리를 import 하지 않는다 (파일 읽기만 한다)." },
        ]}],
      },
    },
    {
      /* ── 규칙 2: shared/ 는 클라이언트가 '런타임으로' import 하는 디렉터리다.
         여기로 SDK 나 서버 내부가 새면 API 키를 쓰는 코드가 브라우저 번들에
         들어간다. 그런데 lint·tsc·vite build 가 전부 초록인 채로 그렇게 된다 —
         그래서 이 경계는 특히 조용하고, 특히 기계로 막아야 한다.
         shared/ 는 계약(타입·검증기·상수)만 사는 곳이므로 양쪽 모두를 막는다. */
      files: ["shared/**/*.ts"],
      rules: {
        "no-restricted-imports": ["error", { patterns: [
          { group: ["@anthropic-ai/*"],                 message: "규칙 2 위반: shared/ 는 클라이언트가 import 한다. LLM SDK 가 여기 들어오면 브라우저 번들로 샌다. 모델 호출은 server/narration/ 에만 있다." },
          { group: ["**/server/**", "**/client/**"],     message: "shared/ 는 계약만 산다. 어느 쪽도 import 하지 않는다 — 양쪽이 shared/ 를 import 하는 방향뿐이다." },
          { group: ["better-sqlite3", "ws"],             message: "shared/ 는 I/O 라이브러리를 import 하지 않는다. 브라우저에서 돌 수 있어야 한다." },
        ]}],
      },
    },
    {
      // 클라이언트는 절대 LLM을 호출하지 않는다 (규칙 2). API 키는 서버에만 있다.
      files: ["client/**/*.ts", "client/**/*.tsx"],
      rules: {
        "no-restricted-imports": ["error", { patterns: [
          { group: ["@anthropic-ai/*", "**/server/**"], message: "규칙 2 위반: 클라이언트는 LLM을 호출하지 않고 서버 내부를 import 하지 않는다." },
        ]}],
      },
    },
  ],
};
