export function applyNativeHooks(source: string): {
  source: string;
  evidence: {
    insertionOnly: boolean;
    hooks: { name: string; position: number; code: string }[];
    patchedSha256: string;
    physicsArithmeticChanged: boolean;
  };
};
