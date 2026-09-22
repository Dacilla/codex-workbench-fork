/**
 * Serializes backend-connect attempts so concurrent callers share one flight.
 *
 * Without this, the auto-connect at activation racing a New Chat command
 * produced a second connect while the first was in flight, which failed with
 * "already in progress" and left New Chat opening nothing.
 */
export class ConnectGate {
  private flight: Promise<boolean> | null = null;

  run(attempt: () => Promise<boolean>): Promise<boolean> {
    if (this.flight !== null) {
      return this.flight;
    }
    const flight = attempt();
    this.flight = flight;
    const clear = (): void => {
      if (this.flight === flight) {
        this.flight = null;
      }
    };
    flight.then(clear, clear);
    return flight;
  }
}
