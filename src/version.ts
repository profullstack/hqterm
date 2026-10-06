import pkg from "../package.json" with { type: "json" };

/** From package.json, inlined by `bun build --compile`. */
export const VERSION: string = pkg.version;
