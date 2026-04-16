export async function runStartupMatrixMigration(params: {
  cfg: unknown;
  env?: NodeJS.ProcessEnv;
  log: { info?: (message: string) => void; warn?: (message: string) => void };
  trigger?: string;
  logPrefix?: string;
  deps?: unknown;
}): Promise<void> {
  void params;
}
