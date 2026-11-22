import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export function findProjectRoot() {
  let dir = here;
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, "netlify.toml")) && existsSync(join(dir, "public"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(here, "../../..");
}

export const projectRoot = findProjectRoot();
export const knowledgeDir = join(projectRoot, "knowledge");
export const cacheDir = join(knowledgeDir, "cache");
export const communityGuidePath = join(knowledgeDir, "netlify-ai.md");
export const changelogPath = join(knowledgeDir, "changelog.json");
