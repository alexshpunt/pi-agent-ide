import { isUnknownArray } from "#axi/types.ts";

/** Format a protocol value with the CLI's scalar coercion and array comma separator. */
export function valueText(value: unknown): string {
  if (isUnknownArray(value)) {
    return value
      .map((item) => (item === null || item === undefined ? "" : valueText(item)))
      .join(",");
  }
  if (value === null) return "null";
  switch (typeof value) {
    case "object": {
      const description: unknown = Object.prototype.toString.call(value);
      return typeof description === "string" ? description : "[object Object]";
    }
    case "function": {
      const description: unknown = Function.prototype.toString.call(value);
      return typeof description === "string" ? description : "";
    }
    case "string": {
      return value;
    }
    case "undefined": {
      return "undefined";
    }
    case "boolean":
    case "bigint":
    case "number":
    case "symbol": {
      return String(value);
    }
    default: {
      return "";
    }
  }
}
