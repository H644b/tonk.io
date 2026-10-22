export function applyNativeSessionHooks(source: string): {
  source: string;
  evidence: {
    sourceSha256: string;
    patchedSha256: string;
    insertionOnly: boolean;
    nativePhysicsChanged: boolean;
    accountStateChanged: boolean;
    hooks: Array<{name: string; position: number; code: string; nativePath?: string; nativeCondition?: string; confirmedFrameLag?: number; finishCounter?: string}>;
    limitations: string[];
  };
};
