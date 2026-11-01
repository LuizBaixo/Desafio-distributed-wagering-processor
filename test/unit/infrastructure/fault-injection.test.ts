import { describe, expect, test } from "bun:test";
import { FaultInjection } from "../../../src/infrastructure/system/fault-injection";

function run(opts: { mode?: string; nodeEnv?: string }): number[] {
  const codes: number[] = [];
  const fi = new FaultInjection({
    ...opts,
    exit: ((code: number) => {
      codes.push(code);
    }) as (code: number) => never,
  });
  fi.afterCommit();
  return codes;
}

describe("FaultInjection.afterCommit", () => {
  test("exits with 137 when NODE_ENV=test and FAULT_INJECT=exit_after_commit", () => {
    expect(run({ mode: "exit_after_commit", nodeEnv: "test" })).toEqual([137]);
  });
  test("does nothing outside NODE_ENV=test, even with FAULT_INJECT set", () => {
    expect(run({ mode: "exit_after_commit", nodeEnv: "production" })).toEqual([]);
    expect(run({ mode: "exit_after_commit", nodeEnv: undefined })).toEqual([]);
  });
  test("does nothing without FAULT_INJECT", () => {
    expect(run({ mode: undefined, nodeEnv: "test" })).toEqual([]);
    expect(run({ mode: "something_else", nodeEnv: "test" })).toEqual([]);
  });
});
