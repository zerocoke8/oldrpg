/* JSON 스칼라. world_flags 의 값 타입이자 narration 요청의 플래그 값 타입이다.
   narration.ts 가 아니라 여기 사는 이유: engine/ 이 이 타입을 필요로 하는데,
   engine/ 은 이름에 narration 이 들어간 파일을 import 해서는 안 된다.
   (린트 규칙이 그렇게 되어 있고, 그 규칙이 옳다.) */
export type JsonScalar = string | number | boolean | null;
