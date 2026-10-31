// A small JSON Schema checker for the keywords that schemas/message/ uses, so that the tests need no validator package.
type Schema = Record<string, unknown> | boolean;

export function makeChecker(files: Record<string, Schema>) {
  function resolve(ref: string, base: string): [Schema, string] {
    const [file, pointer = ""] = ref.split("#");
    const name = file === "" || file === undefined ? base : file;
    let node: unknown = files[name];
    if (node === undefined) throw new Error(`unknown schema file ${name}`);
    for (const part of pointer.split("/").filter(Boolean)) node = (node as Record<string, unknown>)[part];
    if (node === undefined) throw new Error(`unknown ref ${ref}`);
    return [node as Schema, name];
  }

  function typeOf(v: unknown): string {
    if (v === null) return "null";
    if (Array.isArray(v)) return "array";
    if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
    return typeof v;
  }

  function check(s: Schema, v: unknown, base: string, at: string, errors: string[]): void {
    if (s === true) return;
    if (s === false) return void errors.push(`${at}: not allowed`);
    if (typeof s.$ref === "string") {
      const [target, file] = resolve(s.$ref, base);
      check(target, v, file, at, errors);
    }
    const t = typeOf(v);
    if (s.type !== undefined && !(s.type === t || (s.type === "number" && t === "integer"))) errors.push(`${at}: expected ${String(s.type)}`);
    if ("const" in s && JSON.stringify(s.const) !== JSON.stringify(v)) errors.push(`${at}: expected ${JSON.stringify(s.const)}`);
    if (Array.isArray(s.enum) && !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(v))) errors.push(`${at}: not in enum`);
    if (typeof v === "string") {
      if (typeof s.pattern === "string" && !new RegExp(s.pattern, "u").test(v)) errors.push(`${at}: does not match ${s.pattern}`);
      if (typeof s.minLength === "number" && [...v].length < s.minLength) errors.push(`${at}: too short`);
      if (typeof s.maxLength === "number" && [...v].length > s.maxLength) errors.push(`${at}: too long`);
    }
    if (typeof v === "number" && typeof s.minimum === "number" && v < s.minimum) errors.push(`${at}: below ${s.minimum}`);
    if (Array.isArray(v)) {
      if (typeof s.minItems === "number" && v.length < s.minItems) errors.push(`${at}: too few items`);
      if (s.items !== undefined) v.forEach((item, i) => check(s.items as Schema, item, base, `${at}/${i}`, errors));
    }
    if (t === "object") {
      const o = v as Record<string, unknown>;
      for (const key of (s.required as string[] | undefined) ?? []) if (!(key in o)) errors.push(`${at}: missing ${key}`);
      const props = (s.properties as Record<string, Schema> | undefined) ?? {};
      for (const [key, value] of Object.entries(o)) {
        if (key in props) check(props[key]!, value, base, `${at}/${key}`, errors);
        else if (s.additionalProperties === false) errors.push(`${at}: unknown field ${key}`);
      }
    }
    const passes = (sub: Schema) => {
      const e: string[] = [];
      check(sub, v, base, at, e);
      return e.length === 0;
    };
    for (const sub of (s.allOf as Schema[] | undefined) ?? []) check(sub, v, base, at, errors);
    if (Array.isArray(s.anyOf) && !s.anyOf.some(passes)) errors.push(`${at}: no anyOf branch matches`);
    if (s.not !== undefined && passes(s.not as Schema)) errors.push(`${at}: matches not`);
    if (s.if !== undefined) {
      const branch = passes(s.if as Schema) ? s.then : s.else;
      if (branch !== undefined) check(branch as Schema, v, base, at, errors);
    }
  }

  return (file: string, value: unknown): string[] => {
    const errors: string[] = [];
    check(resolve("#", file)[0], value, file, "", errors);
    return errors;
  };
}
