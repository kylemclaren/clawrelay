// Wake Manager - Generic HTTP wake + health polling with coalescing

import type { RelayConfig } from './config.js';

type SandboxState = 'unknown' | 'awake' | 'waking';

export class WakeManager {
  private config: RelayConfig;
  private logger?: any;
  private state: SandboxState = 'unknown';
  private readyPromise: Promise<void> | null = null;

  constructor(config: RelayConfig, logger?: any) {
    this.config = config;
    this.logger = logger;
  }

  get sandboxState(): SandboxState {
    return this.state;
  }

  markUnknown() {
    this.state = 'unknown';
  }

  async ensureReady(): Promise<void> {
    // Fast path: check health first
    if (await this.checkHealth()) {
      this.state = 'awake';
      return;
    }

    // Coalesce concurrent calls
    if (this.readyPromise) {
      return this.readyPromise;
    }

    this.readyPromise = this.wakeAndPoll();

    try {
      await this.readyPromise;
    } finally {
      this.readyPromise = null;
    }
  }

  private async wakeAndPoll(): Promise<void> {
    this.state = 'waking';

    // Fire wake request if configured
    if (this.config.wake.enabled && this.config.wake.url) {
      this.logger?.info(`[relay] Waking sandbox: ${this.config.wake.url}`);
      try {
        const wakeHeaders: Record<string, string> = { ...(this.config.wake.headers ?? {}) };
        if (this.config.gateway.spriteToken) {
          wakeHeaders['Authorization'] = `Bearer ${this.config.gateway.spriteToken}`;
        }
        await fetch(this.config.wake.url, {
          method: this.config.wake.method ?? 'POST',
          headers: wakeHeaders,
          body: this.config.wake.body,
        });
      } catch (err) {
        this.logger?.warn(`[relay] Wake request failed (may still come up): ${err}`);
      }
    }

    // Poll health until ready
    const timeout = this.config.wake.timeoutMs ?? 120_000;
    const interval = this.config.wake.pollIntervalMs ?? 3_000;
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      if (await this.checkHealth()) {
        this.state = 'awake';
        this.logger?.info('[relay] Sandbox is ready');
        return;
      }
      await sleep(interval);
    }

    this.state = 'unknown';
    throw new Error(`Sandbox did not become ready within ${timeout / 1000}s`);
  }

  private async checkHealth(): Promise<boolean> {
    const url = `${this.config.gateway.url}${this.config.gateway.healthPath}`;
    try {
      const headers: Record<string, string> = {};
      if (this.config.gateway.spriteToken) {
        headers['Authorization'] = `Bearer ${this.config.gateway.spriteToken}`;
      }
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return false;
      const body = await res.json();
      return body.ready === true;
    } catch {
      return false;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
