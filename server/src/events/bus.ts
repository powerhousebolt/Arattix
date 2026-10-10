import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Logger } from '../logger';

export const EVENT_TYPES = [
  'message.received',
  'message.sent',
  'message.failed',
  'session.state_changed',
  'session.qr',
  'broadcast.completed',
  'webhook.test',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/**
 * Events carrying login material. A webhook only receives these when it subscribes to them
 * by name; the "*" wildcard never matches them.
 */
export const SENSITIVE_EVENTS: ReadonlySet<EventType> = new Set<EventType>(['session.qr']);

export interface ArattaiEvent<T = unknown> {
  id: string;
  type: EventType;
  sessionId: string;
  occurredAt: string;
  data: T;
}

export type EventListener = (event: ArattaiEvent) => void | Promise<void>;

/** In-process event bus. Listener failures are logged and never propagate to the publisher. */
export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor(
    private readonly sessionId: string,
    private readonly logger: Logger,
  ) {
    this.emitter.setMaxListeners(50);
  }

  publish<T>(type: EventType, data: T): ArattaiEvent<T> {
    const event: ArattaiEvent<T> = {
      id: `evt_${crypto.randomUUID().replace(/-/g, '')}`,
      type,
      sessionId: this.sessionId,
      occurredAt: new Date().toISOString(),
      data,
    };
    this.emitter.emit('event', event);
    return event;
  }

  subscribe(listener: EventListener): () => void {
    const wrapped = (event: ArattaiEvent) => {
      try {
        const result = listener(event);
        if (result instanceof Promise) {
          result.catch((err) => this.logger.error('Event listener failed', { component: 'event-bus', type: event.type, err }));
        }
      } catch (err) {
        this.logger.error('Event listener failed', { component: 'event-bus', type: event.type, err });
      }
    };
    this.emitter.on('event', wrapped);
    return () => this.emitter.off('event', wrapped);
  }
}
