import { Errors } from './errors';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  failureThreshold: number;
  cooldownMs: number;
  now?: () => number;
  onStateChange?: (from: CircuitState, to: CircuitState) => void;
}

/**
 * Consecutive-failure circuit breaker.
 *
 * CLOSED: calls pass; `failureThreshold` consecutive counted failures open the circuit.
 * OPEN: calls fail fast with UPSTREAM_CIRCUIT_OPEN until `cooldownMs` has passed.
 * HALF_OPEN: exactly one trial call is let through; success closes, failure re-opens.
 *
 * Only failures for which `isFailure` returns true count. Auth and validation errors say nothing
 * about upstream health and must not trip the breaker.
 */
export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failures = 0;
  private openedAt = 0;
  private trialInFlight = false;
  private readonly now: () => number;

  constructor(private readonly opts: CircuitBreakerOptions) {
    this.now = opts.now ?? Date.now;
  }

  getState(): CircuitState {
    if (this.state === 'OPEN' && this.now() - this.openedAt >= this.opts.cooldownMs) {
      this.transition('HALF_OPEN');
    }
    return this.state;
  }

  async exec<T>(fn: () => Promise<T>, isFailure: (err: unknown) => boolean): Promise<T> {
    const state = this.getState();
    if (state === 'OPEN') {
      throw Errors.circuitOpen(Math.max(0, this.opts.cooldownMs - (this.now() - this.openedAt)));
    }
    if (state === 'HALF_OPEN') {
      if (this.trialInFlight) throw Errors.circuitOpen(this.opts.cooldownMs);
      this.trialInFlight = true;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      if (isFailure(err)) this.onFailure();
      else if (this.state === 'HALF_OPEN') this.onSuccess(); // upstream answered; it is reachable
      throw err;
    } finally {
      if (state === 'HALF_OPEN') this.trialInFlight = false;
    }
  }

  private onSuccess(): void {
    this.failures = 0;
    if (this.state !== 'CLOSED') this.transition('CLOSED');
  }

  private onFailure(): void {
    this.failures += 1;
    if (this.state === 'HALF_OPEN' || this.failures >= this.opts.failureThreshold) {
      this.openedAt = this.now();
      this.transition('OPEN');
    }
  }

  private transition(to: CircuitState): void {
    const from = this.state;
    if (from === to) return;
    this.state = to;
    this.opts.onStateChange?.(from, to);
  }
}
