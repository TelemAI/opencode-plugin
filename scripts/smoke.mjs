// The public check: the bundle builds, imports, and still exposes the plugin factory.
// `npm run build` has already run by the time CI calls this.
import assert from "node:assert/strict"

const mod = await import("../dist/index.js")
assert.equal(typeof mod.TelemPlugin, "function", "dist/index.js must export the TelemPlugin factory")
console.log("ok: @telemai/opencode-plugin exports TelemPlugin")
