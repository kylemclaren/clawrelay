// DraftStream - Progressive message editing manager
//
// Sends an initial message then edits it with accumulated text at throttled
// intervals, matching native OpenClaw channel streaming behavior.
//
// Modeled after OpenClaw's draft-stream-loop pattern:
// - Smart throttle based on time since last send
// - Stops streaming when text exceeds platform max chars
// - Deduplicates edits when text hasn't changed
// - Splits only during finalization, not during streaming

import type { ChannelAdapter } from './adapter.js';
import { splitMessage } from './split-message.js';

export interface DraftStreamOptions {
  adapter: ChannelAdapter;
  channelId: string;
  replyToMessageId?: string;
  maxLength: number;
  throttleMs: number;
  logger?: any;
}

export class DraftStream {
  private adapter: ChannelAdapter;
  private channelId: string;
  private replyToMessageId?: string;
  private maxLength: number;
  private throttleMs: number;
  private logger: any;

  // Stream state
  private platformMessageId: string | null = null;
  private accumulated = '';
  private lastSentText = '';
  private stopped = false;

  // Throttle loop state (matches OpenClaw's draft-stream-loop pattern)
  private lastSentAt = 0;
  private inFlightPromise: Promise<void | boolean> | null = null;
  private throttleTimer: NodeJS.Timeout | null = null;

  constructor(opts: DraftStreamOptions) {
    this.adapter = opts.adapter;
    this.channelId = opts.channelId;
    this.replyToMessageId = opts.replyToMessageId;
    this.maxLength = opts.maxLength;
    this.throttleMs = Math.max(250, opts.throttleMs);
    this.logger = opts.logger ?? console;
  }

  /**
   * Update with the latest accumulated text. Replaces any pending text
   * (onPartialReply sends the full text each time, not incremental deltas).
   */
  push(text: string): void {
    if (this.stopped) return;
    this.accumulated = text;
    this.schedule();
  }

  /**
   * Finalize the stream with the complete response text.
   * Waits for any in-flight send, then delivers the final content
   * (splitting into multiple messages if needed).
   */
  async finalize(finalText: string): Promise<void> {
    // Cancel any scheduled flush
    this.clearTimer();

    // Wait for any in-flight send to complete so platformMessageId is set
    if (this.inFlightPromise) {
      await this.inFlightPromise;
    }

    if (!finalText.trim()) return;

    try {
      if (finalText.length > this.maxLength) {
        const chunks = splitMessage(finalText, this.maxLength);

        if (this.platformMessageId) {
          await this.adapter.editMessage(this.channelId, this.platformMessageId, chunks[0]);
        } else {
          await this.adapter.sendMessage(this.channelId, chunks[0], this.replyToMessageId);
        }

        for (let i = 1; i < chunks.length; i++) {
          await this.adapter.sendMessage(this.channelId, chunks[i]);
        }
      } else {
        if (this.platformMessageId) {
          await this.adapter.editMessage(this.channelId, this.platformMessageId, finalText);
        } else {
          await this.adapter.sendMessage(this.channelId, finalText, this.replyToMessageId);
        }
      }
    } catch (err) {
      this.logger.error(`[draft-stream] Finalize failed: ${err}`);
    }
  }

  /**
   * Clean up timers and mark as stopped.
   */
  dispose(): void {
    this.stopped = true;
    this.clearTimer();
  }

  // --- Throttle loop (modeled after OpenClaw's createDraftStreamLoop) ---

  private schedule(): void {
    if (this.throttleTimer) return;

    if (this.inFlightPromise) {
      // In-flight — the flush loop will pick up new text after the send completes
      return;
    }

    // Calculate dynamic delay based on time since last send
    const delay = Math.max(0, this.throttleMs - (Date.now() - this.lastSentAt));
    if (delay === 0) {
      void this.flush();
    } else {
      this.throttleTimer = setTimeout(() => {
        this.throttleTimer = null;
        void this.flush();
      }, delay);
    }
  }

  private async flush(): Promise<void> {
    this.clearTimer();

    while (!this.stopped) {
      if (this.inFlightPromise) {
        await this.inFlightPromise;
        continue;
      }

      const text = this.accumulated.trimEnd();
      if (!text) {
        this.accumulated = '';
        return;
      }

      // Dedup — skip if text hasn't changed since last send
      if (text === this.lastSentText) return;

      // Stop streaming if text exceeds platform limit (don't split mid-stream)
      if (text.length > this.maxLength) {
        this.stopped = true;
        this.logger.debug(
          `[draft-stream] Streaming stopped (text length ${text.length} > ${this.maxLength})`,
        );
        return;
      }

      const sent = this.sendOrEdit(text);
      this.inFlightPromise = sent;

      const ok = await sent;

      if (this.inFlightPromise === sent) {
        this.inFlightPromise = null;
      }

      if (!ok) return;

      this.lastSentAt = Date.now();
      this.lastSentText = text;

      // If no new text arrived during the send, we're done
      if (this.accumulated.trimEnd() === text) return;
    }
  }

  private async sendOrEdit(text: string): Promise<boolean> {
    try {
      if (this.platformMessageId) {
        await this.adapter.editMessage(this.channelId, this.platformMessageId, text);
      } else {
        this.platformMessageId = await this.adapter.sendMessage(
          this.channelId,
          text,
          this.replyToMessageId,
        );
      }
      return true;
    } catch (err) {
      this.stopped = true;
      this.logger.debug(`[draft-stream] Send/edit failed, stopping: ${err}`);
      return false;
    }
  }

  private clearTimer(): void {
    if (this.throttleTimer) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }
  }
}
