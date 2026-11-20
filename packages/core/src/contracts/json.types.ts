export type JsonValue =
  null | boolean | number | string | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue;
}
