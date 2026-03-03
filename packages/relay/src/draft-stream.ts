// DraftStream - Progressive message editing manager
//
// Sends an initial message then edits it with accumulated text at throttled
// intervals, matching native OpenClaw channel streaming behavior. Handles
// message splitting when content exceeds platform limits.

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

  private platformMessageId: string | null = null;
  private accumulated = '';
  private throttleTimer: NodeJS.Timeout | null = null;
  private pendingFlush = false;
  private flushPromise: Promise<void> | null = null;
  private disposed = false;

  constructor(opts: DraftStreamOptions) {
    this.adapter = opts.adapter;
    this.channelId = opts.channelId;
    this.replyToMessageId = opts.replyToMessageId;
    this.maxLength = opts.maxLength;
    this.throttleMs = opts.throttleMs;
    this.logger = opts.logger ?? console;
  }

  /**
   * Append new text from a stream delta. Schedules a throttled flush.
   */
  push(text: string): void {
    if (this.disposed) return;

    if (this.accumulated) {
      this.accumulated += '\n' + text;
    } else {
      this.accumulated = text;
    }

    this.scheduleFlush();
  }

  /**
   * Flush accumulated text to the platform — send or edit the message.
   */
  private async flush(): Promise<void> {
    if (this.disposed || !this.accumulated) return;

    try {
      // If accumulated exceeds max length, finalize current message and start new
      if (this.accumulated.length > this.maxLength) {
        await this.handleOverflow();
        return;
      }

      if (!this.platformMessageId) {
        // First message — send it
        this.platformMessageId = await this.adapter.sendMessage(
          this.channelId,
          this.accumulated,
          this.replyToMessageId,
        );
      } else {
        // Edit existing message with updated content
        await this.adapter.editMessage(this.channelId, this.platformMessageId, this.accumulated);
      }
    } catch (err) {
      this.logger.debug(`[draft-stream] Flush failed: ${err}`);
    }
  }

  /**
   * Finalize the stream with the complete response text.
   * Waits for any in-flight flush, then sends the final edit.
   */
  async finalize(finalText: string): Promise<void> {
    if (this.disposed) return;
    this.cancelThrottle();

    // Wait for any in-flight flush to complete so platformMessageId is set
    if (this.flushPromise) {
      await this.flushPromise;
    }

    if (!finalText.trim()) {
      return;
    }

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
   * Clean up timers and mark as disposed.
   */
  dispose(): void {
    this.disposed = true;
    this.cancelThrottle();
  }

  private scheduleFlush(): void {
    if (this.flushPromise || this.throttleTimer) {
      // A flush is in-flight or already scheduled — just mark pending
      this.pendingFlush = true;
      return;
    }

    // Execute flush immediately if this is the first push (no message sent yet)
    if (!this.platformMessageId) {
      this.doFlush();
      return;
    }

    // Otherwise throttle
    this.throttleTimer = setTimeout(() => {
      this.throttleTimer = null;
      this.doFlush();
    }, this.throttleMs);
  }

  private doFlush(): void {
    this.pendingFlush = false;
    this.flushPromise = this.flush().then(() => {
      this.flushPromise = null;
      // If more text arrived during flush, schedule another
      if (this.pendingFlush && !this.disposed) {
        if (!this.platformMessageId) {
          this.doFlush();
        } else {
          this.throttleTimer = setTimeout(() => {
            this.throttleTimer = null;
            this.doFlush();
          }, this.throttleMs);
        }
      }
    });
  }

  private async handleOverflow(): Promise<void> {
    const chunks = splitMessage(this.accumulated, this.maxLength);

    if (this.platformMessageId) {
      await this.adapter.editMessage(this.channelId, this.platformMessageId, chunks[0]);
    } else {
      this.platformMessageId = await this.adapter.sendMessage(
        this.channelId,
        chunks[0],
        this.replyToMessageId,
      );
    }

    for (let i = 1; i < chunks.length; i++) {
      this.platformMessageId = await this.adapter.sendMessage(this.channelId, chunks[i]);
    }

    this.accumulated = chunks[chunks.length - 1];
  }

  private cancelThrottle(): void {
    if (this.throttleTimer) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }
    this.pendingFlush = false;
  }
}
