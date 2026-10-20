import type { ThinkingLevel } from './types';

/** F07 durable user input facts. These rows are local and are not sync messages. */
export type InputMode = 'steer' | 'queue';
export type InputState = 'pending' | 'starting' | 'admitted' | 'delivered' | 'held' | 'cancelled';
export const INPUT_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
export const INPUTS_OPEN_MAX = 20;
/** Limit applies to the new durable inbox only; legacy chat.prompt is unchanged. */
export const INPUT_TEXT_MAX = 128 * 1024;

export interface InputPreferences {
  providerId?: string;
  modelGroupId?: string;
  thinkingLevel?: ThinkingLevel;
  maxOutputTokens?: number;
}
export interface InputSend extends InputPreferences {
  sessionId: string;
  messageId: string;
  mode: InputMode;
  text: string;
  attachments?: string[];
  /** Required for steer; stale run IDs are rejected before storing the row. */
  runId?: string;
}
export interface InputView {
  seq: number;
  /** Effective queue order; older engines omit it and clients fall back to seq. */
  position?: number;
  sessionId: string;
  messageId: string;
  mode: InputMode;
  text: string;
  attachments: string[];
  state: InputState;
  runId?: string;
  historyMessageId?: string;
  reason?: string;
  createdAt: number;
  updatedAt: number;
  deliveredAt?: number;
}
export interface InputList { sessionId: string; inputs: InputView[] }
export interface InputResult { input: InputView; duplicate: boolean }
export interface RunStopSummary {
  sessionId: string;
  runId: string;
  started: number;
  notStarted: number;
  unknown: number;
  /** Whether any started tool declared side effects or unknown effects. */
  possibleSideEffects: boolean;
}
