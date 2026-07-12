/**
 * init subcommand: discover fuzz tests, create seed directories, manage
 * .gitignore.
 */
import {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
} from "node:fs";
import path from "node:path";
import { getProjectRoot } from "../config.js";
import { discoverFuzzTests, buildTestManifest } from "./discover.js";

/**
 * init subcommand: discover fuzz tests, create seed directories, manage .gitignore.
 */
export async function runInitSubcommand(): Promise<void> {
  const discovered = await discoverFuzzTests();
  if (discovered === null) {
    process.exitCode = 1;
    return;
  }
  if (discovered.length === 0) {
    process.stdout.write("No fuzz tests (*.fuzz.*) found.\n");
    return;
  }

  const projectRoot = getProjectRoot();
  const tests = buildTestManifest(discovered);
  for (const t of tests) {
    mkdirSync(path.join(t.testDataDir, "seeds"), { recursive: true });
  }

  // Manage .gitignore
  const gitignorePath = path.join(projectRoot, ".gitignore");
  const gitignoreEntry = ".vitiate/corpus/";
  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, "utf-8");
    if (!content.split("\n").some((line) => line.trim() === gitignoreEntry)) {
      appendFileSync(gitignorePath, `\n${gitignoreEntry}\n`);
    }
  } else {
    writeFileSync(gitignorePath, `${gitignoreEntry}\n`);
  }

  // Print manifest
  process.stdout.write("\nDiscovered fuzz tests:\n\n");
  const fileWidth = Math.max(4, ...tests.map((t) => t.file.length));
  const nameWidth = Math.max(4, ...tests.map((t) => t.name.length));
  process.stdout.write(
    `${"File".padEnd(fileWidth)}  ${"Test".padEnd(nameWidth)}  Hash Directory\n`,
  );
  process.stdout.write(
    `${"-".repeat(fileWidth)}  ${"-".repeat(nameWidth)}  ${"-".repeat(32)}\n`,
  );
  for (const t of tests) {
    process.stdout.write(
      `${t.file.padEnd(fileWidth)}  ${t.name.padEnd(nameWidth)}  ${t.hashDir}\n`,
    );
  }
  process.stdout.write(
    `\n${tests.length} test(s) found. Seed directories created.\n`,
  );
}
