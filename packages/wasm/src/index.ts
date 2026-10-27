import init, { Pinger } from "../pkg/review_pinger_wasm.js";

export { Pinger };

let ready: Promise<unknown> | null = null;

/** Loads the WebAssembly once, then returns a `Pinger` restored from `saved`. */
export async function loadPinger(saved?: string | null): Promise<Pinger> {
  ready ??= init();
  await ready;
  return new Pinger(saved ?? undefined);
}
