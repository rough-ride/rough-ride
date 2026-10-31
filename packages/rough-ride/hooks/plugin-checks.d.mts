// Types for plugin-checks.mjs, which is hand-written JavaScript.
export declare const CLAUDE_FLOOR: string;
export declare const NODE_FLOOR: string;
export declare const EDIT_GUARD_OFF: string;

export interface InstalledCopy {
  id: string;
  version: string;
  installPath: string;
}

export declare function compareSemver(a: string, b: string): number;
export declare function ownVersion(pluginRoot: string): string | null;
export declare function cacheCopy(p: string): { id: string; pluginsRoot: string; dataFolder: string } | null;
export declare function copyId(pluginRoot: string): string;
export declare function claudeCodeVersion(env: NodeJS.ProcessEnv): string | null;
export declare function floorStop(own: string, claudeVersion: string | null, tier: string): string | null;
export declare function floorMessage(pluginRoot: string, env: NodeJS.ProcessEnv): string | null;
export declare function packagesMessage(pluginRoot: string): string | null;
export declare function nodeMessage(versions: NodeJS.ProcessVersions, execPath: string): string | null;
export declare function runnerNodeMessage(versions: NodeJS.ProcessVersions, execPath: string): string | null;
export declare function installedCopies(pluginsRoot: string, cwd: string | null): InstalledCopy[] | null;
export declare function duplicateMessage(copies: InstalledCopy[] | null): string | null;
export declare function inlineMessage(pluginRoot: string, pluginsRoot: string, copies: InstalledCopy[] | null): string | null;
export declare function copyMessages(pluginRoot: string, pluginData: string | null, cwd: string | null): string[];
export declare function validSession(id: unknown): id is string;
export declare function sessionMarker(pluginData: string, sessionId: string): string;
export declare function pruneOld(dir: string, now: number): void;
