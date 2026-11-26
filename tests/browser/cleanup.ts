import type { FullConfig } from "@playwright/test";
import { existsSync, rmdirSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

export default function cleanup(config: FullConfig) {
  const dir = resolve(config.metadata.localData);
  if (dirname(dir) !== resolve(tmpdir()) || !/^my-medic-browser-[a-f0-9-]{36}$/.test(basename(dir))) {
    throw new Error("Unexpected browser test data path");
  }
  if (existsSync(dir)) {
    for (const suffix of ["", "-journal", "-wal", "-shm"]) rmSync(join(dir, "cabinet.sqlite" + suffix), { force: true });
    rmdirSync(dir);
  }
}
