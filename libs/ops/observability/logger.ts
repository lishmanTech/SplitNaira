export class OpsLogger {
  static info(msg: string, meta?: any) {
    console.log(`[OPS INFO] ${msg}`, meta || {});
  }

  static warn(msg: string, meta?: any) {
    console.warn(`[OPS WARN] ${msg}`, meta || {});
  }

  static error(msg: string, meta?: any) {
    console.error(`[OPS ERROR] ${msg}`, meta || {});
  }
}