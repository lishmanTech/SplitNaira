export class ReadinessService {
  private dbConnected = true; // replace with real DB check

  check() {
    const ready = this.dbConnected;

    return {
      ready,
      services: {
        database: this.dbConnected,
      },
      timestamp: Date.now(),
    };
  }
}