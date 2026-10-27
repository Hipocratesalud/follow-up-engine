/** A JSON primitive. */
export type JsonPrimitive = string | number | boolean | null;

/** Any JSON-serializable value. Used for payloads that cross a port boundary. */
export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;

/** A JSON object. */
export interface JsonObject {
  readonly [key: string]: JsonValue;
}
