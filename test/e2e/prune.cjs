#!/usr/bin/env node
/**
 * Remove Home Assistant containers this repository's harnesses left behind.
 *
 * Every worktree runs its own instance (see "Isolation between worktrees" in the README), and an
 * instance that outlives its worktree keeps running with a bind mount to a deleted directory,
 * logging errors and holding its port. This finds the containers the e2e and demo-video compose
 * files started (label `xvmc.harness`, or a legacy `xvmc-` name) and removes:
 *
 * - by default, only orphans: containers whose compose working directory no longer exists, so a
 *   suite another worktree is running right now is never touched;
 * - with `--all`, every one of them, live or not.
 *
 * Their compose networks go with them. `--dry-run` lists what would be removed.
 *
 * Usage:
 *   npm run e2e:prune
 *   npm run e2e:prune -- --all
 *   npm run e2e:prune -- --dry-run
 */
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

const flags = process.argv.slice(2);
const all = flags.includes("--all");
const dryRun = flags.includes("--dry-run");

function docker(args) {
    return execFileSync("docker", args, { encoding: "utf8" }).trim();
}

function lines(output) {
    return output ? output.split("\n").filter(Boolean) : [];
}

const FORMAT = [
    "{{.ID}}",
    "{{.Names}}",
    "{{.State}}",
    '{{.Label "com.docker.compose.project"}}',
    '{{.Label "com.docker.compose.project.working_dir"}}',
].join("\t");

const byId = new Map();
for (const filter of ["label=xvmc.harness", "name=^xvmc-"]) {
    for (const row of lines(docker(["ps", "-a", "--filter", filter, "--format", FORMAT]))) {
        const [id, name, state, project, workingDir] = row.split("\t");
        byId.set(id, { id, name, state, project, workingDir });
    }
}

const targets = [...byId.values()].filter(container => {
    if (all) return true;
    return !container.workingDir || !fs.existsSync(container.workingDir);
});

if (targets.length === 0) {
    console.log(all ? "No harness containers found." : "No orphaned harness containers found.");
    process.exit(0);
}

for (const container of targets) {
    const reason = !container.workingDir
        ? "no compose directory"
        : fs.existsSync(container.workingDir)
          ? "--all"
          : `worktree gone: ${container.workingDir}`;
    console.log(`${dryRun ? "would remove" : "removing"} ${container.name} (${container.state}, ${reason})`);
    if (!dryRun) docker(["rm", "-f", container.id]);
}

const projects = new Set(targets.map(container => container.project).filter(Boolean));
for (const project of projects) {
    for (const network of lines(
        docker(["network", "ls", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.Name}}"]),
    )) {
        console.log(`${dryRun ? "would remove" : "removing"} network ${network}`);
        if (dryRun) continue;
        try {
            docker(["network", "rm", network]);
        } catch (error) {
            console.error(`kept network ${network}: ${error.message.split("\n")[0]}`);
        }
    }
}
