// Types for path-check.mjs, which is hand-written JavaScript.
export declare function fold(segment: string): string;
export declare function isFolderName(segment: string): boolean;
export declare function canon(p: string, platform?: NodeJS.Platform): string;
export declare function printed(p: string, platform?: NodeJS.Platform): string;
export declare function samePath(a: string, b: string, platform?: NodeJS.Platform): boolean;
export declare function inside(child: string, parent: string, platform?: NodeJS.Platform): boolean;
export declare function couldBeInside(child: string, parent: string, platform?: NodeJS.Platform): boolean;
export declare function checkPath(
  input: unknown,
  cwd: string,
): { blocked: boolean; rest: string[]; error?: string };
